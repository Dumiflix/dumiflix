#!/usr/bin/env python3
# Handshake manifest adapted from pyLGTV (https://github.com/TheRealLink/pylgtv).
# MIT License, Copyright (c) 2016 Dennis Karpienski; see THIRD_PARTY_NOTICES.md.
"""
Minimal LG WebOS SSAP client.

SSAP (JSON over WebSocket) provides volume, mute, power, and application
control. Some TVs do not expose working speaker control through UPnP;
SSAP provides a paired alternative after an on-TV connection prompt.

Pairing:
    First connect → register without client-key → TV prompts user.
    After accept, TV returns a client-key, which we persist in
    .webos.json. Subsequent connects re-register with the saved
    key and skip the prompt.
"""

import base64
import json
import os
import secrets
import socket
import ssl
import struct
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

SCRIPT_DIR = Path(__file__).resolve().parent
KEY_FILE = SCRIPT_DIR / ".webos.json"
WS_PORT  = 3000  # ws://  (older webOS firmware)
WSS_PORT = 3001  # wss:// (newer firmware — required on most 2020+ models)
HANDSHAKE_TIMEOUT = 4
REQUEST_TIMEOUT = 5
PAIR_TIMEOUT = 90  # seconds to wait for user to accept on TV

# Standard pyLGTV manifest. Its serial is a public manifest identifier,
# not a device serial. The signature is the well-known LG dev cert
# blob; without it the TV rejects the register.
_MANIFEST = {
    "manifestVersion": 1,
    "appVersion": "1.1",
    "signed": {
        "created": "20140509",
        "appId": "com.lge.test",
        "vendorId": "com.lge",
        # These strings are part of the signed body — the TV validates
        # the manifest signature byte-for-byte, so any rename here drops
        # us to a minimal permission set (audio works, pointer-input
        # returns 401 "insufficient permissions"). Leave canonical.
        "localizedAppNames": {
            "": "LG Remote App",
            "ko-KR": "리모컨앱",
            "zxx-XX": "ЛГ Rэмotэ AПП",
        },
        "localizedVendorNames": {"": "LG Electronics"},
        "permissions": [
            "TEST_SECURE", "CONTROL_INPUT_TEXT", "CONTROL_MOUSE_AND_KEYBOARD",
            "READ_INSTALLED_APPS", "READ_LGE_SDX", "READ_NOTIFICATIONS",
            "SEARCH", "WRITE_SETTINGS", "WRITE_NOTIFICATION_ALERT",
            "CONTROL_POWER", "READ_CURRENT_CHANNEL", "READ_RUNNING_APPS",
            "READ_UPDATE_INFO", "UPDATE_FROM_REMOTE_APP",
            "READ_LGE_TV_INPUT_EVENTS", "READ_TV_CURRENT_TIME",
        ],
        "serial": "2f930e2d2cfe083771f68e4fe7bb07",
    },
    # NOTE: this TOP-LEVEL list is what the TV actually grants from. The list
    # inside "signed" above is part of the signature body and does NOT grant
    # anything on its own. Input APIs require CONTROL_INPUT_TEXT in this
    # top-level list to avoid 401 "insufficient permissions" responses. This array is outside the
    # signed body, so adding to it does not invalidate the signature.
    "permissions": [
        "LAUNCH", "LAUNCH_WEBAPP", "APP_TO_APP", "CLOSE",
        "TEST_OPEN", "TEST_PROTECTED", "CONTROL_AUDIO",
        "CONTROL_INPUT_TEXT", "CONTROL_MOUSE_AND_KEYBOARD",
        "CONTROL_DISPLAY", "CONTROL_INPUT_JOYSTICK",
        "CONTROL_INPUT_MEDIA_RECORDING", "CONTROL_INPUT_MEDIA_PLAYBACK",
        "CONTROL_INPUT_TV", "CONTROL_POWER",
        "READ_APP_STATUS", "READ_CURRENT_CHANNEL", "READ_INPUT_DEVICE_LIST",
        "READ_NETWORK_STATE", "READ_RUNNING_APPS", "READ_TV_CHANNEL_LIST",
        "WRITE_NOTIFICATION_TOAST", "READ_POWER_STATE", "READ_COUNTRY_INFO",
    ],
    "signatures": [{
        "signatureVersion": 1,
        "signature": (
            "eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9"
            ".hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrth"
            "lf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsj"
            "kcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM2DXzdKX9NmmyqzJ3o"
            "/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw=="
        ),
    }],
}

OP_TEXT, OP_CLOSE, OP_PING, OP_PONG = 0x1, 0x8, 0x9, 0xA


# ---------- minimal websocket framing ----------

