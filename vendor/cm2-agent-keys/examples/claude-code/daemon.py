#!/usr/bin/env python3
"""wl-bridge: Claude Code session status -> iTerm2 tabs (and later, Creator Micro 2 LEDs).

Receives Claude Code hook events over HTTP (localhost:8377), keeps a registry of
sessions mapped to physical key slots 1-6, and paints each session's iTerm2 tab
colour + badge to match its state. Also exposes /focus so pad keys can jump to
a session's pane.
"""

import asyncio
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import iterm2

PORT = 8377
STATE_FILE = os.path.expanduser("~/wl-bridge/state.json")
MAX_SLOTS = 4
DONE_FADE_SECS = 600  # done -> idle after 10 min

# state -> (tab colour rgb, badge glyph)
STATES = {
    "idle":       ((110, 110, 110), "·"),
    "working":    ((10, 132, 255),  "⚙"),
    "question":   ((255, 159, 10),  "?"),
    "permission": ((255, 69, 58),   "⛔"),
    "done":       ((48, 209, 88),   "✓"),
}
NEEDIEST_ORDER = ["permission", "question", "done", "working", "idle"]


class Registry:
    """session_id -> {slot, iterm_id, state, cwd, ts}. Thread-safe via lock."""

    def __init__(self):
        self.lock = threading.Lock()
        self.sessions = {}
        self._load()

    def _load(self):
        try:
            with open(STATE_FILE) as f:
                self.sessions = json.load(f)
        except (OSError, ValueError):
            self.sessions = {}

    def _save(self):
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.sessions, f, indent=1)
        os.replace(tmp, STATE_FILE)

    def _free_slot(self):
        used = {s["slot"] for s in self.sessions.values() if s.get("slot")}
        for n in range(1, MAX_SLOTS + 1):
            if n not in used:
                return n
        return None  # more sessions than keys; tracked but unlit

    def upsert(self, session_id, iterm_id=None, cwd=None, state=None):
        with self.lock:
            s = self.sessions.setdefault(
                session_id, {"slot": None, "iterm_id": None,
                             "state": "idle", "cwd": None, "ts": 0})
            if iterm_id:
                s["iterm_id"] = iterm_id
            # only pane-addressable sessions get a physical key; a session
            # in Terminal.app (no iTerm2 pane id) would waste a slot the pad
            # can neither light meaningfully nor jump to
            if s["iterm_id"] and not s["slot"]:
                s["slot"] = self._free_slot()
            if cwd:
                s["cwd"] = cwd
            if state:
                s["state"] = state
            s["ts"] = time.time()
            self._save()
            return dict(s)

    def prune(self, dead_ids):
        with self.lock:
            for sid in dead_ids:
                self.sessions.pop(sid, None)
            if dead_ids:
                self._save()

    def remove(self, session_id):
        with self.lock:
            s = self.sessions.pop(session_id, None)
            self._save()
            return s

    def by_slot(self, slot):
        with self.lock:
            for sid, s in self.sessions.items():
                if s.get("slot") == slot:
                    return sid, dict(s)
        return None, None

    def neediest(self):
        with self.lock:
            ranked = sorted(
                self.sessions.items(),
                key=lambda kv: (NEEDIEST_ORDER.index(kv[1]["state"]), -kv[1]["ts"]))
            return (ranked[0][0], dict(ranked[0][1])) if ranked else (None, None)

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self.sessions))

    def fade_done(self):
        """done -> idle after DONE_FADE_SECS; returns session ids that changed."""
        changed = []
        now = time.time()
        with self.lock:
            for sid, s in self.sessions.items():
                if s["state"] == "done" and now - s["ts"] > DONE_FADE_SECS:
                    s["state"] = "idle"
                    changed.append(sid)
            if changed:
                self._save()
        return changed


REG = Registry()
LOOP = None       # asyncio loop owned by the iterm2 connection
APP = None        # iterm2 app handle, set once connected
CONN = None       # iterm2 connection, for window creation

