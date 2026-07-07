#!/usr/bin/env python3
"""Glimpse Chrome profile branding: patch (never overwrite) the automation
profile so its toolbar chip reads the Glimpse label instead of a Google account
name. Chrome shows the name from Local State's info_cache (the authoritative
display name), so patch that as well as per-profile Preferences. Invoked as a
CLI by `bin/glimpse` (best-effort; errors are swallowed by the caller).

  GLIMPSE_PROFILE_LABEL="🤖 Glimpse (automation)" glimpse_chrome_profile.py <profile-dir>

Stdlib only.
"""

import json
import os
import sys

root, label, sub = sys.argv[1], os.environ["GLIMPSE_PROFILE_LABEL"], "Default"


def load(p):
    try:
        return json.load(open(p)) if os.path.exists(p) else {}
    except Exception:
        return {}


prefs = os.path.join(root, sub, "Preferences")
d = load(prefs)
d.setdefault("profile", {})["name"] = label
os.makedirs(os.path.dirname(prefs), exist_ok=True)
json.dump(d, open(prefs, "w"))
lp = os.path.join(root, "Local State")
ls = load(lp)
ic = ls.setdefault("profile", {}).setdefault("info_cache", {}).setdefault(sub, {})
ic["name"] = label
ic["is_using_default_name"] = False
json.dump(ls, open(lp, "w"))
