#!/usr/bin/env bash
# کامیت نتیجه‌ها. با سوییچ --amend-daily، اگر آخرین کامیت لاگِ همین روز باشد
# رویش amend می‌زند به‌جای ساختن کامیت تازه.
#
# چرا: سنجش هر ۱۵ دقیقه یعنی ماهی حدود ۲٬۹۰۰ اجرا. اگر هر اجرا یک کامیت بزند،
# تاریخچهٔ ریپو غیرقابل‌استفاده می‌شود. با amend، هر روز فقط یک کامیت می‌ماند.
#
# استفاده:  commit.sh "پیام کامیت" [--amend-daily]

set -euo pipefail

MSG="${1:?پیام کامیت لازم است}"
MODE="${2:-}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
TODAY="$(date -u +%F)"
PATHS=(uptime/sites.json uptime/data uptime/icons.json uptime/reports)
# payload.json خروجی موقتی برای ارسال است، نه دادهٔ ماندگار — کامیت نمی‌شود.

git config user.name  "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# فقط مسیرهایی که واقعاً هستند. گیت پوشهٔ خالی را نگه نمی‌دارد، پس روی یک
# چک‌اوت تازه ممکن است uptime/reports یا uptime/icons.json هنوز وجود نداشته
# باشد و `git add` با کد ۱۲۸ کل اجرا را بخواباند.
EXISTING=()
for p in "${PATHS[@]}"; do
  [ -e "$p" ] && EXISTING+=("$p")
done
if [ ${#EXISTING[@]} -eq 0 ]; then
  echo "Nothing to commit."
  exit 0
fi

# آیا فهرست سایت‌ها را خودمان عوض کرده‌ایم؟ (Workflow «مدیریت سایت‌ها»)
# اگر بله، در مسیر بازیابی پایین نباید نسخهٔ ریموت را رویش بنویسیم.
SITES_CHANGED=0
git diff --quiet HEAD -- uptime/sites.json || SITES_CHANGED=1

git add -A "${EXISTING[@]}"

if git diff --cached --quiet; then
  echo "Nothing to commit."
  exit 0
fi

# آیا آخرین کامیت، لاگِ امروز است؟
is_todays_log() {
  [ "$(git log -1 --pretty=%s)" = "$MSG" ] &&
  [ "$(TZ=UTC git log -1 --date=format-local:%F --pretty=%cd)" = "$TODAY" ]
}

FORCE=""
if [ "$MODE" = "--amend-daily" ] && is_todays_log; then
  git commit --quiet --amend --no-edit
  FORCE="--force-with-lease"
  echo "Amended today's log commit."
else
  git commit --quiet -m "$MSG"
  echo "Created a new commit."
fi

if git push $FORCE origin "HEAD:$BRANCH"; then
  exit 0
fi

# کسی وسط کار push کرده (مثلاً ویرایش sites.json از رابط وب گیت‌هاب).
#
# اینجا rebase نمی‌کنیم: کامیت روزانه amend شده و نسخهٔ قدیمی‌ترش هنوز روی
# ریموت است، پس replay کردنش روی خودش تضاد می‌دهد. به‌جایش کامیت خودمان را
# باز می‌کنیم — reset --mixed فایل‌های کاری را دست نمی‌زند — و یک کامیت تازه
# روی آخرین وضعیت ریموت می‌سازیم.
echo "Push rejected; replaying our data on top of the latest remote state."
git fetch origin "$BRANCH"
git reset --mixed "origin/$BRANCH"

if [ "$SITES_CHANGED" = 0 ]; then
  # فهرست سایت‌ها را ما عوض نکرده‌ایم، پس ویرایش آن‌ها می‌ماند و صفحه را با
  # همان دوباره می‌سازیم.
  git checkout "origin/$BRANCH" -- uptime/sites.json
  node uptime/lib/build.mjs
fi

git add -A "${EXISTING[@]}"
if git diff --cached --quiet; then
  echo "Nothing left to commit after syncing with the remote."
  exit 0
fi
git commit --quiet -m "$MSG"
git push origin "HEAD:$BRANCH"