def _ws_handshake(sock, host, port, path="/"):
    key = base64.b64encode(secrets.token_bytes(16)).decode()
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(req.encode())
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("ws handshake: connection closed")
        data += chunk
    status = data.split(b"\r\n", 1)[0]
    if b" 101 " not in status:
        raise ConnectionError(f"ws handshake bad status: {status!r}")


def _ws_connect_url(url):
    """Open a TCP/TLS websocket to the given ws:// or wss:// URL and
    complete the HTTP/Upgrade handshake. Used for the SSAP pointer-input
    socket whose path the TV hands us at runtime."""
    parsed = urlparse(url)
    use_tls = (parsed.scheme == "wss")
    host = parsed.hostname
    port = parsed.port or (3001 if use_tls else 3000)
    path = parsed.path or "/"
    sock = socket.create_connection((host, port), timeout=HANDSHAKE_TIMEOUT)
    sock.settimeout(HANDSHAKE_TIMEOUT)
    if use_tls:
        # webOS uses a self-signed cert; skip validation rather than
        # bundle a root CA.
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        sock = ctx.wrap_socket(sock, server_hostname=host)
    _ws_handshake(sock, host, port, path=path)
    return sock


def _ws_send(sock, payload, opcode=OP_TEXT):
    if isinstance(payload, str):
        payload = payload.encode()
    n = len(payload)
    header = bytes([0x80 | opcode])
    if n < 126:
        header += bytes([0x80 | n])
    elif n < 65536:
        header += bytes([0x80 | 126]) + struct.pack(">H", n)
    else:
        header += bytes([0x80 | 127]) + struct.pack(">Q", n)
    mask = secrets.token_bytes(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(header + mask + masked)


def _read_exact(sock, n):
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise ConnectionError("ws: eof")
        data += chunk
    return data


def _ws_recv(sock):
    while True:
        b1, b2 = _read_exact(sock, 2)
        opcode = b1 & 0x0F
        masked = b2 & 0x80
        length = b2 & 0x7F
        if length == 126:
            length, = struct.unpack(">H", _read_exact(sock, 2))
        elif length == 127:
            length, = struct.unpack(">Q", _read_exact(sock, 8))
        mask = _read_exact(sock, 4) if masked else None
        payload = _read_exact(sock, length) if length else b""
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        if opcode == OP_PING:
            _ws_send(sock, payload, opcode=OP_PONG)
            continue
        if opcode == OP_CLOSE:
            raise ConnectionError("ws: closed by server")
        return opcode, payload


# ---------- SSAP client ----------

class SSAPClient:
    def __init__(self, host, port=None):
        self.host = host
        # `port` is None unless the caller pinned one; connect() picks.
        self.port = port
        self.use_tls = None  # set during connect()
        self.sock = None
        self.req_id = 0

    def connect(self):
        """Open a fresh SSAP websocket. Newer LG firmware (most 2020+
        models) only accepts wss:// on 3001 and resets ws:// on 3000;
        older firmware does the opposite. Try TLS first, fall back to
        plain ws so both generations keep working."""
        if self.port is not None:
            attempts = [(self.port == WSS_PORT, self.port)]
        else:
            attempts = [(True, WSS_PORT), (False, WS_PORT)]
        last_err = None
        for use_tls, port in attempts:
            try:
                self._connect_one(use_tls, port)
                self.use_tls, self.port = use_tls, port
                return
            except (OSError, ConnectionError, TimeoutError) as e:
                last_err = e
                if self.sock is not None:
                    try: self.sock.close()
                    except OSError: pass
                self.sock = None
        raise last_err or ConnectionError("ssap connect failed")

    def _connect_one(self, use_tls, port):
        sock = socket.create_connection((self.host, port),
                                        timeout=HANDSHAKE_TIMEOUT)
        sock.settimeout(HANDSHAKE_TIMEOUT)
        if use_tls:
            # webOS uses a self-signed cert; skip verification rather
            # than bundle a root CA. The TV is on the LAN over a
            # token-protected remote, not a trust boundary.
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            sock = ctx.wrap_socket(sock, server_hostname=self.host)
        _ws_handshake(sock, self.host, port)
        self.sock = sock

    def close(self):
        if self.sock:
            try: self.sock.close()
            except OSError: pass
            self.sock = None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *a):
        self.close()

    def _send(self, obj):
        _ws_send(self.sock, json.dumps(obj))

    def _recv(self):
        _, data = _ws_recv(self.sock)
        return json.loads(data.decode())

    def register(self, client_key=None):
        """Send the register payload; return the client-key from the
        TV's `registered` response. If client_key is given, the TV
        does not prompt. Otherwise, the user must Accept on the TV
        within PAIR_TIMEOUT seconds."""
        payload = {"forcePairing": False, "pairingType": "PROMPT", "manifest": _MANIFEST}
        if client_key:
            payload["client-key"] = client_key
        self._send({"type": "register", "id": "register_0", "payload": payload})
        deadline = time.time() + PAIR_TIMEOUT
        # First we get a 'response' with pairingType, then a 'registered'
        # once the user accepts. With a known client-key it's just
        # 'registered'. We set the recv timeout to the full remaining
        # window — looping with short timeouts can interrupt _ws_recv
        # mid-frame on TLS sockets and corrupt WS framing.
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError("pairing timed out (Accept on the TV)")
            self.sock.settimeout(remaining)
            try:
                msg = self._recv()
            except (socket.timeout, TimeoutError):
                raise TimeoutError("pairing timed out (Accept on the TV)")
            except (OSError, ssl.SSLError) as e:
                raise ConnectionError(f"pairing socket error: {e}")
            t = msg.get("type")
            if t == "registered":
                return msg.get("payload", {}).get("client-key")
            if t == "error":
                err = msg.get("error") or "ssap register error"
                raise RuntimeError(err)
            # 'response' ack — keep waiting for 'registered'

    def request(self, uri, params=None):
        self.req_id += 1
        rid = f"r{self.req_id}"
        msg = {"type": "request", "id": rid, "uri": uri}
        if params:
            msg["payload"] = params
        self._send(msg)
        deadline = time.time() + REQUEST_TIMEOUT
        while time.time() < deadline:
            self.sock.settimeout(max(0.2, deadline - time.time()))
            try:
                resp = self._recv()
            except (socket.timeout, TimeoutError):
                break
            if resp.get("id") != rid:
                continue
            if resp.get("type") == "error":
                raise RuntimeError(resp.get("error") or "ssap error")
            return resp.get("payload", {})
        raise TimeoutError(f"ssap timeout: {uri}")