# Per-key thread lighting (fw v0.6.0+ OAI bridge). Effects: 0 off, 1 solid,
# 2 snake, 3 rainbow, 4 breath. Colours packed RGB ints; brightness/speed 0-1.
KEY_STATES = {
    "permission": {"color": 0xFF0000, "brightness": 1.0,  "effect": 1, "speed": 0.5},
    "question":   {"color": 0xFF9F0A, "brightness": 1.0,  "effect": 4, "speed": 0.6},
    "working":    {"color": 0x0A84FF, "brightness": 0.7,  "effect": 1, "speed": 0.5},
    "done":       {"color": 0x30D058, "brightness": 0.8,  "effect": 1, "speed": 0.5},
    "idle":       {"color": 0xFFFFFF, "brightness": 0.15, "effect": 1, "speed": 0.5},
}
KEY_OFF = {"brightness": 0.0, "effect": 0}
# Ambient ring mirrors the worst state; keys base stays dark so agent keys pop.
AMBIENT = {
    "permission": {"effect": 1, "brightness": 0.9,  "speed": 0.5, "magic": 0, "color": 0xFF0000},
    "question":   {"effect": 4, "brightness": 0.8,  "speed": 0.6, "magic": 0, "color": 0xFF9F0A},
    "working":    {"effect": 1, "brightness": 0.4,  "speed": 0.5, "magic": 0, "color": 0x0A84FF},
    "done":       {"effect": 1, "brightness": 0.5,  "speed": 0.5, "magic": 0, "color": 0x30D058},
    "idle":       {"effect": 4, "brightness": 0.15, "speed": 0.3, "magic": 0, "color": 0x5E5CE6},
}
# Base backlight for all non-agent keys (single zone — can't differ per key):
# a low warm white so legends are visible without competing with row 1.
KEYS_BASE = {"effect": 1, "brightness": 0.12, "speed": 0.5, "magic": 0, "color": 0xFFD9A6}

LED_PROC = None  # node service.js child


def led_send(obj):
    if LED_PROC and LED_PROC.stdin and not LED_PROC.stdin.is_closing():
        LED_PROC.stdin.write((json.dumps(obj) + "\n").encode())


def led_sync():
    """Push per-slot key colours + aggregate ambient to the pad."""
    snap = REG.snapshot()
    by_slot = {s["slot"]: s["state"] for s in snap.values() if s.get("slot")}
    threads = []
    for slot in range(1, MAX_SLOTS + 1):
        state = by_slot.get(slot)
        spec = KEY_STATES.get(state, KEY_OFF) if state else KEY_OFF
        threads.append({"id": slot - 1, **spec})
    agg = next((st for st in NEEDIEST_ORDER if st in by_slot.values()), "idle")
    # AG04 = the single "new Claude" button: always a bright white pulse
    threads.append({"id": 4, "color": 0xFFFFFF, "brightness": 0.9,
                    "effect": 4, "speed": 0.4})
    led_send({"threads": threads})
    led_send({"config": {"ambient": AMBIENT[agg], "keys": KEYS_BASE}})


async def led_service():
    """Supervise the node LED/key service; restart it if it dies."""
    global LED_PROC
    node = "/opt/homebrew/bin/node"
    script = os.path.expanduser("~/wl-bridge/led/service.js")
    while True:
        try:
            # clear any stray service from a previous daemon generation —
            # an orphan holding the HID device blocks the new one
            sweep = await asyncio.create_subprocess_exec(
                "/usr/bin/pkill", "-f", "wl-bridge/led/service.js",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL)
            await sweep.wait()
            LED_PROC = await asyncio.create_subprocess_exec(
                node, script,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL)
            async for raw in LED_PROC.stdout:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                try:
                    if msg.get("ready"):
                        print(f"{time.strftime('%H:%M:%S')} pad connected")
                        led_sync()
                    elif "press" in msg:
                        n = int(msg["press"])
                        print(f"{time.strftime('%H:%M:%S')} press AG{n:02d}")
                        if n == 4:
                            await new_session()
                        else:
                            _, s = REG.by_slot(n + 1)
                            if s:
                                await focus(s["iterm_id"])
                except Exception as e:  # a dead iTerm2 socket must never
                    print(f"press handling failed: {e}")  # kill the listener
        except OSError:
            pass
        LED_PROC = None
        await asyncio.sleep(5)


