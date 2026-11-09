"""Check VM reachability once; systemd schedules checks every five minutes."""

import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


HOST = "vm-2.ya-erm.ru"
PORTS = (22, 443, 80)
ATTEMPTS = 3
MOSCOW = timezone(timedelta(hours=3))


def reachable(host):
    try:
        ping = subprocess.run(
            ["/usr/bin/ping", "-n", "-c", "1", "-W", "3", "-w", "4", host],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
        )
        if ping.returncode == 0:
            return True
    except (OSError, subprocess.TimeoutExpired):
        pass
    for port in PORTS:
        try:
            with socket.create_connection((host, port), timeout=3):
                return True
        except ConnectionRefusedError:
            # A refusal is still a response from the host; its service may be off.
            return True
        except OSError:
            continue
    return False


def confirmed_reachable(host):
    for attempt in range(ATTEMPTS):
        if reachable(host):
            return True
        if attempt + 1 < ATTEMPTS:
            time.sleep(5)
    return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def notify(text):
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_ADMIN_CHAT_ID", "")
    if not re.fullmatch(r"\d+:[A-Za-z0-9_-]+", token) or not chat_id.isdigit():
        raise RuntimeError("Invalid Telegram configuration")
    request = urllib.request.Request(
        "https://api.telegram.org/bot" + token + "/sendMessage",
        data=json.dumps({
            "chat_id": chat_id, "text": text, "disable_notification": False,
        }).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            payload = json.load(response)
            if not payload.get("ok"):
                raise RuntimeError("Telegram rejected notification")
            result = payload.get("result", {})
            if str(result.get("chat", {}).get("id")) != chat_id or not result.get("message_id"):
                raise RuntimeError("Telegram notification was not confirmed")
    except urllib.error.HTTPError as error:
        raise RuntimeError("Telegram HTTP " + str(error.code)) from None
    except RuntimeError:
        raise
    except Exception:
        # Network exceptions can contain the bot token in the request URL.
        raise RuntimeError("Telegram connection failed or delivery unconfirmed") from None


def save_state(path, state):
    temporary = path.with_suffix(".next")
    with temporary.open("w", encoding="utf-8") as output:
        os.chmod(temporary, 0o600)
        json.dump(state, output, ensure_ascii=False, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def check(state_path, probe=confirmed_reachable, send=notify):
    if state_path.exists():
        state = json.loads(state_path.read_text())
        if state.get("version") != 1 or state.get("host") != HOST:
            raise RuntimeError("Unexpected VM monitor state")
    else:
        state = {"version": 1, "host": HOST, "alertSent": False, "unavailableSince": None}
    now = datetime.now(timezone.utc).isoformat()
    state["lastCheckedAt"] = now
    if probe(HOST):
        state.update(alertSent=False, unavailableSince=None, lastReachableAt=now)
        save_state(state_path, state)
        print(HOST + " reachable; no notification", flush=True)
        return
    state["unavailableSince"] = state.get("unavailableSince") or now
    save_state(state_path, state)
    if state["alertSent"]:
        print(HOST + " still unavailable; notification already sent", flush=True)
        return
    since = datetime.fromisoformat(state["unavailableSince"]).astimezone(MOSCOW)
    send(
        "⚠️ Виртуальная машина " + HOST + " недоступна.\n"
        "Не отвечает на ping и TCP-порты 22, 443, 80 после трёх попыток.\n"
        "Возможно, VM остановлена или возникла сетевая проблема.\n"
        "Обнаружено: " + since.strftime("%d.%m.%Y %H:%M:%S МСК")
    )
    state["alertSent"] = True
    state["alertSentAt"] = datetime.now(timezone.utc).isoformat()
    save_state(state_path, state)
    print(HOST + " unavailable; Telegram notification confirmed", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only", action="store_true", help="Probe without state changes or Telegram")
    args = parser.parse_args()
    if args.check_only:
        up = confirmed_reachable(HOST)
        print(HOST + (" reachable" if up else " unavailable after three attempts"))
        return 0 if up else 2
    directory = Path(os.environ.get("STATE_DIRECTORY", "/var/lib/tiny-messenger-vm-monitor"))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (directory / "check.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("VM check already running", flush=True)
            return 0
        check(directory / "state.json")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Keep configuration, tokens, URLs and exception details out of journald.
        print("VM check or Telegram delivery failed; next scheduled run will retry", file=sys.stderr)
        sys.exit(1)