# ---------- key persistence ----------

def load_state():
    try:
        return json.loads(KEY_FILE.read_text())
    except Exception:
        return {}

def save_state(d):
    KEY_FILE.write_text(json.dumps(d, indent=2) + "\n")
    try: os.chmod(KEY_FILE, 0o600)
    except OSError: pass

def is_paired() -> bool:
    return bool(load_state().get("client_key"))


# ---------- connection manager ----------

class WebOSManager:
    """One persistent SSAP connection guarded by a lock. Reconnects
    on any error. Volume polling and slider drags share the socket."""

    def __init__(self, host):
        self.host = host
        self.client = None
        self.lock = threading.Lock()
        self.last_error = ""
        # Lazy-opened input-pointer socket. Used to send raw remote-button
        # codes (VOLUMEUP/VOLUMEDOWN/etc.) which on eARC setups drive the
        # AV receiver via HDMI-CEC even when ssap://audio/setVolume is a no-op.
        self._input_sock = None
        self._input_lock = threading.Lock()

    def _connect(self, *, force_pair=False):
        c = SSAPClient(self.host)
        c.connect()
        state = load_state()
        key = None if force_pair else state.get("client_key")
        new_key = c.register(client_key=key)
        if new_key and new_key != key:
            state["client_key"] = new_key
            save_state(state)
        self.client = c

    def _ensure(self):
        if self.client is None:
            if not is_paired():
                raise RuntimeError("not paired — click Pair TV in the remote")
            self._connect()

    def call(self, uri, params=None):
        with self.lock:
            for attempt in range(2):
                try:
                    self._ensure()
                    return self.client.request(uri, params)
                except (OSError, ConnectionError, TimeoutError, RuntimeError) as e:
                    self.last_error = str(e)
                    if self.client is not None:
                        self.client.close()
                    self.client = None
                    # Pointer-input socket lives on the TV's SSAP session;
                    # if the SSAP socket died, the pointer one is dead too.
                    with self._input_lock:
                        self._close_input_socket()
                    if attempt == 1 or "not paired" in str(e):
                        raise

    def pair(self):
        """Force a fresh pair. TV will show the Accept prompt."""
        with self.lock:
            if self.client:
                self.client.close()
                self.client = None
            # Drop any stale key so the TV is forced to prompt. After
            # a TV reboot the previous key is sometimes silently rejected
            # (TV pops the prompt as if we're a new client), so wiping
            # local state up front keeps the new-key write path clean.
            state = load_state()
            state.pop("client_key", None)
            save_state(state)
            # Pointer-input socket is owned by the TV's old SSAP session;
            # tearing it down forces a fresh getPointerInputSocket call
            # against the newly-paired connection.
            with self._input_lock:
                self._close_input_socket()
            self._connect(force_pair=True)
            return load_state().get("client_key")

    # --- high-level helpers ---

    def get_volume(self):
        d = self.call("ssap://audio/getVolume") or {}
        # WebOS returns volume in 'volume' or 'volumeStatus.volume'
        if "volume" in d:
            return int(d["volume"]), bool(d.get("muted", False))
        vs = d.get("volumeStatus") or {}
        return int(vs.get("volume", 0)), bool(vs.get("muteStatus", False))

    def set_volume(self, level):
        level = max(0, min(100, int(level)))
        return self.call("ssap://audio/setVolume", {"volume": level})

    def volume_up(self):
        return self.call("ssap://audio/volumeUp")

    def volume_down(self):
        return self.call("ssap://audio/volumeDown")

    def set_mute(self, mute):
        return self.call("ssap://audio/setMute", {"mute": bool(mute)})

    def power_off(self):
        return self.call("ssap://system/turnOff")

    def launch_app(self, app_id, content_id=None, launch_params=None):
        """Bring a TV app to the foreground.
        `launch_params` is the SSAP `params` field — an arbitrary dict that
        the launched app reads via webOSLaunch / window.launchParams. The
        YouTube TV app, for example, accepts {"contentTarget": "v=<id>"}
        to deep-link straight into a video on launch."""
        req = {"id": app_id}
        if content_id:
            req["contentId"] = content_id
        if launch_params:
            req["params"] = launch_params
        return self.call("ssap://system.launcher/launch", req)

    def close_app(self, app_id):
        """Terminate a foreground/background app. Used by the 'reset to
        DumiFlix' flow because re-launching alone doesn't reset the WebView
        state on webOS — you must fully kill the app first so the next
        launch reloads index.html from scratch."""
        return self.call("ssap://system.launcher/close", {"id": app_id})

    # --- input-pointer (raw remote button) ---

    def _ensure_input_socket(self):
        if self._input_sock is not None:
            return self._input_sock
        payload = self.call(
            "ssap://com.webos.service.networkinput/getPointerInputSocket") or {}
        url = payload.get("socketPath")
        if not url:
            raise RuntimeError("no pointer input socketPath in TV response")
        self._input_sock = _ws_connect_url(url)
        return self._input_sock

    def _close_input_socket(self):
        sock = self._input_sock
        self._input_sock = None
        if sock is not None:
            try: sock.close()
            except OSError: pass

    def press_button(self, name):
        """Send a remote-button press over the pointer-input websocket.
        For external audio outputs, raw button events can reach HDMI-CEC
        volume control when the SSAP audio APIs affect only internal speakers."""
        with self._input_lock:
            for attempt in range(2):
                try:
                    sock = self._ensure_input_socket()
                    # Pointer-input frames are plain text, terminated by
                    # an extra blank line. Each call sends one button.
                    _ws_send(sock, f"type:button\nname:{name}\n\n")
                    return
                except (OSError, ConnectionError, TimeoutError, RuntimeError):
                    self._close_input_socket()
                    if attempt == 1:
                        raise


