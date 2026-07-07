#!/usr/bin/env node
// glimpse-ask.mjs — ask-form engine: validate a declarative decision spec and wrap
// it into a self-contained artifact with native, accessible form controls (radio
// groups, checkboxes, selects, text/textarea). The rendered page talks to the agent
// through the EXISTING `glimpseRespond()` channel — the same postMessage the canvas
// shell records into `window.__glimpse_responses` and `glimpse ask` polls over CDP.
//
// Imported by tests and invoked as a CLI by `bin/glimpse` (`glimpse ask … --form`).
// Node stdlib only. Mirrors lib/glimpse-explain.mjs's validate/wrap/exit-code
// contract. Ported from the former glimpse_ask.py (behavior-preserving).

import fs from "node:fs";
import { fileURLToPath } from "node:url";

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CHOICE_TYPES = new Set(["radio", "checkbox", "select"]);
const TEXT_TYPES = new Set(["text", "textarea"]);
const FIELD_TYPES = new Set([...CHOICE_TYPES, ...TEXT_TYPES]);

const SPEC_MAX_BYTES = 512 * 1024;
const MAX_FIELDS = 50;
const MAX_OPTIONS = 100;

export class SpecError extends Error {}

function isDict(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Python repr() for the handful of messages that embed a value.
function pyRepr(v) {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return "'" + v + "'";
  return String(v);
}

// Validate a parsed ask-form spec dict. Return true or throw SpecError(msg).
export function validate(spec) {
  if (!isDict(spec)) throw new SpecError("spec must be a JSON object");

  // prompt/intro are the visible framing; both optional (title comes from argv).
  for (const key of ["prompt", "intro", "submitLabel"]) {
    if (key in spec && spec[key] !== null && typeof spec[key] !== "string")
      throw new SpecError(`${key} must be a string`);
  }

  const fields = spec.fields;
  if (!Array.isArray(fields) || fields.length === 0)
    throw new SpecError("fields must be a non-empty list");
  if (fields.length > MAX_FIELDS)
    throw new SpecError(`too many fields (max ${MAX_FIELDS})`);

  const seen = new Set();
  for (let idx = 0; idx < fields.length; idx++) {
    const f = fields[idx];
    const where = `fields[${idx}]`;
    if (!isDict(f)) throw new SpecError(`${where} must be an object`);
    const ftype = f.type;
    if (!FIELD_TYPES.has(ftype))
      throw new SpecError(
        `${where}.type must be one of: ${[...FIELD_TYPES].sort().join(", ")}`,
      );
    const name = f.name;
    if (typeof name !== "string" || !NAME_RE.test(name))
      throw new SpecError(
        `${where}.name ${pyRepr(name)} must match [A-Za-z0-9_-]{1,64}`,
      );
    if (seen.has(name))
      throw new SpecError(`${where}: duplicate field name ${pyRepr(name)}`);
    seen.add(name);
    if ("label" in f && f.label !== null && typeof f.label !== "string")
      throw new SpecError(`${where}.label must be a string`);
    if ("help" in f && f.help !== null && typeof f.help !== "string")
      throw new SpecError(`${where}.help must be a string`);

    if (CHOICE_TYPES.has(ftype)) {
      validateOptions(f.options, where);
    } else {
      // text / textarea: options make no sense — flag the likely authoring slip.
      if (f.options !== null && f.options !== undefined)
        throw new SpecError(`${where}: options not allowed for a ${pyRepr(ftype)} field`);
    }
  }
  return true;
}

function validateOptions(options, where) {
  if (!Array.isArray(options) || options.length === 0)
    throw new SpecError(`${where}.options must be a non-empty list`);
  if (options.length > MAX_OPTIONS)
    throw new SpecError(`${where}.options: too many options (max ${MAX_OPTIONS})`);
  const seen = new Set();
  for (let oi = 0; oi < options.length; oi++) {
    const o = options[oi];
    const ow = `${where}.options[${oi}]`;
    if (!isDict(o)) throw new SpecError(`${ow} must be an object`);
    const val = o.value;
    if (typeof val !== "string" || val === "")
      throw new SpecError(`${ow}.value must be a non-empty string`);
    if (seen.has(val))
      throw new SpecError(`${ow}: duplicate option value ${pyRepr(val)}`);
    seen.add(val);
    if ("label" in o && o.label !== null && typeof o.label !== "string")
      throw new SpecError(`${ow}.label must be a string`);
  }
}

// HTML-escape for text and double-quoted attribute contexts.
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- static assets (no per-spec data reaches JS/CSS, so nothing to inject) -----

// Custom radios/checkboxes: the native input stays (real focusable control, real
// keyboard + a11y semantics) but `appearance:none` lets us draw a control that is
// unambiguously HOLLOW when unselected and FILLED when selected — in BOTH light
// and dark mode. This fixes the "native radios render as filled black dots in
// light mode" pitfall the input-playbook design review flagged.
const STYLE = `
:root{
  color-scheme: light dark;
  --bg:#f6f7fb; --card:#ffffff; --ink:#1c1e24; --dim:#5c6470; --line:#e4e6ef;
  --field:#fbfcfe; --accent:#3b5bdb; --accent-ink:#ffffff; --good:#2f9e44;
  --ctl-border:#aab2c2; --ctl-bg:#ffffff; --focus:#3b5bdb;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#14161c; --card:#1c1f27; --ink:#e8eaf0; --dim:#9aa3b2; --line:#2c313c;
    --field:#232732; --accent:#6b8afd; --accent-ink:#0c1020; --good:#5bd97a;
    --ctl-border:#5a6474; --ctl-bg:#1c1f27; --focus:#6b8afd;
  }
}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
.wrap{max-width:660px;margin:0 auto;padding:40px 24px;}
h1{font-size:24px;margin:0 0 6px;letter-spacing:-.4px;}
.intro{color:var(--dim);margin:0 0 20px;}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
  padding:20px 22px;margin:16px 0;box-shadow:0 1px 2px rgba(20,20,40,.04);}
fieldset{border:0;margin:0 0 18px;padding:0;}
fieldset:last-of-type{margin-bottom:6px;}
legend{padding:0;font-weight:650;font-size:15px;margin-bottom:8px;}
.help{color:var(--dim);font-size:13px;margin:-4px 0 10px;}
label.opt{display:flex;gap:11px;align-items:center;padding:11px 13px;
  border:1px solid var(--line);border-radius:10px;margin:7px 0;cursor:pointer;
  background:var(--field);transition:border-color .12s,background .12s;}
label.opt:hover{border-color:var(--accent);}
label.opt:has(:checked){border-color:var(--accent);
  background:color-mix(in srgb, var(--accent) 10%, var(--field));}
.opt-text{flex:1;min-width:0;}
input[type=radio],input[type=checkbox]{
  appearance:none;-webkit-appearance:none;margin:0;flex:0 0 auto;
  width:20px;height:20px;border:2px solid var(--ctl-border);background:var(--ctl-bg);
  display:inline-grid;place-content:center;cursor:pointer;
  transition:border-color .12s,background .12s;}
input[type=radio]{border-radius:50%;}
input[type=checkbox]{border-radius:6px;}
input[type=radio]::after{content:"";width:10px;height:10px;border-radius:50%;
  background:var(--accent-ink);transform:scale(0);transition:transform .12s;}
input[type=checkbox]::after{content:"";width:5px;height:10px;margin-top:-2px;
  border:solid var(--accent-ink);border-width:0 2.5px 2.5px 0;
  transform:rotate(45deg) scale(0);transition:transform .12s;}
input[type=radio]:checked,input[type=checkbox]:checked{
  border-color:var(--accent);background:var(--accent);}
input[type=radio]:checked::after{transform:scale(1);}
input[type=checkbox]:checked::after{transform:rotate(45deg) scale(1);}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible{
  outline:2px solid var(--focus);outline-offset:2px;}
input[type=text],textarea,select{width:100%;font:inherit;color:var(--ink);
  padding:10px 12px;border:1px solid var(--ctl-border);border-radius:10px;
  background:var(--field);}
textarea{min-height:88px;resize:vertical;}
.err{color:#e03131;font-size:13px;margin-top:6px;display:none;}
.err.show{display:block;}
@media (prefers-color-scheme: dark){.err{color:#ff8787;}}
.actions{display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap;}
button.submit{font:inherit;font-weight:650;border-radius:10px;padding:11px 20px;
  border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);
  cursor:pointer;}
button.submit:hover{filter:brightness(1.05);}
button.submit:disabled{opacity:.55;cursor:default;filter:none;}
.sent{display:none;color:var(--good);font-weight:600;}
.sent.show{display:inline;}
.hint{color:var(--dim);font-size:12.5px;margin-top:14px;}
code{background:color-mix(in srgb, var(--accent) 12%, transparent);
  padding:2px 6px;border-radius:5px;font-size:13px;}
`;

// DOM-only collector: no field metadata is embedded in JS (keeps the script an
// injection-free constant). It reads live control state — checkbox groups become
// arrays, radio/select/text become their value (radio null when none picked) —
// and posts the structured object through glimpseRespond().
//
// CRITICAL: the canvas hosts artifacts in `sandbox="allow-scripts"` — NO
// `allow-forms` — so NATIVE <form> submission (and thus the form's `submit`
// event) is blocked by the sandbox. We therefore drive off the submit BUTTON's
// `click` (type="button", never a real submit) and validate manually:
// `reportValidity()` covers native `required` (radio / select / text / textarea)
// and shows the browser's own bubbles; `data-min` on a fieldset covers "pick at
// least N" for checkbox groups, which native `required` can't express.
const SCRIPT = `
function glimpseRespond(value){
  parent.postMessage({ type: "glimpse:response", value: value }, "*");
}
function glimpseCollect(form){
  var out = {};
  Array.prototype.forEach.call(form.elements, function(el){
    if(!el.name || el.disabled) return;
    if(el.type === "checkbox"){
      if(!(el.name in out)) out[el.name] = [];
      if(el.checked) out[el.name].push(el.value);
    } else if(el.type === "radio"){
      if(!(el.name in out)) out[el.name] = null;
      if(el.checked) out[el.name] = el.value;
    } else if(el.tagName === "SELECT" || el.type === "text" || el.tagName === "TEXTAREA"){
      out[el.name] = el.value;
    }
  });
  return out;
}
function glimpseSubmit(form){
  // Native required for radio / select / text / textarea (works in-sandbox; it
  // does not submit, so allow-forms is not needed).
  if(typeof form.reportValidity === "function" && !form.reportValidity()) return;
  // Custom "pick at least N" for checkbox groups.
  var groups = form.querySelectorAll("fieldset[data-min]");
  for(var i=0;i<groups.length;i++){
    var fs = groups[i], min = parseInt(fs.getAttribute("data-min"),10) || 0;
    var picked = fs.querySelectorAll("input[type=checkbox]:checked").length;
    var err = fs.querySelector(".err");
    if(picked < min){
      if(err) err.classList.add("show");
      var first = fs.querySelector("input[type=checkbox]");
      if(first) first.focus();
      return;
    }
    if(err) err.classList.remove("show");
  }
  glimpseRespond(glimpseCollect(form));
  Array.prototype.forEach.call(form.elements, function(el){ el.disabled = true; });
  var s = document.getElementById("glimpse-sent"); if(s) s.classList.add("show");
  var b = document.getElementById("glimpse-submit"); if(b) b.textContent = "Sent";
}
document.addEventListener("DOMContentLoaded", function(){
  var form = document.getElementById("glimpse-ask");
  var btn = document.getElementById("glimpse-submit");
  if(!form || !btn) return;
  btn.addEventListener("click", function(){ glimpseSubmit(form); });
  // Enter inside a single-line text/number field acts like pressing submit.
  form.addEventListener("keydown", function(ev){
    if(ev.key === "Enter" && ev.target && ev.target.tagName === "INPUT" && ev.target.type !== "textarea"){
      ev.preventDefault(); glimpseSubmit(form);
    }
  });
});
`;

function renderOption(fieldType, name, opt) {
  const val = esc(opt.value);
  const label = esc("label" in opt ? opt.label : opt.value);
  const checked = opt.selected ? " checked" : "";
  const itype = fieldType === "checkbox" ? "checkbox" : "radio";
  return (
    `<label class="opt"><input type="${itype}" name="${name}" value="${val}"${checked}>` +
    `<span class="opt-text">${label}</span></label>`
  );
}

function renderField(f) {
  const ftype = f.type;
  const name = esc(f.name);
  const label = esc("label" in f && f.label !== undefined ? f.label : f.name);
  const required = Boolean(f.required);
  const parts = ["<fieldset"];
  // A required checkbox group needs the custom "min 1" check (see SCRIPT).
  if (ftype === "checkbox" && required) parts.push(' data-min="1"');
  parts.push(">");
  parts.push(`<legend>${label}${required ? " *" : ""}</legend>`);
  if (f.help) parts.push(`<p class="help">${esc(f.help)}</p>`);

  if (ftype === "radio" || ftype === "checkbox") {
    for (const o of f.options) {
      // `required` on each radio input makes the browser enforce one choice
      // natively; checkboxes use the data-min path instead.
      let html = renderOption(ftype, name, o);
      if (ftype === "radio" && required)
        html = html.replace("<input ", "<input required ");
      parts.push(html);
    }
    if (ftype === "checkbox" && required)
      parts.push('<p class="err">Please select at least one option.</p>');
  } else if (ftype === "select") {
    parts.push(`<select name="${name}"${required ? " required" : ""}>`);
    // A required select needs an unselectable placeholder so "nothing chosen"
    // is a real, invalid state the browser catches.
    if (required)
      parts.push('<option value="" disabled selected>Choose…</option>');
    for (const o of f.options) {
      const sel = o.selected && !required ? " selected" : "";
      parts.push(
        `<option value="${esc(o.value)}"${sel}>${esc("label" in o ? o.label : o.value)}</option>`,
      );
    }
    parts.push("</select>");
  } else if (ftype === "textarea") {
    parts.push(
      `<textarea name="${name}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ""}${required ? " required" : ""}></textarea>`,
    );
  } else {
    // text
    parts.push(
      `<input type="text" name="${name}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ""}${required ? " required" : ""}>`,
    );
  }
  parts.push("</fieldset>");
  return parts.join("");
}

// Return self-contained artifact HTML for the ask-form spec.
export function wrapArtifact(spec, title) {
  const prompt = spec.prompt || title;
  const submitLabel = spec.submitLabel || "Submit";
  const body = [`<div class="wrap"><h1>${esc(prompt)}</h1>`];
  if (spec.intro) body.push(`<p class="intro">${esc(spec.intro)}</p>`);
  // No `novalidate`: we call reportValidity() manually (native submission is
  // sandbox-blocked). The button is type="button" so a click never attempts a
  // blocked form submission — glimpseSubmit() drives everything.
  body.push('<form id="glimpse-ask" class="card">');
  for (const f of spec.fields) body.push(renderField(f));
  body.push(
    '<div class="actions">' +
      `<button type="button" id="glimpse-submit" class="submit">${esc(submitLabel)}</button>` +
      '<span class="sent" id="glimpse-sent">✓ Sent to the agent — you can close this.</span>' +
      "</div>",
  );
  body.push(
    '<p class="hint">This page is sandboxed; it returns your choice to the ' +
      "agent only through <code>glimpseRespond()</code>.</p>",
  );
  body.push("</form></div>");
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark">' +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>` +
    body.join("") +
    `<script>${SCRIPT}</script>` +
    "</body></html>"
  );
}

