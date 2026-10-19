// Bluetooth audio control for devices that have already been paired in the
// TV's own Settings app.  btaudiosrc is the high-level service LG Settings
// itself uses: unlike the lower-level bluetooth2 profile API, it also switches
// the TV's active sound output when a device connects.

const BluetoothAudio = (() => {
  // LG's WebAppMgr sandbox rejects private btaudiosrc calls even when the
  // packaged app requests bluetooth.manage. Route the three whitelisted
  // operations through a separately installed helper service on a rooted TV.
  // This helper service is not included in this repository.
  const SERVICE = 'luna://com.dumiflix.bluetooth/';
  const CALL_TIMEOUT_MS = 12000;
  const activeBridges = [];

  function makeError(message, code) {
    const err = new Error(message || 'Bluetooth audio request failed');
    err.code = code || 'bluetooth-audio';
    return err;
  }

  function removeBridge(bridge) {
    const i = activeBridges.indexOf(bridge);
    if (i >= 0) activeBridges.splice(i, 1);
  }

  function call(method, params) {
    return new Promise((resolve, reject) => {
      if (typeof PalmServiceBridge === 'undefined') {
        reject(makeError('Bluetooth controls are only available on the TV.', 'unsupported'));
        return;
      }

      let bridge;
      let timer;
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        removeBridge(bridge);
        fn(value);
      };

      try {
        bridge = new PalmServiceBridge();
        // Keep the bridge strongly referenced until webOS invokes the callback.
        // Some older webOS WebKit builds otherwise collect one-shot bridges.
        activeBridges.push(bridge);
        bridge.onservicecallback = (message) => {
          let result;
          try {
            result = JSON.parse(message || '{}');
          } catch (_) {
            finish(reject, makeError('The TV returned an invalid Bluetooth response.', 'invalid-response'));
            return;
          }
          if (result && result.returnValue !== false) {
            finish(resolve, result);
            return;
          }
          const text = (result && (result.errorText || result.errorMessage))
            || 'The TV rejected the Bluetooth request.';
          finish(reject, makeError(text, result && result.errorCode));
        };
        bridge.call(SERVICE + method, JSON.stringify(params || {}));
        timer = setTimeout(() => {
          finish(reject, makeError('The TV did not answer the Bluetooth request.', 'timeout'));
        }, CALL_TIMEOUT_MS);
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  function cleanName(name) {
    // LG appends the final Bluetooth address byte to display names, e.g.
    // "Example Headphones(01)" for address 00:00:5E:00:53:01. Strip only
    // the two-hex-digit suffix;
    // preserve ordinary parentheses in user-assigned device names.
    return String(name || 'Bluetooth audio device').replace(/\s*\([0-9a-f]{2}\)$/i, '');
  }

  function normalizeDevice(device) {
    const state = String(device.state || (device.connected ? 'connected' : 'disconnected')).toLowerCase();
    return {
      address: String(device.address || device.deviceAddress || ''),
      name: cleanName(device.name || device.deviceName),
      state,
      connected: state === 'connected',
      busy: state === 'connecting' || state === 'disconnecting',
      type: device.type || '',
      volume: Number.isFinite(Number(device.deviceVolume)) ? Number(device.deviceVolume) : null,
      raw: device,
    };
  }

  async function list() {
    const result = await call('control', { action: 'list' });
    const raw = result.devices || result.pairedDevices || result.deviceList || [];
    return (Array.isArray(raw) ? raw : [])
      .map(normalizeDevice)
      .filter(device => device.address && (!device.type || device.type === 'bt_audio'));
  }

  function connect(address) {
    return call('control', { action: 'connect', address: String(address || '') });
  }

  function disconnect(address) {
    return call('control', { action: 'disconnect', address: String(address || '') });
  }

  async function waitForState(address, shouldBeConnected, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 16000);
    let lastDevices = [];
    do {
      lastDevices = await list();
      const device = lastDevices.find(item => item.address.toLowerCase() === String(address).toLowerCase());
      if (device && device.connected === !!shouldBeConnected && !device.busy) return lastDevices;
      await new Promise(resolve => setTimeout(resolve, 600));
    } while (Date.now() < deadline);

    const err = makeError(
      shouldBeConnected ? 'The TV is still trying to connect.' : 'The TV is still trying to disconnect.',
      'state-timeout'
    );
    err.devices = lastDevices;
    throw err;
  }

  return { list, connect, disconnect, waitForState, cleanName };
})();
