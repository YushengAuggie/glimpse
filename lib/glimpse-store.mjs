// glimpse-store.mjs — shared file-store helpers for the Node ops (feed + threads).
//
// The Python ops used fcntl.flock(LOCK_EX) on a `<file>.lock` sidecar to serialize
// the read-modify-write of feed.json / threads/<slug>.json so concurrent publishes
// or replies can't drop each other's write, and the static server never serves a
// half-written file. Node's stdlib has no flock, so we get the same cross-process
// exclusion with an O_EXCL lock file (open with 'wx' fails if it exists) plus a
// spin-retry, and stale-lock takeover keyed on the recorded pid — mirroring the
// stale-pid detection bin/glimpse already uses for the bridge/poll locks.
//
// Node stdlib only.

import fs from "node:fs";

function _pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not signalable by us → alive
  }
}

// Block the current (short-lived CLI) process for `ms` without a busy loop.
function _sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Run `fn` while holding an exclusive lock on `lockPath`. The lock is the file's
// existence; we create it atomically, write our pid for stale detection, and
// remove it on release (success or throw). A lock whose owner is dead — or that
// has lingered past `staleMs` — is taken over, so a crashed writer can't wedge
// the store forever.
export function withLock(lockPath, fn, opts = {}) {
  const delayMs = opts.delayMs ?? 5;
  const staleMs = opts.staleMs ?? 15000;
  const maxWaitMs = opts.maxWaitMs ?? 30000;
  const start = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let stale = false;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) stale = true;
        else {
          const pid = parseInt(
            (fs.readFileSync(lockPath, "utf8") || "").trim(),
            10,
          );
          if (!_pidAlive(pid)) stale = true;
        }
      } catch {
        // lock vanished between open and stat — just retry
      }
      if (stale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* another waiter got it; retry */
        }
        continue;
      }
      if (Date.now() - start > maxWaitMs)
        throw new Error("glimpse: timed out acquiring lock " + lockPath);
      _sleep(delayMs);
    }
  }
  try {
    try {
      fs.writeSync(fd, String(process.pid));
    } catch {
      /* pid write is only a hint for stale detection */
    }
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

// Parse JSON at `path`, returning `fallback` on any read/parse error (matches the
// Python ops' broad try/except default).
export function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// Write `obj` as indent-2 JSON atomically (tmp + rename), so a concurrent reader
// never observes a partial file. Optionally chmod the result (threads use 0o600).
export function writeJsonAtomic(path, obj, { mode } = {}) {
  const tmp = path + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, path);
  if (mode !== undefined) {
    try {
      fs.chmodSync(path, mode);
    } catch {
      /* best-effort, as in Python */
    }
  }
}
