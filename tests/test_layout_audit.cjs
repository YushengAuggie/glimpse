// Unit tests for the pure scoring helpers in canvas/glimpse-audit.js.
// The module is an IIFE that only runs its browser entry when `window` exists;
// under Node it just exports the pure helpers, so requiring it is side-effect free.
const test = require("node:test");
const assert = require("node:assert");
const A = require("../canvas/glimpse-audit.js");

test("severityFor: error above the px threshold, warning at/under it", () => {
  assert.equal(A.severityFor(A.ERROR_OVERFLOW_PX + 1), "error");
  assert.equal(A.severityFor(A.ERROR_OVERFLOW_PX), "warning");
  assert.equal(A.severityFor(0), "warning");
});

test("pageOverflowFinding: flags real horizontal overflow, ignores sub-threshold", () => {
  const f = A.pageOverflowFinding(1100, 1000);
  assert.equal(f.kind, "page-horizontal-overflow");
  assert.equal(f.selector, "html");
  assert.equal(f.overflowPx, 100);
  assert.equal(f.severity, "error");
  assert.equal(A.pageOverflowFinding(1002, 1000), null);   // 2px ≤ threshold
});

test("elementOverflowFinding: clipped text (overflow:hidden) is always an error", () => {
  const f = A.elementOverflowFinding({ selector: "div", scrollWidth: 826, clientWidth: 256, scrollHeight: 20, clientHeight: 20, overflowX: "hidden", overflowY: "visible" });
  assert.equal(f.kind, "clipped-text");
  assert.equal(f.overflowPx, 570);
  assert.equal(f.severity, "error");
});

test("elementOverflowFinding: vertical clip via overflow-y:clip is an error", () => {
  const f = A.elementOverflowFinding({ selector: "p", scrollWidth: 100, clientWidth: 100, scrollHeight: 500, clientHeight: 100, overflowX: "visible", overflowY: "clip" });
  assert.equal(f.kind, "clipped-text");
  assert.equal(f.overflowPx, 400);
});

test("elementOverflowFinding: visible content spill is an element-overflow", () => {
  const f = A.elementOverflowFinding({ selector: "div", scrollWidth: 1200, clientWidth: 1000, scrollHeight: 50, clientHeight: 50, overflowX: "visible", overflowY: "visible" });
  assert.equal(f.kind, "element-overflow");
  assert.equal(f.severity, "error");   // 200px > threshold
});

test("elementOverflowFinding: intentional scrollers and clean boxes are not flagged", () => {
  assert.equal(A.elementOverflowFinding({ selector: "div", scrollWidth: 1200, clientWidth: 1000, scrollHeight: 50, clientHeight: 50, overflowX: "auto", overflowY: "visible" }), null);
  assert.equal(A.elementOverflowFinding({ selector: "div", scrollWidth: 1200, clientWidth: 1000, scrollHeight: 50, clientHeight: 50, overflowX: "scroll", overflowY: "visible" }), null);
  assert.equal(A.elementOverflowFinding({ selector: "div", scrollWidth: 100, clientWidth: 100, scrollHeight: 50, clientHeight: 50, overflowX: "visible", overflowY: "visible" }), null);
});

test("intersectionArea: overlap area, zero when disjoint", () => {
  const a = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
  const b = { left: 50, top: 50, right: 150, bottom: 150, width: 100, height: 100 };
  assert.equal(A.intersectionArea(a, b), 2500);   // 50x50
  const c = { left: 200, top: 200, right: 300, bottom: 300, width: 100, height: 100 };
  assert.equal(A.intersectionArea(a, c), 0);
});

test("overlapFinding: substantial overlap flagged, incidental touch ignored", () => {
  const a = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
  const big = { left: 10, top: 10, right: 110, bottom: 110, width: 100, height: 100 };
  assert.ok(A.overlapFinding(a, big, "x", "y"));
  const touch = { left: 98, top: 98, right: 198, bottom: 198, width: 100, height: 100 };  // ~4px² overlap
  assert.equal(A.overlapFinding(a, touch, "x", "y"), null);
});

test("parseColor: rgb/rgba/hex, and rejects keywords/garbage", () => {
  assert.deepEqual(A.parseColor("rgb(15, 17, 23)"), { r: 15, g: 17, b: 23, a: 1 });
  assert.deepEqual(A.parseColor("rgba(255, 255, 255, 0.4)"), { r: 255, g: 255, b: 255, a: 0.4 });
  assert.deepEqual(A.parseColor("#0f1117"), { r: 15, g: 17, b: 23, a: 1 });
  assert.deepEqual(A.parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(A.parseColor("transparent"), null);
  assert.equal(A.parseColor("none"), null);
  assert.equal(A.parseColor(""), null);
});

test("contrastRatio: black-on-white ≈ 21, white-on-white ≈ 1", () => {
  const white = { r: 255, g: 255, b: 255, a: 1 }, black = { r: 0, g: 0, b: 0, a: 1 };
  assert.ok(A.contrastRatio(black, white) > 20.9);
  assert.ok(Math.abs(A.contrastRatio(white, white) - 1) < 0.001);
});

test("contrastFinding: the real bug (dark-on-dark mermaid label) is an error", () => {
  // Dark slate signal text bleeding onto a dark code-bg box (ratio ≈ 1.16).
  const f = A.contrastFinding({ selector: "svg text.messageText", color: "rgb(30,34,48)", bg: "rgb(15,20,32)" });
  assert.equal(f.kind, "invisible-text");
  assert.equal(f.severity, "error");
  assert.ok(f.ratio < A.INVISIBLE_RATIO);
});

test("contrastFinding: readable → null; low-contrast band → warning not error", () => {
  // black on white → readable → no finding.
  assert.equal(A.contrastFinding({ selector: "p", color: "rgb(0,0,0)", bg: "rgb(255,255,255)" }), null);
  // dim gray on near-black is still readable (≈ 6:1) → no finding.
  assert.equal(A.contrastFinding({ selector: "p", color: "rgb(138,147,166)", bg: "rgb(15,17,23)" }), null);
  // ratio ≈ 1.88 lands in [1.5, 2.0) → warning, not error.
  const w = A.contrastFinding({ selector: "p", color: "rgb(60,66,96)", bg: "rgb(15,20,32)" });
  assert.equal(w.severity, "warning");
  assert.ok(w.ratio >= A.INVISIBLE_RATIO && w.ratio < A.LOW_CONTRAST_RATIO);
});

test("contrastFinding: unparseable color yields no finding (never crashes)", () => {
  assert.equal(A.contrastFinding({ selector: "p", color: "none", bg: "rgb(255,255,255)" }), null);
});