async def update_glow():
    """Kept as the single entry point hooks call — now drives per-key LEDs."""
    led_sync()


def classify(event):
    """Map a Claude Code hook payload to a state transition (or None)."""
    name = event.get("hook_event_name", "")
    if name == "SessionStart":
        return "idle"
    if name == "UserPromptSubmit":
        return "working"
    if name == "PreToolUse" and event.get("tool_name") == "AskUserQuestion":
        return "question"
    if name == "PostToolUse" and event.get("tool_name") == "AskUserQuestion":
        return "working"
    if name == "Notification":
        msg = (event.get("message") or "").lower()
        # only permission requests change state; the generic "waiting for
        # your input" idle notification would otherwise turn every finished
        # session amber a minute after it goes green
        return "permission" if "permission" in msg else None
    if name == "Stop":
        return "done"
    return None


async def paint(iterm_id, state, slot):
    """Set tab colour + badge on the session's pane. No-op if iTerm2 unreachable."""
    if APP is None or not iterm_id:
        return
    uuid = iterm_id.split(":")[-1]
    session = APP.get_session_by_id(uuid)
    if session is None:
        return
    rgb, glyph = STATES[state]
    prof = iterm2.LocalWriteOnlyProfile()
    prof.set_use_tab_color(True)
    prof.set_tab_color(iterm2.Color(*rgb))
    prof.set_badge_text(f"{slot or '·'} {glyph}")
    await session.async_set_profile_properties(prof)


# What the "new session" key runs in a fresh iTerm2 tab. Configure via
# ~/.config/wl-bridge.json {"new_session_cmd": "..."} — e.g. plain "claude\n"
# or an ssh to your dev box: "ssh -t devbox 'cd ~/proj && ~/.local/bin/claude'\n"
def _load_new_session_cmd():
    try:
        with open(os.path.expanduser("~/.config/wl-bridge.json")) as f:
            return json.load(f)["new_session_cmd"]
    except (OSError, KeyError, ValueError):
        return "claude\n"


NEW_SESSION_CMD = _load_new_session_cmd()


async def new_session(retrying=False):
    """Open a new iTerm2 tab and run the configured new-session command.

    Self-sufficient: launches iTerm2 if it's not running (the daemon's retry
    loop reconnects within seconds) and creates a window if none exist."""
    global APP
    if APP is None:
        os.system("open -a iTerm >/dev/null 2>&1")
        for _ in range(20):
            await asyncio.sleep(0.5)
            if APP is not None:
                break
        if APP is None:
            return
    try:
        win = APP.current_terminal_window
        if win is None and CONN is not None:
            win = await iterm2.Window.async_create(CONN)
            session = win.current_tab.current_session
        else:
            if win is None:
                return
            session = (await win.async_create_tab()).current_session
        await session.async_send_text(NEW_SESSION_CMD)
        await APP.async_activate(raise_all_windows=False)
    except Exception:
        # stale handle — iTerm2 was quit since we connected. Relaunch it;
        # the retry loop reconnects and re-runs main(), refreshing APP.
        if not retrying:
            APP = None
            await new_session(retrying=True)


async def focus(iterm_id):
    if APP is None or not iterm_id:
        return False
    uuid = iterm_id.split(":")[-1]
    session = APP.get_session_by_id(uuid)
    if session is None:
        return False
    await session.async_activate(select_tab=True, order_window_front=True)
    await APP.async_activate(raise_all_windows=False)
    return True