if __name__ == "__main__":
    import sys

    def _die(msg: str, code: int = 1) -> None:
        print(msg, file=sys.stderr)
        sys.exit(code)

    av = sys.argv[1:]
    if not av or av[0] in ("-h", "--help", "help"):
        print(
            "Usage: python3 webos_ssap.py pair [<tv-lan-ip>]\n"
            "\n"
            "  If <tv-lan-ip> is omitted, use DUMIFLIX_TV_HOST or tv_host in automation.json "
            "(same folder).\n"
            "  When the TV shows “Allow connection?”, accept within ~90s.\n"
        )
        sys.exit(0 if av else 1)

    if av[0] != "pair":
        _die("Unknown command. Try: python3 webos_ssap.py pair <tv-ip>")

    host = (av[1] if len(av) >= 2 else os.environ.get("DUMIFLIX_TV_HOST", "")).strip()
    if not host:
        auto = SCRIPT_DIR / "automation.json"
        if auto.is_file():
            try:
                cfg = json.loads(auto.read_text(encoding="utf-8"))
                host = str(cfg.get("tv_host") or "").strip()
            except Exception:
                host = ""
    if not host:
        _die("Pass the TV’s IP:\n  python3 webos_ssap.py pair tv.local")

    print(f"Pairing with {host} — accept the prompt on the TV now …", flush=True)
    try:
        key = WebOSManager(host).pair()
        if key:
            st = load_state()
            st["tv_ip"] = host
            save_state(st)
            print(f"Paired OK. Saved client_key → {KEY_FILE}")
        else:
            _die("Pairing ended without a client_key (try again).", 2)
    except Exception as e:
        _die(f"Pairing failed: {e}", 3)
