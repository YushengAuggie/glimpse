#!/usr/bin/env python3
"""Glimpse ask-form engine: validate a declarative decision spec and wrap it into
a self-contained artifact with native, accessible form controls (radio groups,
checkboxes, selects, text/textarea). The rendered page talks to the agent through
the EXISTING `glimpseRespond()` channel — the same postMessage the canvas shell
records into `window.__glimpse_responses` and `glimpse ask` polls over CDP.

Imported by tests and invoked as a CLI by `bin/glimpse` (`glimpse ask … --form`).
Stdlib only. Mirrors lib/glimpse_explain.py's validate/wrap/exit-code contract.
"""

import json
import re
import sys

NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CHOICE_TYPES = {"radio", "checkbox", "select"}
TEXT_TYPES = {"text", "textarea"}
FIELD_TYPES = CHOICE_TYPES | TEXT_TYPES

SPEC_MAX_BYTES = 512 * 1024
MAX_FIELDS = 50
MAX_OPTIONS = 100


class SpecError(ValueError):
    """Raised on the first validation problem, with a human-readable message."""


def validate(spec):
    """Validate a parsed ask-form spec dict. Return True or raise SpecError(msg)."""
    if not isinstance(spec, dict):
        raise SpecError("spec must be a JSON object")

    # prompt/intro are the visible framing; both optional (title comes from argv).
    for key in ("prompt", "intro", "submitLabel"):
        if key in spec and spec[key] is not None and not isinstance(spec[key], str):
            raise SpecError("%s must be a string" % key)

    fields = spec.get("fields")
    if not isinstance(fields, list) or not fields:
        raise SpecError("fields must be a non-empty list")
    if len(fields) > MAX_FIELDS:
        raise SpecError("too many fields (max %d)" % MAX_FIELDS)

    seen = set()
    for idx, f in enumerate(fields):
        where = "fields[%d]" % idx
        if not isinstance(f, dict):
            raise SpecError("%s must be an object" % where)
        ftype = f.get("type")
        if ftype not in FIELD_TYPES:
            raise SpecError(
                "%s.type must be one of: %s" % (where, ", ".join(sorted(FIELD_TYPES)))
            )
        name = f.get("name")
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise SpecError("%s.name %r must match [A-Za-z0-9_-]{1,64}" % (where, name))
        if name in seen:
            raise SpecError("%s: duplicate field name %r" % (where, name))
        seen.add(name)
        if "label" in f and f["label"] is not None and not isinstance(f["label"], str):
            raise SpecError("%s.label must be a string" % where)
        if "help" in f and f["help"] is not None and not isinstance(f["help"], str):
            raise SpecError("%s.help must be a string" % where)

        if ftype in CHOICE_TYPES:
            _validate_options(f.get("options"), where)
        else:
            # text / textarea: options make no sense — flag the likely authoring slip.
            if f.get("options") is not None:
                raise SpecError(
                    "%s: options not allowed for a %r field" % (where, ftype)
                )
    return True


def _validate_options(options, where):
    if not isinstance(options, list) or not options:
        raise SpecError("%s.options must be a non-empty list" % where)
    if len(options) > MAX_OPTIONS:
        raise SpecError("%s.options: too many options (max %d)" % (where, MAX_OPTIONS))
    seen = set()
    for oi, o in enumerate(options):
        ow = "%s.options[%d]" % (where, oi)
        if not isinstance(o, dict):
            raise SpecError("%s must be an object" % ow)
        val = o.get("value")
        if not isinstance(val, str) or val == "":
            raise SpecError("%s.value must be a non-empty string" % ow)
        if val in seen:
            raise SpecError("%s: duplicate option value %r" % (ow, val))
        seen.add(val)
        if "label" in o and o["label"] is not None and not isinstance(o["label"], str):
            raise SpecError("%s.label must be a string" % ow)


def _esc(s):
    """HTML-escape for text and double-quoted attribute contexts."""
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


# --- static assets (no per-spec data reaches JS/CSS, so nothing to inject) -----

# Custom radios/checkboxes: the native input stays (real focusable control, real
# keyboard + a11y semantics) but `appearance:none` lets us draw a control that is
# unambiguously HOLLOW when unselected and FILLED when selected — in BOTH light
# and dark mode. This fixes the "native radios render as filled black dots in
# light mode" pitfall the input-playbook design review flagged.
_STYLE = """
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
"""

# DOM-only collector: no field metadata is embedded in JS (keeps the script an
# injection-free constant). It reads live control state — checkbox groups become
# arrays, radio/select/text become their value (radio null when none picked) —
# and posts the structured object through glimpseRespond().
#
# CRITICAL: the canvas hosts artifacts in `sandbox="allow-scripts"` — NO
# `allow-forms` — so NATIVE <form> submission (and thus the form's `submit`
# event) is blocked by the sandbox. We therefore drive off the submit BUTTON's
# `click` (type="button", never a real submit) and validate manually:
# `reportValidity()` covers native `required` (radio / select / text / textarea)
# and shows the browser's own bubbles; `data-min` on a fieldset covers "pick at
# least N" for checkbox groups, which native `required` can't express.
_SCRIPT = """
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
"""


