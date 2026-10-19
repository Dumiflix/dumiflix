# DumiFlix laptop engine

This Python service prepares media for the DumiFlix webOS app. It serves rolling
HLS remux/transcode sessions, local media and an optional bounded disk cache.
Optional modules add aria2 downloads, persistent season prefetch, catalog
metadata, subtitle alignment/generation, Windows mpv playback, and paired LG
SSAP control. Core Python code uses the standard library.

Use Python 3.12+ and install **ffmpeg and ffprobe** for your operating system.
The configured ffmpeg build must support the codecs and flags used by the
engine, including `-readrate_initial_burst` for local playback. Optional tools
are **aria2c** for torrents, **mpv** for Windows HDMI playback, and **ffsubsync**
for subtitle alignment. Whisper features require a local ggml model and an
ffmpeg build with the `whisper` filter. No model, binary, or credential is
included here.

From the repository root, set the executable paths and a newly generated token,
then start the server (POSIX shell example):

```sh
export DUMIFLIX_FFMPEG="$(command -v ffmpeg)"
export DUMIFLIX_FFPROBE="$(command -v ffprobe)"
export DUMIFLIX_TV_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
python3 tv-service/server.py
```

The server listens on `127.0.0.1:9891` by default. For TV access, set
`DUMIFLIX_TV_BIND` to the engine computer’s private LAN interface address, and
configure that engine address, port, and the same token in the TV app. Use your
actual interface address; documentation addresses are not deployment settings.
To enable caching, set `DUMIFLIX_CACHE_ENABLED=1`; the default cache location is
`~/dumiflix-cache`. Local torrents additionally need
`DUMIFLIX_TORRENT_ENABLED=1` and aria2c. Choose either local torrent execution
or a separately configured remote torrent engine.

`env.example` inventories every variable read by the engine. Its assignments
are commented and empty so that sourcing it does not override working defaults.
Copy selected entries into your shell/service configuration, fill them in, and
export them before startup. Python does not load this file or `.env` itself.
For Windows, set environment variables through PowerShell or the service
launcher; use writable local paths for the remux temp directory and log file.
Most settings are read at import time, so restart after changing configuration.
An unset variable uses the default below. An explicitly empty value is not
accepted by every numeric/path setting; unset unused settings instead.

SSAP pairing is optional:

```sh
python3 tv-service/webos_ssap.py pair tv.local
```

Use the configured TV hostname/address and accept the on-TV prompt. Without a
CLI target, pairing uses `DUMIFLIX_TV_HOST`, then `tv_host` in a local
`tv-service/automation.json`. The returned key and TV address are stored locally
in `tv-service/.webos.json`, with restrictive file permissions where supported.
The manifest’s public development certificate is protocol data; the generated
pairing key is private and must stay out of version control.

The optional mpv adapter is Windows-specific and requires a registered
interactive-user scheduled task named by `DUMIFLIX_MPV_LAUNCH_TASK`. That task’s
launcher must read `DUMIFLIX_MPV_JOB_FILE`, launch its JSON `argv` array as an
argument list, and use the same job path as the engine. Register it for the
logged-on desktop user so display/audio devices are available when the engine
runs as a service. Task registration and its launcher are not included. Choose
an explicit audio device and screen when automatic selection is unsuitable.

The direct HTTP lease client is disabled by default. It requires a separately
deployed compatible broker that verifies routes and pauses conflicting work.
The aria2 dashboard and its importer are not part of this repository. Enabling
the client without a valid broker URL/token causes transfers to fail closed.

Set a strong `DUMIFLIX_TV_TOKEN` before allowing LAN access: an empty token leaves
control routes open. Bind only to loopback or a trusted private LAN interface,
restrict access with the host firewall, and do not publish this HTTP port to the
internet. Media session URLs carry access capabilities and should stay private.
Keep tokens, broker credentials, `.webos.json`, `automation.json`, local `.env`
files, caches, logs, and launch jobs out of public commits. Logs and cached
metadata may contain media names, URLs, and local paths; review before sharing.

Environment variables (paths beginning with `~` below describe the current
user’s home; code-generated defaults are absolute paths):

### Server and TV control

