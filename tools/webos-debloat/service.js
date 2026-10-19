'use strict';

const fs = require('fs');
const Service = require('webos-service');

const SERVICE_ID = 'org.webosbrew.hbchannel.service.dumiflixguard';
const LG_CHANNELS_ID = 'com.webos.app.lgchannels';
const RESULT_PATH = '/tmp/dumiflix-memory-guard.close.json';
const service = new Service(SERVICE_ID);

let finished = false;

function finish(result, exitCode = 0) {
  if (finished) return;
  finished = true;
  const record = {
    requestedAt: new Date().toISOString(),
    ...result,
  };
  try {
    fs.writeFileSync(RESULT_PATH, `${JSON.stringify(record)}\n`);
  } catch (_) {}
  process.stdout.write(`${record.requestedAt} ${JSON.stringify(result)}\n`);
  setTimeout(() => process.exit(exitCode), 50);
}

try {
  service.call(
    'luna://com.webos.applicationManager/closeByAppId',
    { id: LG_CHANNELS_ID },
    (message) => {
      const payload = message && message.payload ? message.payload : {};
      if (payload.returnValue === false && payload.errorText === 'app is not running') {
        finish({ ok: true, alreadyClosed: true, payload });
      } else if (payload.returnValue === false) {
        finish({ ok: false, payload }, 1);
      } else {
        finish({ ok: true, payload });
      }
    },
  );
} catch (error) {
  finish({ ok: false, error: error.message }, 1);
}

setTimeout(() => finish({ ok: false, error: 'SAM close timed out' }, 1), 5000);
