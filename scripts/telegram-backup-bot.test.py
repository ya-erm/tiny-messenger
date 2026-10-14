import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("backup_bot", Path(__file__).with_name("telegram-backup-bot.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AuthorizationTest(unittest.TestCase):
    def test_admin_private_command_only(self):
        message = {"chat": {"id": 123, "type": "private"}, "from": {"id": 123}, "text": "/backup"}
        allowed = lambda candidate: module.is_admin_backup(candidate, "123", "ExampleBot")
        self.assertTrue(allowed(message))
        self.assertTrue(allowed({**message, "text": "/backup@ExampleBot"}))
        self.assertFalse(allowed({**message, "from": {"id": 456}}))
        self.assertFalse(allowed({**message, "chat": {"id": 456, "type": "private"}}))
        self.assertFalse(allowed({**message, "chat": {"id": 123, "type": "group"}}))
        self.assertFalse(allowed({**message, "from": {"id": 123, "is_bot": True}}))
        self.assertFalse(allowed({**message, "text": "/backup@OtherBot"}))
        self.assertFalse(allowed({**message, "text": "backup"}))
        self.assertFalse(allowed({}))

    def test_polling_dispatches_only_admin_and_notifies_silently(self):
        messages = [
            {"chat": {"id": 456, "type": "private"}, "from": {"id": 456}, "text": "/backup"},
            {"chat": {"id": 123, "type": "group"}, "from": {"id": 123}, "text": "/backup"},
            {"chat": {"id": 123, "type": "private"}, "from": {"id": 123}, "text": "/backup@ExampleBot"},
        ]
        calls = []
        polls = 0

        def api(bot, method, data=None):
            nonlocal polls
            calls.append((method, data))
            if method == "getMe":
                return {"username": "ExampleBot"}
            if method == "getWebhookInfo":
                return {"url": ""}
            if method == "getUpdates":
                polls += 1
                if polls > 1:
                    raise KeyboardInterrupt
                return [{"update_id": i, "message": m} for i, m in enumerate(messages, 1)]
            return True

        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "test", "TELEGRAM_ADMIN_CHAT_ID": "123", "STATE_DIRECTORY": directory}):
                with patch.object(module.Bot, "api", api), patch.object(module.subprocess, "run", side_effect=[
                    subprocess.CompletedProcess([], 3, stdout="inactive\n"),
                    subprocess.CompletedProcess([], 0),
                ]) as run:
                    with self.assertRaises(KeyboardInterrupt):
                        module.main()
                    self.assertEqual(run.call_count, 2)
                    self.assertEqual(run.call_args_list[1].args[0], ["systemctl", "start", "--no-block", "tiny-messenger-backup.service"])
            self.assertEqual(Path(directory, "telegram-offset").read_text(), "4")
        notifications = [data for method, data in calls if method == "sendMessage"]
        self.assertEqual(len(notifications), 1)
        self.assertEqual(notifications[0]["chat_id"], "123")
        self.assertTrue(notifications[0]["disable_notification"])
        menu = next(data for method, data in calls if method == "setMyCommands")
        self.assertEqual(menu["scope"], {"type": "chat", "chat_id": "123"})


if __name__ == "__main__":
    unittest.main()