| Variable | Default | Meaning |
| --- | --- | --- |
| `DUMIFLIX_TV_BIND` | 127.0.0.1 | HTTP listen address; set to the engine host’s private LAN address for TV access. |
| `DUMIFLIX_TV_PORT` | 9891 | HTTP listen port. |
| `DUMIFLIX_TV_TOKEN` | empty | Shared control/API token; configure the same token in the TV app. |
| `DUMIFLIX_TV_CONN_TIMEOUT` | 120 | Socket read timeout in seconds. |
| `DUMIFLIX_TV_HOST` | empty | SSAP pairing target when no CLI address is supplied; then falls back to tv_host in local automation.json. |
| `DUMIFLIX_LOG_DIR` | tv-service/logs | Directory for dated server/TV logs and mpv-last.log. |
| `DUMIFLIX_LOG_KEEP_DAYS` | 30 | Retention for dated diagnostic logs. |

### Remux and tools

| Variable | Default | Meaning |
| --- | --- | --- |
| `DUMIFLIX_FFMPEG` | tv-service/bin/ffmpeg | Executable path for ffmpeg; set to the installed executable on a laptop. |
| `DUMIFLIX_FFPROBE` | tv-service/bin/ffprobe | Executable path for ffprobe; set to the installed executable on a laptop. |
| `DUMIFLIX_SSL_CERT_DIR` | /etc/ssl/certs on non-Windows; empty on Windows | CA directory passed to ffmpeg as SSL_CERT_DIR; empty leaves the subprocess setting inherited. |
| `DUMIFLIX_SSL_CERT_FILE` | empty | CA bundle passed to ffmpeg as SSL_CERT_FILE when set. |
| `DUMIFLIX_REMUX_TMP` | /tmp/dumiflix_remux | Scratch directory for HLS segments; use a writable disk-backed path if needed. |
| `DUMIFLIX_REMUX_LOG` | /tmp/dumiflix-remux.log | Remux diagnostics file; change to a writable local path on Windows. |
| `DUMIFLIX_REMUX_WINDOW_SEGMENTS` | 12 | Rolling HLS window size at the reference segment duration; local-source counts scale to preserve time depth. |
| `DUMIFLIX_REMUX_CAP_MB` | 60 | Hard segment storage cap in MiB, especially important on RAM-backed temp storage. |
| `DUMIFLIX_REMUX_LOCAL_SEGMENT_SECONDS` | 2 | Local-source target segment length in seconds. |
| `DUMIFLIX_REMUX_LOCAL_BURST_SECONDS` | 6 | Initial full-speed local input burst before real-time pacing, in seconds. |
| `DUMIFLIX_REMUX_MAX_AUDIO_CHANNELS` | 6 | Maximum transcoded audio channel count. |
| `DUMIFLIX_REMUX_DOLBY_PASSTHROUGH` | 1 | Copy AC-3/E-AC-3 in MPEG-TS; 0, false, no, or off disables it. |
| `DUMIFLIX_REMUX_MAX_VIDEO_BITRATE` | 6000000 | Source bitrate threshold in bits/second above which MPEG-TS video is transcoded. |
| `DUMIFLIX_REMUX_TARGET_VIDEO_BITRATE` | 5000000 | Target transcoded video bitrate in bits/second. |
| `DUMIFLIX_REMUX_VIDEO_ENCODER` | h264_qsv | Preferred H.264 encoder; initialization is probed at runtime. |
| `DUMIFLIX_REMUX_VIDEO_ENCODER_FALLBACK` | libx264 | Fallback encoder when the preferred encoder cannot initialize. |
| `DUMIFLIX_IDR_STEP_SECONDS` | 4 | Step size in seconds when searching backward for a clean HEVC start. |
| `DUMIFLIX_IDR_MAX_STEPS` | 6 | Maximum backward-search steps. |
| `DUMIFLIX_THUMBS` | 0 | 1 enables per-session preview thumbnails; separate from cached-file storyboards. |

### Cache and catalog

