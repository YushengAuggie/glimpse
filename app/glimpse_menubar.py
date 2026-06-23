#!/usr/bin/env python3
"""
Glimpse menu-bar app (macOS) — the always-on / click-to-toggle control surface.

A tiny `rumps` status-bar app that supervises `glimpse daemon` (the always-on
auto-answer bridge). The eye icon shows online/offline; click to toggle; set it
as a login item to stay online across restarts.

It is a thin supervisor: every action shells out to the `glimpse` CLI, so all
the real logic (serving, Chrome, the daemon, answering) lives in one place.

Run it via `glimpse menubar` (which makes sure `rumps` is available). The glimpse
binary path is passed in `GLIMPSE_BIN_PATH`.
"""

import os
import shutil
import subprocess
import plistlib
from pathlib import Path

import rumps

GLIMPSE = (
    os.environ.get("GLIMPSE_BIN_PATH")
    or shutil.which("glimpse")
    or os.path.expanduser("~/.local/bin/glimpse")
)
LAUNCH_AGENTS = Path.home() / "Library" / "LaunchAgents"
PLIST = LAUNCH_AGENTS / "com.glimpse.menubar.plist"
SECRETS = (
    Path.home() / ".config" / "secrets.env"
)  # sourced by the login item for the API key

TITLE = {"online": "👁🟢", "offline": "👁⚪", "starting": "👁🟡"}
STATUS = {
    "online": "🟢 Online — answering",
    "offline": "⚪️ Offline",
    "starting": "🟡 Starting…",
}


class GlimpseMenuBar(rumps.App):
    def __init__(self):
        super().__init__("Glimpse", title=TITLE["offline"], quit_button=None)
        self.daemon = None
        self.status_item = rumps.MenuItem(STATUS["offline"])
        self.status_item.set_callback(None)  # non-interactive label
        self.toggle_item = rumps.MenuItem("Go Online", callback=self.toggle)
        self.login_item = rumps.MenuItem("Start at login", callback=self.toggle_login)
        self.login_item.state = PLIST.exists()
        self.menu = [
            self.status_item,
            self.toggle_item,
            None,
            rumps.MenuItem("Open canvas", callback=self.open_canvas),
            self.login_item,
            None,
            rumps.MenuItem("Quit", callback=self.quit_app),
        ]
        self._hide_dock_icon()
        # Watchdog: reflect reality if the daemon dies on its own.
        self._timer = rumps.Timer(self._tick, 5)
        self._timer.start()
        # Always-on: come up online so a login item means "agent is listening".
        self.go_online()

    # ---- state ----------------------------------------------------------
    def _set_state(self, state):
        self.title = TITLE[state]
        self.status_item.title = STATUS[state]
        self.toggle_item.title = "Go Offline" if state == "online" else "Go Online"

    def _alive(self):
        return self.daemon is not None and self.daemon.poll() is None

    def go_online(self, *_):
        if self._alive():
            return
        self._set_state("starting")
        # Ensure the static server is up; do NOT force-open Chrome (less intrusive
        # at login). The daemon --wait will connect as soon as a canvas tab exists.
        try:
            subprocess.run(
                [GLIMPSE, "serve"],
                timeout=30,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass
        try:
            self.daemon = subprocess.Popen(
                [GLIMPSE, "daemon", "--wait"],
                env=os.environ,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self._set_state("online")
        except Exception as e:
            self.daemon = None
            self._set_state("offline")
            rumps.notification("Glimpse", "Could not start the agent", str(e))

    def go_offline(self, *_):
        if self._alive():
            self.daemon.terminate()
            try:
                self.daemon.wait(timeout=5)
            except Exception:
                self.daemon.kill()
        self.daemon = None
        self._set_state("offline")

    def toggle(self, _):
        self.go_offline() if self._alive() else self.go_online()

    def open_canvas(self, _):
        try:
            subprocess.Popen(
                [GLIMPSE, "open"],
                env=os.environ,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as e:
            rumps.notification("Glimpse", "Could not open the canvas", str(e))

    def _tick(self, _):
        if self.title == TITLE["online"] and not self._alive():
            self.daemon = None
            self._set_state("offline")

    # ---- login item -----------------------------------------------------
    def toggle_login(self, sender):
        if PLIST.exists():
            self._uninstall_login()
            sender.state = False
        else:
            self._install_login()
            sender.state = True

    def _install_login(self):
        LAUNCH_AGENTS.mkdir(parents=True, exist_ok=True)
        # source secrets so the daemon has the API key + a normal PATH at login
        launch = f'source "{SECRETS}" 2>/dev/null; exec "{GLIMPSE}" menubar'
        plist = {
            "Label": "com.glimpse.menubar",
            "ProgramArguments": ["/bin/bash", "-lc", launch],
            "RunAtLoad": True,
            "KeepAlive": True,
        }
        with open(PLIST, "wb") as f:
            plistlib.dump(plist, f)
        subprocess.run(
            ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(PLIST)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        rumps.notification(
            "Glimpse",
            "Start at login enabled",
            "The agent will come online automatically when you log in.",
        )

    def _uninstall_login(self):
        subprocess.run(
            ["launchctl", "bootout", f"gui/{os.getuid()}/com.glimpse.menubar"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            PLIST.unlink()
        except OSError:
            pass

    def quit_app(self, _):
        self.go_offline()
        rumps.quit_application()

    # ---- misc -----------------------------------------------------------
    def _hide_dock_icon(self):
        # No Dock icon / app-switcher entry — pure menu-bar agent.
        try:
            from AppKit import NSApplication

            NSApplication.sharedApplication().setActivationPolicy_(1)  # Accessory
        except Exception:
            pass


if __name__ == "__main__":
    GlimpseMenuBar().run()
