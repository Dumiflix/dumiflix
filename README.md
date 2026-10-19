# DumiFlix

DumiFlix is a webOS TV app for browsing and playing media through Seedr, with optional laptop caching and a Python laptop engine. The TV interface works with a remote control and brings browsing, playback, subtitles, a library, and download queues together.

## Features

- Movie and TV browsing, search, and TMDB discovery rows.
- Seedr account integration for fetching and streaming media.
- Remote-friendly playback controls, subtitle selection, and OpenSubtitles integration.
- Google Drive library integration through the bundled webOS Node service.
- Optional laptop caching, episode queues, and FFmpeg remuxing or transcoding.
- Optional mpv playback on a Windows laptop and LG SSAP control through the engine.
- Live TV, file browsing, and music views; some integrations need separately configured services.

## Architecture and layout

The TV app runs the interface and playback logic. It talks to media and metadata services, while its bundled Node service handles Drive uploads and a local authenticated playback proxy. The optional Python engine runs on a laptop reachable by the TV and provides cache management, media processing, and playback support. Basic Seedr streaming does not require the laptop engine.

```text
tv-app/                  webOS HTML, CSS, and JavaScript application
  js/                    Service integrations and playback helpers
  service/               Bundled webOS Node service
tv-app-tests/            Deno regression tests for TV app behavior
tv-service/              Optional Python engine and LG SSAP client
  tests/                 Python engine tests
  README.md              Engine setup and configuration
  env.example            Engine environment template
```

## Requirements

- An LG webOS TV with Developer Mode enabled, or an existing Homebrew Channel setup.
- A computer with the webOS TV CLI (`ares-package`, `ares-install`, and related tools) and its required Node.js runtime.
- Network access from the TV to the services you configure, and a Seedr account for Seedr playback.
- Your own credentials for optional TMDB, OpenSubtitles, and Google Drive integrations.
- For the optional engine: Python 3.12 or newer, disk space for caching, and FFmpeg/ffprobe for media processing. mpv and aria2 are needed only for features that use them; see the engine setup below.
- For tests: Deno and Python 3.12 or newer.

## Build and install the TV app

Run this from the repository root to package the app and its Node service together:

```sh
mkdir -p out
ares-package tv-app tv-app/service -o out
```

### Developer Mode

Follow LG's [Developer Mode setup guide](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app) to enable Developer Mode and the Key Server on the TV. Configure a device profile named `tv` with your TV's address and the connection settings from that guide:

```sh
ares-setup-device
ares-novacom --device tv --getkey
```

Enter the passphrase shown on the TV when prompted. Install the generated IPK, then launch the app:

```sh
ares-install --device tv out/com.dumiflix.tv_*.ipk
ares-launch --device tv com.dumiflix.tv
```

Keep only the package you intend to install in `out/` so the wildcard selects one file. Keep the Developer Mode session active as described by LG.

### Homebrew Channel

On a TV with Homebrew Channel already installed, its service can install a package from a reachable URL using the package's SHA-256 hash. Host your built IPK at a URL accessible to the TV, compute its hash, and run the following in a TV shell, replacing the example URL and hash:

```sh
luna-send -i -f luna://org.webosbrew.hbchannel.service/install '{"ipkUrl":"https://example.com/dumiflix.ipk","ipkHash":"<PACKAGE_SHA256>"}'
```

See the webOS Homebrew Project's [installation commands](https://www.webosbrew.org/pages/commands-cheatsheet) for details. Launch DumiFlix from the TV's app list after installation.

## Rooted TVs (optional)

Root is optional for DumiFlix. To root an LG webOS TV, follow the [RootMyTV project](https://github.com/RootMyTV/RootMyTV.github.io). Its original exploit was patched in 2022, so check which method supports your model and firmware at [cani.rootmy.tv](https://cani.rootmy.tv) first. Rooting carries a risk of damaging your TV's software; read the project's warnings before you start.

On a rooted TV, the [debloat guide](docs/DEBLOAT.md) covers settings and optional service suppression using the [rooted-TV tool](tools/webos-debloat/).

## Configure the app

Open **Settings** on the TV and sign in with your own Seedr account. No personal keys or credentials ship with this repository. Supply your own credentials for the integrations you want to use:

- **TMDB:** enter your API Read Access Token for discovery and trending rows.
- **OpenSubtitles:** enter your own API key for subtitle searches and downloads.
- **Google Drive:** use your own Google OAuth client ID and client secret for the **TVs and Limited Input devices** client type. Enter both in **Settings → Google Drive**, then follow the sign-in flow. The app stores these credentials locally on the TV.

For laptop features, configure the engine's reachable host and matching playback token in Settings. Use your own addresses and credentials, and keep local configuration files out of version control.

## Optional companion services (not included)

The qBittorrent and music relay, phone file server, and Bluetooth audio controls each require a separate companion service that is not included in this repository. Configure the corresponding service and its connection settings separately. The relay and phone file server default to port `5052`. The HDMI laptop player is included in the optional engine as a Windows mpv adapter; follow the engine setup guide to configure it.

## Run the optional laptop engine

Start with [the engine setup guide](tv-service/README.md) and [the environment template](tv-service/env.example) for the full configuration reference and platform-specific requirements.

The engine reads configuration from process environment variables; it does not load an environment file automatically. By default it listens on loopback port `9891`, has caching disabled, and looks for FFmpeg/ffprobe in `tv-service/bin/`. For a laptop with FFmpeg and ffprobe installed on `PATH`, run this from the repository root after replacing the token placeholder with a strong private value:

```sh
export DUMIFLIX_FFMPEG="$(command -v ffmpeg)"
export DUMIFLIX_FFPROBE="$(command -v ffprobe)"
export DUMIFLIX_TV_BIND=0.0.0.0
export DUMIFLIX_TV_TOKEN='<YOUR_PLAYBACK_TOKEN>'
export DUMIFLIX_CACHE_ENABLED=1
export DUMIFLIX_CACHE_ROOT="$HOME/dumiflix-cache"
python3 tv-service/server.py
```

This listens on all laptop interfaces so the TV can connect. Restrict access to your trusted local network and keep the token private. In the TV app's Settings, configure the laptop engine host as `<LAPTOP_HOST>:9891` and use the same playback token. Keep cache storage and local configuration outside the source tree.

Optional direct torrent downloads require `aria2c` on `PATH` and `DUMIFLIX_TORRENT_ENABLED=1`. Optional laptop playback uses the Windows mpv adapter and requires an interactive-user scheduled task as described in the engine setup guide. To pair LG SSAP control, run `python3 tv-service/webos_ssap.py pair tv.local` with your TV's address and accept the prompt on the TV; the resulting `tv-service/.webos.json` is private pairing state.

The engine is optional for direct Seedr playback. Laptop caching, media processing, and laptop playback require the corresponding engine features and tools to be configured.

## Tests

Run from the repository root:

```sh
deno test --allow-read --allow-env tv-app-tests/
```

```sh
for f in tv-service/tests/test_*.py; do python3 "$f" || exit 1; done
```

The optional debloat tool has offline tests:

```sh
python3 -m unittest discover -s tools/webos-debloat/tests -v
```

## License and disclaimer

Released under the [MIT License](LICENSE). See [Third-party notices](THIRD_PARTY_NOTICES.md) for included components and external data service terms. Use DumiFlix only for content you have the right to access. DumiFlix is not affiliated with LG, Seedr, TMDB, OpenSubtitles, YTS, or any streaming service. The software is provided as-is, without warranty.