def _render_option(field_type, name, opt):
    val = _esc(opt.get("value"))
    label = _esc(opt.get("label", opt.get("value")))
    checked = " checked" if opt.get("selected") else ""
    itype = "checkbox" if field_type == "checkbox" else "radio"
    return (
        '<label class="opt"><input type="%s" name="%s" value="%s"%s>'
        '<span class="opt-text">%s</span></label>'
    ) % (itype, name, val, checked, label)


def _render_field(f):
    ftype = f["type"]
    name = _esc(f["name"])
    label = _esc(f.get("label", f["name"]))
    required = bool(f.get("required"))
    parts = ["<fieldset"]
    # A required checkbox group needs the custom "min 1" check (see _SCRIPT).
    if ftype == "checkbox" and required:
        parts.append(' data-min="1"')
    parts.append(">")
    parts.append("<legend>%s%s</legend>" % (label, " *" if required else ""))
    if f.get("help"):
        parts.append('<p class="help">%s</p>' % _esc(f["help"]))

    if ftype in ("radio", "checkbox"):
        for o in f["options"]:
            # `required` on each radio input makes the browser enforce one choice
            # natively; checkboxes use the data-min path instead.
            html = _render_option(ftype, name, o)
            if ftype == "radio" and required:
                html = html.replace("<input ", "<input required ", 1)
            parts.append(html)
        if ftype == "checkbox" and required:
            parts.append('<p class="err">Please select at least one option.</p>')
    elif ftype == "select":
        parts.append('<select name="%s"%s>' % (name, " required" if required else ""))
        # A required select needs an unselectable placeholder so "nothing chosen"
        # is a real, invalid state the browser catches.
        if required:
            parts.append('<option value="" disabled selected>Choose…</option>')
        for o in f["options"]:
            sel = " selected" if o.get("selected") and not required else ""
            parts.append(
                '<option value="%s"%s>%s</option>'
                % (_esc(o.get("value")), sel, _esc(o.get("label", o.get("value"))))
            )
        parts.append("</select>")
    elif ftype == "textarea":
        parts.append(
            '<textarea name="%s"%s%s></textarea>'
            % (
                name,
                ' placeholder="%s"' % _esc(f["placeholder"])
                if f.get("placeholder")
                else "",
                " required" if required else "",
            )
        )
    else:  # text
        parts.append(
            '<input type="text" name="%s"%s%s>'
            % (
                name,
                ' placeholder="%s"' % _esc(f["placeholder"])
                if f.get("placeholder")
                else "",
                " required" if required else "",
            )
        )
    parts.append("</fieldset>")
    return "".join(parts)


def wrap_artifact(spec, title):
    """Return self-contained artifact HTML for the ask-form spec."""
    prompt = spec.get("prompt") or title
    submit_label = spec.get("submitLabel") or "Submit"
    body = [
        '<div class="wrap"><h1>%s</h1>' % _esc(prompt),
    ]
    if spec.get("intro"):
        body.append('<p class="intro">%s</p>' % _esc(spec["intro"]))
    # No `novalidate`: we call reportValidity() manually (native submission is
    # sandbox-blocked). The button is type="button" so a click never attempts a
    # blocked form submission — glimpseSubmit() drives everything.
    body.append('<form id="glimpse-ask" class="card">')
    for f in spec["fields"]:
        body.append(_render_field(f))
    body.append(
        '<div class="actions">'
        '<button type="button" id="glimpse-submit" class="submit">%s</button>'
        '<span class="sent" id="glimpse-sent">✓ Sent to the agent — you can close this.</span>'
        "</div>" % _esc(submit_label)
    )
    body.append(
        '<p class="hint">This page is sandboxed; it returns your choice to the '
        "agent only through <code>glimpseRespond()</code>.</p>"
    )
    body.append("</form></div>")
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<meta name="color-scheme" content="light dark">'
        "<title>%s</title><style>%s</style></head><body>"
        "%s"
        "<script>%s</script>"
        "</body></html>"
    ) % (_esc(title), _STYLE, "".join(body), _SCRIPT)


def _main(argv):
    # Exit-code contract (matches glimpse_explain.py): 2 = spec-content error
    # (invalid JSON, oversized, or SpecError); the bash verb reserves 1 for its
    # own usage/infra failures.
    if not argv:
        sys.stderr.write("usage: glimpse_ask.py validate|wrap <title>\n")
        return 2
    cmd = argv[0]
    try:
        spec = json.load(sys.stdin)
    except Exception as e:
        sys.stderr.write("glimpse ask: spec is not valid JSON: %s\n" % e)
        return 2
    raw = json.dumps(spec, ensure_ascii=False)
    if len(raw.encode("utf-8")) > SPEC_MAX_BYTES:
        sys.stderr.write("glimpse ask: spec exceeds %d bytes\n" % SPEC_MAX_BYTES)
        return 2
    try:
        validate(spec)
    except SpecError as e:
        sys.stderr.write("glimpse ask: %s\n" % e)
        return 2
    if cmd == "validate":
        return 0
    if cmd == "wrap":
        title = argv[1] if len(argv) > 1 else (spec.get("prompt") or "Decision")
        sys.stdout.write(wrap_artifact(spec, title))
        return 0
    sys.stderr.write("glimpse ask: unknown subcommand %r\n" % cmd)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
