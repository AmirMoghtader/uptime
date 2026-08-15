#!/usr/bin/env node
// ساخت بستهٔ JSON برای پنل ادمین آنوبز و — اگر UPTIME_ENDPOINT و UPTIME_TOKEN
// تنظیم باشند — فرستادنش به سرور.
//
// چرا push و نه pull: ریپو عمومی است و سرور می‌توانست خودش از raw.githubusercontent
// بخواند، ولی آن دامنه از داخل ایران قابل اتکا نیست. runner گیت‌هاب بیرون است و
// دستش باز، پس داده را او هل می‌دهد.
//
// همهٔ محاسبه‌ها همین‌جا انجام می‌شود تا پنل فقط نمایش‌دهنده باشد و هیچ‌وقت دو
// تعریف متفاوت از «بالا بودن» وجود نداشته باشد.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readSites, readIcons, loadChecks, computeUptime, findOutages, avgResponse,
  currentStatus, isMonitored, isUp, WINDOWS, DAY_MS, UPTIME_DIR, MAX_GAP_MS,
  CHECK_EVERY_MIN,
} from './common.mjs';

const NOW = Date.now();
const STRIP_DAYS = 30;

const sites = readSites();
const icons = readIcons();

/** درصد آپتایم هر روز، برای نوار ۳۰ روزه. */
function dayBars(checks) {
  const bars = [];
  for (let i = STRIP_DAYS - 1; i >= 0; i--) {
    const to = Math.min(NOW, NOW - i * DAY_MS);
    const from = to - DAY_MS;
    const day = checks.filter((c) => c.at >= from - DAY_MS && c.at <= to);
    const u = computeUptime(day, from, to);
    bars.push({
      date: new Date(to).toISOString().slice(0, 10),
      pct: u.coveredMs > 0 ? u.pct : null,
      // تعداد قطعی‌های همان روز، برای نمایش در tooltip
      outages: u.coveredMs > 0 ? findOutages(day.filter((c) => c.at >= from), to).length : 0,
    });
  }
  return bars;
}

/** میانگین زمان پاسخ در بازه‌های ۲۰ دقیقه‌ای ۲۴ ساعت اخیر، برای نمودار. */
function series(checks) {
  const from = NOW - DAY_MS;
  const BUCKETS = 72;
  const slot = DAY_MS / BUCKETS;
  const buckets = Array.from({ length: BUCKETS }, () => ({ sum: 0, n: 0, down: 0 }));
  for (const c of checks) {
    const i = Math.min(BUCKETS - 1, Math.floor((c.at - from) / slot));
    if (i < 0) continue;
    if (isUp(c)) { buckets[i].sum += c.ms ?? 0; buckets[i].n++; } else buckets[i].down++;
  }
  return buckets.map((b) => ({
    ms: b.n ? Math.round(b.sum / b.n) : null,
    down: b.down > 0,
  }));
}

function sitePayload(site) {
  if (!isMonitored(site)) {
    return {
      id: site.id,
      name: site.name,
      url: site.url,
      icon: icons[site.id]?.dataUri ?? null,
      monitored: false,
      note: site.note ?? null,
      checks: 0,
    };
  }

  const all = loadChecks(site.id, NOW - 30 * DAY_MS, NOW);
  const status = currentStatus(all);
  const day = all.filter((c) => c.at >= NOW - DAY_MS);

  const uptime = {};
  const counts = {};
  for (const w of WINDOWS) {
    const from = NOW - w.ms;
    const u = computeUptime(all.filter((c) => c.at >= from), from, NOW);
    uptime[w.key] = u.pct;
    counts[w.key] = u.count;
  }

  return {
    id: site.id,
    name: site.name,
    url: site.url,
    icon: icons[site.id]?.dataUri ?? null,
    monitored: true,
    state: status.state,
    since: status.sinceMs ? new Date(status.sinceMs).toISOString() : null,
    lastCheck: status.lastMs ? new Date(status.lastMs).toISOString() : null,
    lastMs: status.last?.ms ?? null,
    lastCode: status.last ? (status.last.s || status.last.e || null) : null,
    uptime,
    counts,
    avgMs: avgResponse(day),
    avg7dMs: avgResponse(all.filter((c) => c.at >= NOW - 7 * DAY_MS)),
    days: dayBars(all),
    series: series(day),
    outages: findOutages(all, NOW).slice(0, 20).map((o) => ({
      start: new Date(o.startMs).toISOString(),
      durationMs: o.durationMs,
      ongoing: o.ongoing,
      codes: o.codes.map((c) => c.code),
    })),
  };
}

const payload = {
  generatedAt: new Date(NOW).toISOString(),
  checkEveryMin: CHECK_EVERY_MIN,
  maxGapMin: MAX_GAP_MS / 60000,
  sites: sites.map(sitePayload),
};

const out = join(UPTIME_DIR, 'payload.json');
writeFileSync(out, JSON.stringify(payload));
const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1);

const watched = payload.sites.filter((s) => s.monitored);
const down = watched.filter((s) => s.state === 'down').length;
console.log(`Payload: ${watched.length} monitored, ${down} down, ${kb} KB`);

// ── ارسال به سرور ──────────────────────────────────────────────────────────

const endpoint = process.env.UPTIME_ENDPOINT;
const token = process.env.UPTIME_TOKEN;

if (!endpoint || !token) {
  console.log('UPTIME_ENDPOINT/UPTIME_TOKEN not set — payload written to disk only.');
  process.exit(0);
}

// مسیر بین‌المللی به میزبان‌های ایران گاهی چند ثانیه می‌افتد؛ یک بار تلاش کافی
// نیست، وگرنه پنل تا ده دقیقهٔ بعد دادهٔ قدیمی نشان می‌دهد.
const ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      console.log(`Pushed to ${new URL(endpoint).host} — HTTP ${res.status}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      break;
    }
    const text = (await res.text()).slice(0, 200);
    console.log(`Attempt ${attempt}: HTTP ${res.status} — ${text}`);
    // ۴۰۱/۴۰۴ یعنی توکن یا مسیر غلط است؛ تکرارش فایده‌ای ندارد.
    if (res.status === 401 || res.status === 404) break;
  } catch (err) {
    console.log(`Attempt ${attempt}: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }

  if (attempt === ATTEMPTS) {
    // ارسال نشد، ولی داده در ریپو کامیت می‌شود و ارسال بعدی همه‌چیز را
    // می‌رساند — پس این نباید کل اجرا را قرمز کند.
    console.log('Push gave up after 3 attempts — the data is still committed to the repo.');
  } else {
    await sleep(5000);
  }
}
