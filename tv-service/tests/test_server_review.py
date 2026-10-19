"""HTTP regressions from the laptop-engine review."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

_ROOT = tempfile.TemporaryDirectory()
os.environ['DUMIFLIX_CACHE_ROOT'] = _ROOT.name
os.environ['DUMIFLIX_LOG_DIR'] = _ROOT.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cache
import server


def handler(method='GET', byte_range=None):
    h = server.Handler.__new__(server.Handler)
    h.command = method
    h.path = '/cache/growing/movie.mkv'
    h.headers = {'Range': byte_range} if byte_range is not None else {}
    h.wfile = io.BytesIO()
    h.rfile = io.BytesIO()
    h.close_connection = False
    h.send_response = mock.Mock()
    h.send_header = mock.Mock()
    h.end_headers = mock.Mock()
    return h


class ServerReviewTests(unittest.TestCase):
    def test_completed_and_growing_ranges(self):
        target = Path(_ROOT.name) / 'movie.mkv'
        source = b'0123456789abcdef'
        target.write_bytes(source)
        ready = {'state': 'ready', 'total': len(source), 'path': str(target)}
        cases = [('bytes=-8', 206, source[-8:], 'bytes 8-15/16'),
                 ('bytes=-99', 206, source, 'bytes 0-15/16'),
                 ('bytes=3-', 206, source[3:], 'bytes 3-15/16'),
                 ('bytes=3-99', 206, source[3:], 'bytes 3-15/16'),
                 ('bytes=16-', 416, b'', 'bytes */16'),
                 ('bytes=10-3', 416, b'', 'bytes */16'),
                 ('bytes=-0', 416, b'', 'bytes */16'),
                 ('bytes=abc-def', 416, b'', 'bytes */16')]
        for route in ('completed', 'fallback', 'growing'):
            for method in ('GET', 'HEAD'):
                for value, status, body, content_range in cases:
                    with self.subTest(route=route, method=method, value=value):
                        h = handler(method, value)
                        with mock.patch.object(cache, 'job_for_rel', return_value=(ready if route == 'growing' else None)), \
                                mock.patch.object(cache, 'stream_target', return_value=target):
                            if route == 'completed':
                                h._stream_file(target, head_only=method == 'HEAD')
                            else:
                                h._stream_growing_cache(target.name, head_only=method == 'HEAD')
                        h.send_response.assert_called_once_with(status)
                        self.assertEqual(h.wfile.getvalue(), b'' if method == 'HEAD' else body)
                        h.send_header.assert_any_call('Content-Range', content_range)
                        h.send_header.assert_any_call('Content-Length', str(len(body)))

    def test_head_json_errors_never_write_body(self):
        for job, status in ((None, 404), ({'state': 'started'}, 409),
                            ({'state': 'ready', 'total': 0}, 409)):
            with self.subTest(status=status, job=job):
                h = handler('HEAD')
                with mock.patch.object(cache, 'job_for_rel', return_value=job), \
                        mock.patch.object(cache, 'stream_target', return_value=None), \
                        mock.patch.object(cache, 'progressive_ready', return_value=False):
                    h._stream_growing_cache('missing', head_only=True)
                h.send_response.assert_called_once_with(status)
                self.assertEqual(h.wfile.getvalue(), b'')
                headers = dict(call.args for call in h.send_header.call_args_list)
                self.assertGreater(int(headers['Content-Length']), 0)

    def test_gap_wait_resets_on_received_or_range_progress(self):
        for progress in ('received', 'ranges'):
            with self.subTest(progress=progress):
                h = handler(byte_range='bytes=12-15')
                path = Path(_ROOT.name) / 'gap.mkv.part'
                path.write_bytes(b'0123456789abcdef')
                job = {'state': 'downloading', 'total': 16, 'received': 4,
                       '_head_end': 4, '_progressive_ready': True}
                clock = [0.0]

                def advance(seconds):
                    clock[0] += seconds
                    if progress == 'received':
                        job['received'] += 1
                        if job['received'] >= 16:
                            job['_head_end'] = 16
                    else:
                        job['_head_end'] += 1

                with mock.patch.object(cache, 'progressive_ready', return_value=True), \
                        mock.patch.object(cache, 'job_for_rel', return_value=job), \
                        mock.patch.object(cache, 'growing_target', return_value=path), \
                        mock.patch.object(server, 'GROWING_NO_PROGRESS_SECONDS', 0.1), \
                        mock.patch.object(server.time, 'monotonic', side_effect=lambda: clock[0]), \
                        mock.patch.object(server.time, 'sleep', side_effect=advance):
                    h._stream_growing_cache('gap.mkv')
                self.assertGreater(clock[0], 0.1)
                self.assertEqual(h.wfile.getvalue(), b'cdef')
                self.assertFalse(h.close_connection)

    def test_gap_wait_ends_on_stall_failure_and_cancel(self):
        for terminal in ('stall', 'error', 'aborted', 'cancel'):
            with self.subTest(terminal=terminal):
                h = handler(byte_range='bytes=12-15')
                job = {'state': 'downloading', 'total': 16, 'received': 4,
                       '_head_end': 4, '_progressive_ready': True}
                clock = [0.0]

                def advance(seconds):
                    clock[0] += seconds
                    if terminal == 'cancel':
                        job['_cancel'] = True
                    elif terminal != 'stall':
                        job['state'] = terminal

                with mock.patch.object(cache, 'progressive_ready', return_value=True), \
                        mock.patch.object(cache, 'job_for_rel', return_value=job), \
                        mock.patch.object(server, 'GROWING_NO_PROGRESS_SECONDS', 0.1), \
                        mock.patch.object(server.time, 'monotonic', side_effect=lambda: clock[0]), \
                        mock.patch.object(server.time, 'sleep', side_effect=advance):
                    h._stream_growing_cache('gap.mkv')
                self.assertTrue(h.close_connection)
                self.assertEqual(h.wfile.getvalue(), b'')
                self.assertLess(clock[0], 0.2)

    def test_error_logs_redact_all_query_tokens(self):
        for action in ('unauthorized', 'reply'):
            h = handler()
            h.path = '/player/open?token=first-secret&x=ok&to%6ben=second-secret&TOKEN=third-secret'
            log = io.StringIO()
            with contextlib.redirect_stderr(log):
                if action == 'unauthorized':
                    h._unauthorized()
                else:
                    h._reply({'status': 409, 'error': 'failed'})
            for secret in ('first-secret', 'second-secret', 'third-secret'):
                self.assertNotIn(secret, log.getvalue())
            self.assertIn('/player/open?', log.getvalue())
            self.assertIn('x=ok', log.getvalue())

    @unittest.skipUnless(shutil.which('node'), 'Node.js needed for remote JS execution')
    def test_remote_treats_title_rel_and_codec_as_text(self):
        script = re.search(r'<script>(.*?)</script>', server._REMOTE_HTML, re.S).group(1)
        self.assertNotIn('innerHTML', script)
        for field in ('title', 'rel', 'audioCodec'):
            payload = {'running': True, 'pos': 1, 'dur': 10,
                       field: '<img src=x onerror="stealToken()">'}
            harness = '''
const vm = require('vm');
const assert = require('assert');
const nodes = {};
const document = {getElementById(id) {
  return nodes[id] || (nodes[id] = {style: {}, textContent: '',
    set innerHTML(value) { throw Error('HTML sink used'); }});
}};
const data = PAYLOAD;
vm.runInNewContext(SCRIPT, {document, location: {search: '?token=secret'},
  URLSearchParams, setInterval() {}, fetch() {
    return Promise.resolve({json() { return Promise.resolve(data); }});
  }});
setImmediate(() => assert(nodes.st.textContent.includes(data[FIELD])));
'''.replace('PAYLOAD', json.dumps(payload)).replace('SCRIPT', json.dumps(script)).replace('FIELD', json.dumps(field))
            result = subprocess.run(['node'], input=harness, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
