# DumiFlix memory guard

Optional rooted-webOS helper that suppresses LG Channels preloading and selected background services. Read the [debloat guide](../../docs/DEBLOAT.md) for the service list, tradeoffs, runtime files, and rollback details. **Never suppress `utp.service` or `utp-dvb`: they provide HDMI inputs, display, and sound.** Root and Homebrew Channel are required; see [Rooted TVs](../../README.md#rooted-tvs-optional) for how to root.

## Install

From the repository root on your computer, replace `<TV_IP>` with your TV's address. These commands use root SSH on port 22; configure keys first as described in the rooting guide.

```sh
ssh -p 22 "root@<TV_IP>" 'mkdir -p /var/lib/webosbrew/dumiflix-memory-guard/disabled-services /var/lib/webosbrew/init.d'
scp -P 22 tools/webos-debloat/service.js tools/webos-debloat/package.json "root@<TV_IP>:/var/lib/webosbrew/dumiflix-memory-guard/"
scp -P 22 tools/webos-debloat/disabled-services/com.webos.service.secondscreen.gateway.service "root@<TV_IP>:/var/lib/webosbrew/dumiflix-memory-guard/disabled-services/"
scp -P 22 tools/webos-debloat/70-dumiflix-memory-guard "root@<TV_IP>:/var/lib/webosbrew/init.d/"
```

If replacing an installed copy, run its `stop` command and require success before copying. In a TV root shell:

```sh
chmod +x /var/lib/webosbrew/init.d/70-dumiflix-memory-guard
/var/lib/webosbrew/init.d/70-dumiflix-memory-guard start
/var/lib/webosbrew/init.d/70-dumiflix-memory-guard status
```

The executable hook runs at boot. Status JSON is at `/tmp/dumiflix-memory-guard.status.json`; logs are at `/var/log/dumiflix-memory-guard.log`.

## Stop and uninstall

In the TV root shell, `stop` ends the watcher, starts the preload manager and every unit in the suppression list again, and removes its gateway override so Luna services can activate normally:

```sh
/var/lib/webosbrew/init.d/70-dumiflix-memory-guard stop
```

`stop` starts the listed units even if they were not running before the guard started. Check that the features you need are back before uninstalling:

```sh
/var/lib/webosbrew/init.d/70-dumiflix-memory-guard stop &&
    rm /var/lib/webosbrew/init.d/70-dumiflix-memory-guard &&
    rm -r /var/lib/webosbrew/dumiflix-memory-guard
```

## Offline checks

Run on your computer from the repository root:

```sh
python3 -m unittest discover -s tools/webos-debloat/tests -v
sh -n tools/webos-debloat/70-dumiflix-memory-guard
```

Released under the repository's [MIT License](../../LICENSE), by The DumiFlix contributors.