def run_async(coro):
    """Schedule a coroutine on the iterm2 loop from HTTP threads."""
    if LOOP is not None:
        asyncio.run_coroutine_threadsafe(coro, LOOP)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/state":
            self._reply(200, REG.snapshot())
        else:
            self._reply(404, {"err": "unknown path"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._reply(400, {"err": "bad json"})

        if self.path == "/hook":
            sid = body.get("session_id")
            if not sid:
                return self._reply(400, {"err": "no session_id"})
            iterm_id = self.headers.get("X-Iterm-Session") or None
            if body.get("hook_event_name") == "SessionEnd":
                s = REG.remove(sid)
                if s:
                    run_async(paint(s["iterm_id"], "idle", None))
                run_async(update_glow())
                return self._reply(200, {"ok": True})
            state = classify(body)
            s = REG.upsert(sid, iterm_id=iterm_id, cwd=body.get("cwd"),
                           state=state)
            run_async(paint(s["iterm_id"], s["state"], s["slot"]))
            run_async(update_glow())
            return self._reply(200, {"ok": True, "slot": s["slot"],
                                     "state": s["state"]})

        if self.path == "/new":
            run_async(new_session())
            return self._reply(200, {"ok": True})

        if self.path == "/focus":
            if body.get("which") == "neediest":
                sid, s = REG.neediest()
            else:
                sid, s = REG.by_slot(int(body.get("slot", 0)))
            if not s:
                return self._reply(404, {"err": "no such session"})
            run_async(focus(s["iterm_id"]))
            return self._reply(200, {"ok": True, "session": sid,
                                     "state": s["state"]})

        return self._reply(404, {"err": "unknown path"})


async def fade_loop():
    tick = 0
    while True:
        await asyncio.sleep(30)
        # liveness probe: if the iTerm2 websocket has died, exit and let
        # launchd relaunch us clean — a daemon with a dead socket has
        # working lights but dead buttons, which is worse than a restart
        if CONN is not None:
            try:
                await iterm2.async_get_app(CONN)
            except Exception as e:
                print(f"{time.strftime('%H:%M:%S')} iTerm2 connection dead "
                      f"({e}) — exiting for launchd relaunch")
                os._exit(86)
        try:
            # prune sessions whose iTerm2 pane is gone (tab closed without a
            # clean SessionEnd) and pane-less strays idle for over 4 hours
            if APP is not None:
                dead = []
                for sid, s in REG.snapshot().items():
                    if s.get("iterm_id"):
                        if APP.get_session_by_id(s["iterm_id"].split(":")[-1]) is None:
                            dead.append(sid)
                    elif time.time() - s.get("ts", 0) > 4 * 3600:
                        dead.append(sid)
                REG.prune(dead)
            # periodic LED resync: the firmware reverts to its stored
            # profile lighting on profile reloads/replugs, and never tells us
            led_sync()
            tick += 1
            if tick % 2:
                continue
            for sid in REG.fade_done():
                s = REG.sessions.get(sid)
                if s:
                    await paint(s["iterm_id"], "idle", s["slot"])
        except Exception as e:
            print(f"{time.strftime('%H:%M:%S')} fade_loop error: {e}")


_tasks_started = False


async def main(connection):
    global LOOP, APP, CONN, _tasks_started
    LOOP = asyncio.get_event_loop()
    CONN = connection
    APP = await iterm2.async_get_app(connection)
    print(f"wl-bridge: connected to iTerm2, listening on :{PORT}")
    if not _tasks_started:  # main() re-runs on iTerm2 reconnect
        _tasks_started = True
        asyncio.ensure_future(fade_loop())
        asyncio.ensure_future(led_service())
    # repaint anything we knew about before a restart
    for s in REG.snapshot().values():
        await paint(s["iterm_id"], s["state"], s["slot"])
    await asyncio.Future()  # run forever


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"wl-bridge: HTTP up on 127.0.0.1:{PORT}; connecting to iTerm2…")
    iterm2.run_forever(main, retry=True)
