import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error


spec = importlib.util.spec_from_file_location("vm_monitor", Path(__file__).with_name("check-vm.py"))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class ReachabilityTest(unittest.TestCase):
    def test_ping_success_needs_no_tcp(self):
        with patch.object(monitor.subprocess, "run", return_value=Mock(returncode=0)), \
                patch.object(monitor.socket, "create_connection") as tcp:
            self.assertTrue(monitor.reachable(monitor.HOST))
            tcp.assert_not_called()

    def test_tcp_fallback_and_refusal_mean_host_responds(self):
        with patch.object(monitor.subprocess, "run", return_value=Mock(returncode=1)), \
                patch.object(monitor.socket, "create_connection") as tcp:
            tcp.side_effect = [socket.timeout(), Mock(__enter__=Mock(), __exit__=Mock(return_value=False))]
            self.assertTrue(monitor.reachable(monitor.HOST))
            self.assertEqual(tcp.call_args_list[1].args[0], (monitor.HOST, 443))
        with patch.object(monitor.subprocess, "run", side_effect=subprocess.TimeoutExpired("ping", 5)), \
                patch.object(monitor.socket, "create_connection", side_effect=ConnectionRefusedError()):
            self.assertTrue(monitor.reachable(monitor.HOST))

    def test_three_failures_required_and_transient_failure_is_ignored(self):
        with patch.object(monitor, "reachable", side_effect=[False, False, True]) as probe, \
                patch.object(monitor.time, "sleep") as sleep:
            self.assertTrue(monitor.confirmed_reachable(monitor.HOST))
            self.assertEqual(probe.call_count, 3)
            self.assertEqual(sleep.call_count, 2)
        with patch.object(monitor, "reachable", return_value=False) as probe, \
                patch.object(monitor.time, "sleep"):
            self.assertFalse(monitor.confirmed_reachable(monitor.HOST))
            self.assertEqual(probe.call_count, 3)

    def test_all_network_probes_fail(self):
        with patch.object(monitor.subprocess, "run", return_value=Mock(returncode=1)), \
                patch.object(monitor.socket, "create_connection", side_effect=socket.timeout()) as tcp:
            self.assertFalse(monitor.reachable(monitor.HOST))
            self.assertEqual(tcp.call_count, 3)


class AlertStateTest(unittest.TestCase):
    def test_initial_health_is_silent_and_outage_not_repeated_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            send = Mock()
            monitor.check(path, probe=lambda _: True, send=send)
            send.assert_not_called()
            monitor.check(path, probe=lambda _: False, send=send)
            send.assert_called_once()
            self.assertIn(monitor.HOST, send.call_args.args[0])
            self.assertIn("Возможно", send.call_args.args[0])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            monitor.check(path, probe=lambda _: False, send=send)
            self.assertEqual(send.call_count, 1)
            monitor.check(path, probe=lambda _: True, send=send)
            self.assertEqual(send.call_count, 1)
            monitor.check(path, probe=lambda _: False, send=send)
            self.assertEqual(send.call_count, 2)

    def test_first_run_can_detect_an_existing_outage(self):
        with tempfile.TemporaryDirectory() as directory:
            send = Mock()
            monitor.check(Path(directory) / "state.json", probe=lambda _: False, send=send)
            send.assert_called_once()

    def test_failed_telegram_delivery_remains_pending_for_next_run(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            with self.assertRaises(RuntimeError):
                monitor.check(path, probe=lambda _: False, send=Mock(side_effect=RuntimeError("Failed")))
            self.assertFalse(json.loads(path.read_text())["alertSent"])
            since = json.loads(path.read_text())["unavailableSince"]
            send = Mock()
            monitor.check(path, probe=lambda _: False, send=send)
            send.assert_called_once()
            self.assertTrue(json.loads(path.read_text())["alertSent"])
            self.assertEqual(json.loads(path.read_text())["unavailableSince"], since)

    def test_corrupt_state_is_not_silently_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text("broken")
            send = Mock()
            with self.assertRaises(ValueError):
                monitor.check(path, probe=lambda _: False, send=send)
            send.assert_not_called()


class TelegramTest(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "TELEGRAM_BOT_TOKEN": "12345678:fake_test_token", "TELEGRAM_ADMIN_CHAT_ID": "123",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_notification_goes_only_to_configured_admin_and_has_sound(self):
        response = Mock(__enter__=Mock(return_value=Mock()), __exit__=Mock(return_value=False))
        with patch.object(monitor.urllib.request, "build_opener") as opener, \
                patch.object(monitor.json, "load", return_value={"ok": True, "result": {"message_id": 42, "chat": {"id": 123}}}):
            opener.return_value.open.return_value = response
            monitor.notify("VM unavailable")
            request = opener.return_value.open.call_args.args[0]
            data = json.loads(request.data)
            self.assertEqual(data["chat_id"], "123")
            self.assertFalse(data["disable_notification"])
            self.assertTrue(request.full_url.startswith("https://api.telegram.org/bot"))

    def test_network_error_does_not_expose_token(self):
        with patch.object(monitor.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = urllib.error.URLError("https://api.telegram.org/bot12345678:fake_test_token/sendMessage")
            with self.assertRaises(RuntimeError) as failure:
                monitor.notify("Test")
            self.assertNotIn("fake_test_token", str(failure.exception))

    def test_wrong_chat_or_missing_confirmation_is_not_success(self):
        response = Mock(__enter__=Mock(return_value=Mock()), __exit__=Mock(return_value=False))
        with patch.object(monitor.urllib.request, "build_opener") as opener, \
                patch.object(monitor.json, "load", return_value={"ok": True, "result": {"message_id": 42, "chat": {"id": 999}}}):
            opener.return_value.open.return_value = response
            with self.assertRaises(RuntimeError):
                monitor.notify("Test")


if __name__ == "__main__":
    unittest.main()
