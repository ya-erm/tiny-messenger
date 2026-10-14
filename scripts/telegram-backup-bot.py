"""Private /backup control bot. Archives are produced by the bounded worker."""

import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request


def is_admin_backup(message, admin_id, bot_username):
    chat = message.get("chat", {})
    sender = message.get("from", {})
    words = message.get("text", "").strip().split()
    return (
        chat.get("type") == "private"
        and str(chat.get("id")) == admin_id
        and str(sender.get("id")) == admin_id
        and not sender.get("is_bot", False)
        and bool(words)
        and words[0].lower() in ("/backup", "/backup@" + bot_username.lower())
    )


class Bot:
    def __init__(self, token, admin_id):
        self.token = token
        self.admin_id = admin_id

    def api(self, method, data=None):
        request = urllib.request.Request(
            "https://api.telegram.org/bot" + self.token + "/" + method,
            data=json.dumps(data or {}).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError("Telegram HTTP " + str(error.code)) from None
        except Exception:
            # urllib exceptions can expose the secret URL.
            raise RuntimeError("Telegram connection failed") from None
        if not result.get("ok"):
            raise RuntimeError("Telegram API rejected request")
        return result["result"]

    def notify(self, text):
        self.api("sendMessage", {
            "chat_id": self.admin_id, "disable_notification": True, "text": text,
        })


def main():
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    admin_id = os.environ["TELEGRAM_ADMIN_CHAT_ID"]
    if not admin_id.isdigit():
        raise RuntimeError("Invalid admin ID")
    bot = Bot(token, admin_id)
    state = Path(os.environ.get("STATE_DIRECTORY", "/var/lib/tiny-messenger-backup"))
    offset_file = state / "telegram-offset"
    offset = int(offset_file.read_text()) if offset_file.exists() else 0
    username = bot.api("getMe")["username"]
    if bot.api("getWebhookInfo").get("url"):
        raise RuntimeError("An existing webhook prevents polling")
    print("Admin-only backup bot is polling", flush=True)
    while True:
        try:
            updates = bot.api("getUpdates", {
                "offset": offset, "timeout": 30, "allowed_updates": ["message"],
            })
            for update in updates:
                offset = update["update_id"] + 1
                # Persist before dispatch to avoid duplicate backups on restart.
                temporary = offset_file.with_suffix(".next")
                temporary.write_text(str(offset))
                temporary.chmod(0o600)
                temporary.replace(offset_file)
                if not is_admin_backup(update.get("message", {}), admin_id, username):
                    continue
                active = subprocess.run(
                    ["systemctl", "is-active", "tiny-messenger-backup.service"],
                    capture_output=True, text=True, timeout=10,
                ).stdout.strip()
                if active in ("active", "activating", "deactivating"):
                    bot.notify("Бэкап уже выполняется. Архив придёт по завершении.")
                    continue
                started = subprocess.run(
                    ["systemctl", "start", "--no-block", "tiny-messenger-backup.service"],
                    capture_output=True, timeout=10,
                )
                if started.returncode:
                    bot.notify("Не удалось запустить бэкап. Проверь журнал tiny-messenger-backup.service.")
                else:
                    bot.notify("Запускаю бэкап всей базы. Архив придёт без звука.")
                    print("Admin requested backup", flush=True)
        except Exception:
            print("Polling or command processing failed; retrying in 10 seconds", flush=True)
            time.sleep(10)


if __name__ == "__main__":
    main()