| Variable | Default | Meaning |
| --- | --- | --- |
| `DUMIFLIX_CACHE_ENABLED` | 0 | 1 enables disk cache, persistent season queue, catalog refresh, and cached-file preprocessing. |
| `DUMIFLIX_CACHE_ROOT` | ~/dumiflix-cache | Cache directory under the current user’s home. |
| `DUMIFLIX_CACHE_CAP_MAX` | 8589934592 (8 GiB) | Upper ceiling for the configured cache cap, in bytes. |
| `DUMIFLIX_CACHE_CAP_BYTES` | 8589934592 (8 GiB) | Cache byte budget, clamped to CACHE_CAP_MAX. |
| `DUMIFLIX_CACHE_FLOOR_BYTES` | 4294967296 (4 GiB) | Minimum free bytes on the cache filesystem; cannot be configured below 4 GiB. |
| `DUMIFLIX_CACHE_GROWING_MIN_BYTES` | 33554432 (32 MiB) | Minimum buffered bytes before growing-cache handoff; at least one 4 MiB chunk. |
| `DUMIFLIX_CACHE_GROWING_MP4_PROBE_BYTES` | 16777216 (16 MiB) | Bounded MP4 header probe size; at least one 4 MiB chunk. |
| `DUMIFLIX_CACHE_SWEEP_INTERVAL_SECONDS` | 60 | Cache maintenance interval, at least 15 seconds. |
| `DUMIFLIX_CACHE_SWEEP_IDLE_SKIP_SECONDS` | 0 | Skip disk sweeps after this idle period; 0 disables idle skipping. |
| `DUMIFLIX_CACHE_MAX_TERMINAL_JOBS` | 64 | Maximum retained completed/error/aborted in-memory download jobs. |
| `DUMIFLIX_CACHE_HASH_NAMES` | 1 | Use hashed on-disk media names; 0 enables sanitized readable names. |
| `DUMIFLIX_CATALOG_PATH` | <CACHE_ROOT>/.catalog.json | Persistent catalog metadata file. |

### Optional direct HTTP route broker

| Variable | Default | Meaning |
| --- | --- | --- |
| `DUMIFLIX_CACHE_DIRECT_HTTP` | 0 | 1 requires a verified direct-route lease for origin-to-cache transfers. |
| `DUMIFLIX_CACHE_ROUTE_BROKER_URL` | empty | Private or loopback HTTP broker base URL; no owner endpoint is supplied. |
| `DUMIFLIX_CACHE_ROUTE_BROKER_TOKEN` | empty | Shared broker authentication token; required when direct HTTP is enabled. |

### Optional torrents and season queue

| Variable | Default | Meaning |
| --- | --- | --- |
| `DUMIFLIX_TORRENT_ENABLED` | 0 | 1 enables local aria2 downloads. Keep local mode off when using a remote engine. |
| `DUMIFLIX_TORRENT_REMOTE_URL` | empty | Remote torrent control engine base URL; setting it selects remote control forwarding. |
| `DUMIFLIX_TORRENT_REMOTE_TOKEN` | empty | X-Playback-Token sent to the remote torrent engine. |
| `DUMIFLIX_TORRENT_LOOPBACK_ONLY` | 0 | 1 restricts torrent API requests to loopback clients. |
| `DUMIFLIX_PERSISTENT_TORRENT_SESSION` | /var/lib/dumiflix-aria2/aria2.session | Optional external aria2 session file inspected to report pending queue entries; missing file is allowed. |
| `DUMIFLIX_ARIA2` | aria2c | aria2 executable name on PATH or full path. |
| `DUMIFLIX_TORRENT_STAGING` | <CACHE_ROOT>/.torrents | Scratch download directory; can be a separate filesystem. |
| `DUMIFLIX_TORRENT_REQUIRE_MOUNT` | 0 | 1 refuses torrent work unless CACHE_ROOT is an active mountpoint. |
| `DUMIFLIX_TORRENT_STAGING_FLOOR_BYTES` | 4294967296 (4 GiB) | Minimum free staging bytes; clamped to at least 4 GiB. |
| `DUMIFLIX_TORRENT_MIN_VIDEO_BYTES` | 104857600 (100 MiB) | Minimum video size eligible for import. |
| `DUMIFLIX_TORRENT_CONCURRENCY` | 1 | Maximum concurrent torrent jobs, at least 1. |
| `DUMIFLIX_TORRENT_MAX_TERMINAL_JOBS` | 64 | Maximum retained terminal torrent jobs. |
| `DUMIFLIX_TORRENT_METADATA_TIMEOUT_S` | 120 | Metadata probe deadline in seconds. |
| `DUMIFLIX_TORRENT_SEQUENTIAL` | unset | 1 forces per-file sequential season-pack downloads; otherwise selected automatically. |
| `DUMIFLIX_TORRENT_SEQ_THRESHOLD` | 0.8 | Fraction of current staging free space above which multi-video packs use sequential downloads. |
| `DUMIFLIX_SEASON_SPACE_RETRY` | 300 | Seconds before retrying a season item blocked on disk space. |
| `DUMIFLIX_SEASON_MAX_TERMINAL` | 200 | Maximum terminal items retained in the persistent season queue. |
| `DUMIFLIX_SEASON_STATUS_ITEMS_MAX` | 60 | Target status response item count; active items are always included. |

