"""Launcher contract tests. No real dispatcher, package install or secrets are used."""
import fcntl
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import termios
import time
import unittest

class RunnerOptionTests(unittest.TestCase):
    def launch(self, args, saved="claude", entry="pyry-start", auth_fails=False, missing_helper=False, stale_lock=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "bin").mkdir()
            (root / "dispatcher").mkdir()
            (root / "target").mkdir()
            fake = root / "fake"
            fake.mkdir()
            shutil.copy2(Path(__file__).with_name("pyry-start"), root / "bin/pyry-start")
            shutil.copy2(Path(__file__).with_name("pyry-restart"), root / "bin/pyry-restart")
            if stale_lock:
                (root / "target/.dispatcher.lock").write_text("PID=99999999\n")
            (root / ".env").write_text("PYRY_AGENT_RUNNER=" + saved + "\n")
            scripts = {
                "pnpm": '#!/bin/sh\nprintf install > "$TEST_ROOT/install"\n',
                "automation-access": '''#!/usr/bin/env python3
import os, sys
assert sys.argv[1]=='op'
os.environ['TEST_HELPER_USED']='yes'
os.environ['OP_SERVICE_ACCOUNT_TOKEN']='test-service-token'
os.execvp('op', ['op', *sys.argv[2:]])
''',
                "op": '''#!/usr/bin/env python3
import os, sys
assert os.environ.get('TEST_HELPER_USED')=='yes', 'service-account helper bypassed'
if os.environ.get('TEST_AUTH_FAILS')=='yes':
    print('test: service-account authentication failed', file=sys.stderr)
    sys.exit(19)
args=sys.argv[1:]
command=args[args.index('--')+1:]
# Simulate op run: saved .env values replace the parent environment.
os.environ['PYRY_AGENT_RUNNER']=os.environ['TEST_SAVED_RUNNER']
os.execv(command[0],command)
''',
                "node": '''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
Path(os.environ['TEST_ROOT'],'result').write_text(json.dumps({'runner':os.environ.get('PYRY_AGENT_RUNNER'),'args':sys.argv[1:],'service_token_present':'OP_SERVICE_ACCOUNT_TOKEN' in os.environ}))
''',
                "pgrep": "#!/bin/sh\nexit 1\n",
                "sleep": "#!/bin/sh\nexit 0\n",
            }
            for name, content in scripts.items():
                p = fake / name
                p.write_text(content)
                p.chmod(0o755)
            env = dict(os.environ, PATH=str(fake) + os.pathsep + os.environ["PATH"],
                       TEST_ROOT=str(root), TEST_SAVED_RUNNER=saved,
                       TARGET_REPO_PATH=str(root / "target"), PYRY_AGENT_RUNNER="parent-value",
                       PYRY_AUTOMATION_ACCESS=str(fake / ("missing" if missing_helper else "automation-access")),
                       TEST_AUTH_FAILS="yes" if auth_fails else "no")
            # No terminal on stdin, so the launcher never touches the caller's.
            run = subprocess.run(["sh", str(root / "bin" / entry), *args], env=env,
                                 stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
            result = json.loads((root / "result").read_text()) if (root / "result").exists() else None
            return run, result, (root / "install").exists()

    def test_codex_overrides_saved_claude(self):
        run, result, _ = self.launch(["--runner", "codex"])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(result["runner"], "codex")
        self.assertFalse(result["service_token_present"])
        self.assertEqual(result["args"], ["--import", "tsx", "src/dispatch-bin.ts"])

    def test_claude_overrides_saved_codex(self):
        run, result, _ = self.launch(["--runner=claude"], saved="codex")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(result["runner"], "claude")

    def test_omitted_option_keeps_saved_setting(self):
        run, result, _ = self.launch([], saved="codex")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(result["runner"], "codex")

    def test_remaining_arguments_remain_literal(self):
        prompt = 'Use "quotes" and $(literal)'
        run, result, _ = self.launch(["--runner", "codex", "inbox", prompt])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(result["args"][-2:], ["inbox", prompt])

    def test_bad_or_missing_runner_fails_before_install(self):
        for args in [["--runner"], ["--runner", "typo"], ["--runner="]]:
            with self.subTest(args=args):
                run, result, installed = self.launch(args)
                self.assertEqual(run.returncode, 2)
                self.assertIsNone(result)
                self.assertFalse(installed)

    def test_restart_preserves_runner_and_literal_arguments(self):
        for stale in [False, True]:
            with self.subTest(stale_lock=stale):
                run, result, _ = self.launch(["--runner", "codex", "inbox", "literal $value"],
                                             entry="pyry-restart", stale_lock=stale)
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(result["runner"], "codex")
                self.assertEqual(result["args"][-2:], ["inbox", "literal $value"])

    def test_auth_failure_preserves_error_without_misleading_pid_warning(self):
        run, result, _ = self.launch([], auth_fails=True)
        self.assertEqual(run.returncode, 19, run.stderr)
        self.assertIsNone(result)
        self.assertNotIn("could not find the dispatcher's own PID", run.stderr)

    def test_missing_helper_fails_before_install(self):
        run, result, installed = self.launch([], missing_helper=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("service-account helper", run.stderr)
        self.assertIsNone(result)
        self.assertFalse(installed)

    def test_help_does_not_launch(self):
        run, result, installed = self.launch(["--help"])
        self.assertEqual(run.returncode, 0)
        self.assertIn("--runner", run.stdout)
        self.assertIsNone(result)
        self.assertFalse(installed)

class RestartKeyTests(unittest.TestCase):
    """Drive the launcher through a pseudo-terminal with real keystrokes."""

    FAKE_NODE = '''#!/usr/bin/env python3
import json, os, signal, sys, time
from pathlib import Path
root = Path(os.environ['TEST_ROOT'])
log = root / 'launches'
with log.open('a') as f:
    f.write(json.dumps({'runner': os.environ.get('PYRY_AGENT_RUNNER'), 'args': sys.argv[1:]}) + '\\n')
if len(log.read_text().splitlines()) > 1:
    sys.exit(0)
received = []
signal.signal(signal.SIGTERM, lambda *_: received.append('TERM'))
signal.signal(signal.SIGINT, lambda *_: received.append('INT'))
deadline = time.time() + 20
while time.time() < deadline:
    if received and (root / 'release').exists():
        (root / 'signals').write_text(' '.join(received))
        sys.exit(0)
    time.sleep(0.05)
sys.exit(3)
'''

    def run_with_keys(self, args, steps):
        """Start pyry-start on a pseudo-terminal. Each step waits for text, then acts."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ["bin", "dispatcher", "target", "fake"]:
                (root / name).mkdir()
            shutil.copy2(Path(__file__).with_name("pyry-start"), root / "bin/pyry-start")
            (root / ".env").write_text("PYRY_AGENT_RUNNER=claude\n")
            scripts = {
                "pnpm": "#!/bin/sh\nexit 0\n",
                "automation-access": '#!/bin/sh\nshift\nexec op "$@"\n',
                "op": '''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
command = args[args.index('--') + 1:]
os.environ['PYRY_AGENT_RUNNER'] = 'claude'
os.execv(command[0], command)
''',
                "node": self.FAKE_NODE,
                "pgrep": "#!/bin/sh\nexit 1\n",
                "sleep": "#!/bin/sh\nexit 0\n",
            }
            for name, content in scripts.items():
                path = root / "fake" / name
                path.write_text(content)
                path.chmod(0o755)
            env = dict(os.environ, PATH=str(root / "fake") + os.pathsep + os.environ["PATH"],
                       TEST_ROOT=str(root), TARGET_REPO_PATH=str(root / "target"),
                       PYRY_AUTOMATION_ACCESS=str(root / "fake/automation-access"))
            master, slave = os.openpty()
            pid = os.fork()
            if pid == 0:
                os.setsid()
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
                for fd in (0, 1, 2):
                    os.dup2(slave, fd)
                os.close(master)
                os.execve("/bin/sh", ["sh", str(root / "bin/pyry-start"), *args], env)
            output = bytearray()
            status = None
            deadline = time.time() + 30

            def pump():
                nonlocal status
                ready, _, _ = select.select([master], [], [], 0.05)
                if ready:
                    output.extend(os.read(master, 4096))
                if status is None:
                    done, code = os.waitpid(pid, os.WNOHANG)
                    if done:
                        status = os.waitstatus_to_exitcode(code)

            try:
                for wait_for, action in steps:
                    while wait_for.encode() not in output:
                        self.assertLess(time.time(), deadline, output.decode(errors="replace"))
                        self.assertIsNone(status, output.decode(errors="replace"))
                        pump()
                    action(root, master)
                while status is None:
                    self.assertLess(time.time(), deadline, output.decode(errors="replace"))
                    pump()
                pump()
                lflag = termios.tcgetattr(master)[3]
            finally:
                if status is None:
                    os.kill(pid, 9)
                    os.waitpid(pid, 0)
                os.close(master)
                os.close(slave)
            launches = [json.loads(line) for line in (root / "launches").read_text().splitlines()]
            signals = (root / "signals").read_text() if (root / "signals").exists() else ""
            return (status, output.decode(errors="replace"), launches, signals,
                    (root / "target/.dispatcher.lock").exists(), lflag)

    @staticmethod
    def key(byte):
        return lambda root, master: os.write(master, byte)

    @staticmethod
    def release(root, master):
        (root / "release").write_text("")

    def test_ctrl_r_drains_then_starts_again_with_same_arguments(self):
        status, output, launches, signals, locked, lflag = self.run_with_keys(
            ["--runner", "codex", "inbox", "literal $value"],
            [("Ctrl-R drains and restarts", self.release),
             ("Ctrl-R drains and restarts", self.key(b"\x12"))])
        self.assertEqual(status, 0, output)
        self.assertIn("Restart requested", output)
        self.assertIn("Starting again", output)
        self.assertEqual(signals, "TERM")
        self.assertEqual(len(launches), 2, output)
        for launch in launches:
            self.assertEqual(launch["runner"], "codex")
            self.assertEqual(launch["args"][-2:], ["inbox", "literal $value"])
        self.assertFalse(locked)
        self.assertTrue(lflag & termios.ICANON and lflag & termios.ECHO, "terminal mode not restored")

    def test_ctrl_c_after_ctrl_r_cancels_the_restart(self):
        status, output, launches, signals, locked, lflag = self.run_with_keys(
            [],
            [("Ctrl-R drains and restarts", self.key(b"\x12")),
             ("Restart requested", self.key(b"\x03")),
             ("Restart cancelled", self.release)])
        self.assertEqual(status, 0, output)
        self.assertEqual(len(launches), 1, output)
        self.assertTrue(signals.startswith("TERM INT"), signals)
        self.assertNotIn("Starting again", output)
        self.assertFalse(locked)
        self.assertTrue(lflag & termios.ICANON and lflag & termios.ECHO, "terminal mode not restored")

if __name__ == "__main__":
    unittest.main()
