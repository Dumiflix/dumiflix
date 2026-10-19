"""Exercise guard functions with mocked device commands; never touch the TV."""

from pathlib import Path
import subprocess
import tempfile
import unittest


GUARD = Path(__file__).resolve().parents[1] / "70-dumiflix-memory-guard"


class HdmiPreservationTest(unittest.TestCase):
    def run_functions(self, calls):
        source, dispatcher = GUARD.read_text().split('\ncase "${1:-start}" in\n')
        self.assertIn("watch_guard", dispatcher)
        with tempfile.TemporaryDirectory() as work:
            # Functions override all device operations used by these tests.
            script = source + r'''
LOGFILE=/dev/null
exec 3>&1
systemctl() { printf 'systemctl %s\n' "$*" >&3; }
pidof() {
    case "$1" in
        utp-dvb) echo 424242 ;;
        admanager) echo 424243 ;;
    esac
}
kill() { printf 'kill %s\n' "$*" >&3; }
''' + calls
            result = subprocess.run(
                ["/bin/sh", "-c", script], cwd=work,
                text=True, capture_output=True, check=True,
            )
            return result.stdout

    def test_shell_syntax(self):
        subprocess.run(["/bin/sh", "-n", str(GUARD)], check=True)

    def test_optional_suppression_never_stops_hdmi_services(self):
        output = self.run_functions("suppress_optional_units\n")
        self.assertIn("systemctl --no-block stop iepg.service", output)
        self.assertIn("systemctl --no-block stop voiceinput.service", output)
        for service in ("utp.service", "extinput-integration.service",
                        "videooutputd.service", "sam.service"):
            self.assertNotIn(service, output)

    def test_process_suppression_leaves_utp_running(self):
        output = self.run_functions("suppress_optional_processes\n")
        self.assertIn("kill 424243", output)  # advertising remains suppressed
        self.assertNotIn("kill 424242", output)  # UTP remains alive


if __name__ == "__main__":
    unittest.main()