### Optional Windows mpv player

| Variable | Default | Meaning |
| --- | --- | --- |
| `DUMIFLIX_MPV` | mpv | mpv executable on PATH or full path; availability requires Windows. |
| `DUMIFLIX_MPV_WATCHLATER` | ~/.dumiflix/watch-later | Directory for saved resume positions. |
| `DUMIFLIX_MPV_JOB_FILE` | ~/.dumiflix/tmp/mpv-job.json | JSON launch job consumed by the interactive scheduled task. |
| `DUMIFLIX_MPV_LAUNCH_TASK` | DumiFlixMpv | Name of the preconfigured Windows interactive-user scheduled task. |
| `DUMIFLIX_MPV_SCREEN` | default | mpv fullscreen screen selector; use a display index when needed. |
| `DUMIFLIX_MPV_AUDIO` | empty | Explicit mpv audio-device selector; empty probes Windows HDMI/digital display endpoints. |

### Optional subtitle tools

| Variable | Default | Meaning |
| --- | --- | --- |
| `DUMIFLIX_FFSUBSYNC` | ffsubsync on PATH when available | Full executable path override for ffsubsync alignment. |
| `DUMIFLIX_WHISPER_MODEL` | empty | Local ggml Whisper model path; requires an ffmpeg build with the whisper filter. |
| `DUMIFLIX_SUBGEN_ENABLED` | 1 | 0 disables subtitle generation; generation also requires a configured, present model and ffmpeg executable. |
| `DUMIFLIX_SUBGEN_MAX_SEC` | 14400 | Maximum full-file subtitle generation duration in seconds. |
| `DUMIFLIX_SUBGEN_PREVIEW_SEC` | 180 | Fast subtitle preview duration in seconds. |
| `DUMIFLIX_SUBGEN_PREVIEW_START` | 60 | Fast subtitle preview start time in seconds. |
| `DUMIFLIX_SUBSYNC_WINDOW_SEC` | 60 | Duration of each sampled alignment window in seconds. |
| `DUMIFLIX_SUBSYNC_SPACING_SEC` | 300 | Spacing between sampled windows in seconds. |
| `DUMIFLIX_SUBSYNC_EDGE_SEC` | 90 | Margin excluded at the beginning/end when choosing alignment windows. |
| `DUMIFLIX_SUBSYNC_MAX_WINDOWS` | 6 | Maximum sampled alignment windows. |
| `DUMIFLIX_SUBSYNC_MAX_WORKERS` | 4 | Maximum parallel transcription workers. |
| `DUMIFLIX_SUBSYNC_MIN_MATCHES` | 3 | Minimum text matches for an alignment window. |
| `DUMIFLIX_SUBSYNC_MAXLAG_SEC` | 60 | Maximum text alignment lag in seconds. |
| `DUMIFLIX_SUBSYNC_INLIER_TOL` | 2.5 | Minimum outlier tolerance in seconds for fitting alignment anchors. |

The engine also passes its inherited process environment to subprocesses
(including ordinary `PATH` and TLS/proxy settings). The direct-route client
explicitly ignores proxy variables for broker and origin HTTP requests.

Run the regression scripts and syntax check from the repository root:

```sh
for f in tv-service/tests/test_*.py; do python3 "$f" || exit 1; done
python3 -m py_compile tv-service/*.py
```

Some tests also execute the embedded remote-control JavaScript when Node.js is
available; those checks skip when Node.js is absent. Network tests bind loopback
ports locally and do not require a TV, pairing key, or third-party account.
