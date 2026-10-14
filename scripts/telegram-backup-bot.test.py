import importlib.util
from pathlib import Path
import unittest

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


if __name__ == "__main__":
    unittest.main()
