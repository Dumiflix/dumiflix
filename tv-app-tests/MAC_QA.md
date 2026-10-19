# DumiFlix Mac QA simulator

This harness serves the production TV app unchanged, injects machine-local
credentials at runtime, and proxies the real laptop backend through localhost.
That localhost hop is required because desktop Chromium blocks a public-origin
page from directly reaching a private-LAN backend. Credentials are never
printed or committed.

Start it from the repository root:

```sh
node tv-app-tests/mac-qa-server.mjs \
  --laptop http://192.0.2.10:9891 \
  --run-script /path/to/laptop-run.ps1 \
  --seedr-config /path/to/seedr-config.json
```

Then open <http://127.0.0.1:8766/?qaReset=1>. `qaReset=1` clears only the
simulator's local queue and Continue Watching state; it does not delete laptop
cache files or Seedr content. Omit it when testing persistence.

Useful options are listed by `node tv-app-tests/mac-qa-server.mjs
--help`.

Desktop Chromium does not natively play HLS `.m3u8` streams, while webOS does.
The simulator can still validate Live discovery, filtering, pagination and
manifest reachability; native-HLS decoding remains a TV/device test.
