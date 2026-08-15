#!/bin/bash
# روی همین فایل دابل‌کلیک کنید: آخرین داده را از گیت‌هاب می‌گیرد و داشبورد را
# در مرورگر باز می‌کند. (فایل باید executable باشد: chmod +x)

cd "$(dirname "$0")" || exit 1

echo "Fetching the latest checks from GitHub…"
if git pull --rebase --quiet origin main 2>/dev/null; then
  echo "Up to date."
else
  echo "Could not pull (offline or not signed in) — opening the last data on this machine."
fi

open "uptime/index.html"

# پنجرهٔ ترمینال خودش بسته می‌شود
sleep 1
osascript -e 'tell application "Terminal" to close (every window whose name contains "Open Dashboard")' &>/dev/null &
exit 0