function main(argv) {
  // Exit-code contract (matches glimpse-explain.mjs): 2 = spec-content error
  // (invalid JSON, oversized, or SpecError); the bash verb reserves 1 for its
  // own usage/infra failures.
  if (!argv.length) {
    process.stderr.write("usage: glimpse-ask.mjs validate|wrap <title>\n");
    return 2;
  }
  const cmd = argv[0];
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch (e) {
    process.stderr.write(`glimpse ask: spec is not valid JSON: ${e.message}\n`);
    return 2;
  }
  const raw = JSON.stringify(spec);
  if (Buffer.byteLength(raw, "utf8") > SPEC_MAX_BYTES) {
    process.stderr.write(`glimpse ask: spec exceeds ${SPEC_MAX_BYTES} bytes\n`);
    return 2;
  }
  try {
    validate(spec);
  } catch (e) {
    if (e instanceof SpecError) {
      process.stderr.write(`glimpse ask: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  if (cmd === "validate") return 0;
  if (cmd === "wrap") {
    const title = argv.length > 1 ? argv[1] : spec.prompt || "Decision";
    process.stdout.write(wrapArtifact(spec, title));
    return 0;
  }
  process.stderr.write(`glimpse ask: unknown subcommand ${pyRepr(cmd)}\n`);
  return 2;
}

const isMain = (() => {
  try {
    return (
      process.argv[1] &&
      fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
})();

if (isMain) process.exit(main(process.argv.slice(2)));
