# Reducing background activity on webOS

## Start without root

Review the TV's privacy and advertising settings. Turn off ad or automatic content recognition (ACR) features such as **Live Plus**, home-screen promotions, and content recommendations where available. Review the user agreements and decline optional data collection you do not want. Menu names and paths vary by webOS version and region; use the descriptions shown on the TV rather than assuming a fixed path.

These settings are a useful first step. The optional rooted helper below changes running services and can disable features you use.

## What the rooted tool does

The [DumiFlix memory guard](../tools/webos-debloat/) aims to leave more memory available for streaming apps by stopping background preloading and selected optional services. It runs a shell watcher every three seconds and starts a short-lived Node helper only when it detects an LG Channels renderer. That helper asks SAM (`com.webos.applicationManager/closeByAppId`) to close `com.webos.app.lgchannels`.

The profile suppresses:

| Area | Units or processes targeted | Effect |
| --- | --- | --- |
| Background preloading | `preload-manager.service` | Keeps the shared preload manager stopped to prevent LG Channels preloading; other apps such as YouTube lose background prewarming but remain launchable on demand. |
| Second-screen gateway | `second-screen-gateway.service`, `ssdp-discovery-lgtv.service`; `ss.gateway`, `ssdp-discovery-lgtv` | Disables these mobile/second-screen services. A bind-mounted Luna definition with `Exec=/bin/false` also prevents gateway reactivation. |
| ThinQ and voice | `voiceconductor.service`, `voiceinput.service`; `voiceconductor`, `voiceinput`, `voiceinput_hidraw`, `voiceinput_network`, `nlpmanager`, `lg.thinqai.adapter` | Stops these voice/ThinQ components; related features may be unavailable. |
| Optional broadcast and EPG | `iepg.service`, `broadcast-channel-mixer.service`, `broadcast-conf-downloader.service`, `broadcast-systemui-manager.service`, `db8-epgdb.service`; `iepg`, `broadcast-configd`, `broadcast-channel-mixer`, `broadcast-conf-downloader`, `broadcast-systemui-manager` | Stops these broadcast/guide components; live broadcast and guide features may be affected. |
| Advertising | `admanager` | Terminates the advertising manager process when present. |

Systemd units and named processes are checked repeatedly. Service and process names vary by model and firmware. Before relying on this list, inspect your TV in a root shell:

```sh
systemctl list-units --all --type=service
ps
```

The script uses `pidof` with the listed names; inspect matching processes before running it. It does not verify executable paths for these optional processes. Its renderer detection separately checks `/usr/bin/WebAppMgr` and the app ID. The profile is not a universal list of safe-to-disable services, and no fixed memory saving is guaranteed.

## Preserve HDMI and shared TV features

**Never stop `utp.service` or kill `utp-dvb`.** Despite their broadcast-sounding names, they also own HDMI external inputs (`com.webos.service.utp.extinputs`), display, and sound. Stopping them breaks HDMI inputs. Do not add them to either suppression list.

The tool deliberately keeps HDMI/UTP, AirPlay, UPnP/DLNA, Chromecast, and the screen saver. It also leaves core context/orchestration services alone. This is the intended profile, not a guarantee of feature compatibility on every firmware.

If an earlier helper stopped UTP, run this in the TV shell to restore it:

```sh
systemctl start utp.service
```

## Install and operate

Root and Homebrew Channel are required; see [Rooted TVs](../README.md#rooted-tvs-optional) for how to root. Read the script and the service list before installing. Follow the [tool's copy-and-install steps](../tools/webos-debloat/README.md#install) to place its support files in `/var/lib/webosbrew/dumiflix-memory-guard/` and its executable startup hook in `/var/lib/webosbrew/init.d/`.

In a TV root shell:

```sh
chmod +x /var/lib/webosbrew/init.d/70-dumiflix-memory-guard
/var/lib/webosbrew/init.d/70-dumiflix-memory-guard start
/var/lib/webosbrew/init.d/70-dumiflix-memory-guard status
```

Homebrew Channel runs the executable hook at subsequent boots. `status` reports whether the recorded watcher PID is running; it does not certify that every suppression succeeded. Inspect runtime details and errors:

```sh
cat /tmp/dumiflix-memory-guard.status.json
tail -n 50 /var/log/dumiflix-memory-guard.log
```

| File | Purpose |
| --- | --- |
| `/tmp/dumiflix-memory-guard.status.json` | Periodic JSON with renderer PIDs, preload state, retained/suppressed groups, and the latest close result. |
| `/var/log/dumiflix-memory-guard.log` | Watcher, service, override, and helper output. |
| `/tmp/dumiflix-memory-guard.pid` | Watcher PID. |
| `/tmp/dumiflix-memory-guard.close.json` | Latest SAM close result. |
| `/tmp/dumiflix-memory-guard.cgroup` | Runtime file used by the Node service launcher. |

## Rollback and uninstall

`stop` ends the watcher, starts the preload manager and every unit in the suppression list again, and removes the gateway override, then asks Luna Service Hub to rescan the original service definition. Units in the list are started even if they were not running before the guard started. Processes that were terminated are not relaunched immediately; Luna services become available for normal on-demand activation. Check that the features you need are back afterwards.

```sh
/var/lib/webosbrew/init.d/70-dumiflix-memory-guard stop
```

Leaving the executable hook installed enables the guard again at the next boot. To uninstall, stop the guard first, then remove the hook and its support directory in the TV root shell:

```sh
/var/lib/webosbrew/init.d/70-dumiflix-memory-guard stop
rm /var/lib/webosbrew/init.d/70-dumiflix-memory-guard
rm -r /var/lib/webosbrew/dumiflix-memory-guard
```

Do not delete the support files while the gateway override is still mounted. If `grep secondscreen.gateway /proc/mounts` still shows it after `stop`, run `stop` again before removing files. The override never changes the firmware's original service definition.

## Offline tests

From the repository root on your computer:

```sh
python3 -m unittest discover -s tools/webos-debloat/tests -v
sh -n tools/webos-debloat/70-dumiflix-memory-guard
```

The tests mock device commands and check shell syntax and that HDMI/UTP services are never stopped. They never connect to a TV and do not establish compatibility with a particular firmware.
