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

// مرز روز به وقت تهران (UTC+3:30، بدون ساعت تابستانی از ۲۰۲۲).
//
// تا حالا «روز» یعنی ۲۴ ساعتِ قبل از همین لحظه بود، ولی برچسبش یک تاریخ
// تقویمی را نشان می‌داد — یعنی میله‌ای که «۲۳ مرداد» می‌گفت در واقع از ساعت
// ۲۱ روز قبل تا ۲۱ آن روز بود. برای ذخیره در دیتابیس این اشتباه جدی‌تر هم
// می‌شد، چون کلید جدول تاریخ است. حالا مرزها واقعاً نیمه‌شب تهران‌اند.
const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

function tehranDayStart(ms) {
  return Math.floor((ms + TEHRAN_OFFSET_MS) / DAY_MS) * DAY_MS - TEHRAN_OFFSET_MS;
}

function tehranDayKey(ms) {
  return new Date(ms + TEHRAN_OFFSET_MS).toISOString().slice(0, 10);
}

const sites = readSites();
const icons = readIcons();

/**
 * یک ورودی برای هر روز از سی روز گذشته.
 *
 * علاوه بر درصد، جزئیات همان روز هم می‌آید تا با کلیک روی یک میله در پنل،
 * بشود دید آن روز دقیقاً چه گذشته — بدون اینکه پنل لازم باشد چیزی حساب کند.
 */
function dayBars(checks) {
  const today = tehranDayStart(NOW);
  const bars = [];

  for (let i = STRIP_DAYS - 1; i >= 0; i--) {
    const from = today - i * DAY_MS;
    const to = Math.min(NOW, from + DAY_MS);
    const window = checks.filter((c) => c.at >= from - DAY_MS && c.at <= to);
    const inDay = window.filter((c) => c.at >= from && c.at <= to);
    const u = computeUptime(window, from, to);
    const date = tehranDayKey(from);

    if (!(u.coveredMs > 0)) {
      bars.push({ date, pct: null, checks: 0, coveredMs: 0, upMs: 0, gapMs: u.gapMs, outages: [] });
      continue;
    }

    bars.push({
      date,
      pct: u.pct,
      checks: inDay.length,
      avgMs: avgResponse(inDay),
      coveredMs: u.coveredMs,
      upMs: u.upMs,
      gapMs: u.gapMs,
      // چند دقیقه از آن روز پایین بوده — «۹۹٫۲٪» به‌تنهایی حس مدت نمی‌دهد
      downMs: u.coveredMs - u.upMs,
      coverPct: Math.round((u.coveredMs / (to - from)) * 100),
      outages: findOutages(inDay, to).slice(0, 6).map(outagePayload),
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

/**
 * یک قطعی، با هر چیزی که برای فهمیدنش لازم است: از کِی تا کِی، چند بررسی
 * ناموفق، و دقیقاً چه کدی — با تعداد تکرار هر کد.
 */
function outagePayload(o) {
  return {
    start: new Date(o.startMs).toISOString(),
    end: o.endMs ? new Date(o.endMs).toISOString() : null,
    durationMs: o.durationMs,
    ongoing: o.ongoing,
    failedChecks: o.checks,
    codes: o.codes.map((c) => ({ code: c.code, n: c.n })),
  };
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

  // کنار هر درصد، اجزای همان محاسبه هم می‌رود تا در پنل بشود صحتش را
  // وارسی کرد: چه مدتی پوشش داده شده، چقدرش بالا بوده، و چه مدتی اصلاً
  // داده‌ای نبوده و از مخرج بیرون گذاشته شده.
  const uptime = {};
  const counts = {};
  const basis = {};
  for (const w of WINDOWS) {
    const from = NOW - w.ms;
    const u = computeUptime(all.filter((c) => c.at >= from), from, NOW);
    uptime[w.key] = u.pct;
    counts[w.key] = u.count;
    basis[w.key] = {
      coveredMs: u.coveredMs,
      upMs: u.upMs,
      gapMs: u.gapMs,
      windowMs: u.windowMs,
    };
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
    basis,
    avgMs: avgResponse(day),
    avg7dMs: avgResponse(all.filter((c) => c.at >= NOW - 7 * DAY_MS)),
    days: dayBars(all),
    series: series(day),
    outages: findOutages(all, NOW).slice(0, 20).map(outagePayload),
  };
}

/**
 * بررسی‌های همین اجرا — خام، برای ثبت در دیتابیس.
 *
 * فقط نتیجهٔ همین اجرا فرستاده می‌شود، نه کل تاریخچه؛ کلید یکتای جدول
 * (site_id, checked_at) هم باعث می‌شود ارسال دوباره چیزی را دو بار ثبت نکند.
 */
function currentRun() {
  const since = NOW - 3 * CHECK_EVERY_MIN * 60 * 1000;
  const rows = [];
  for (const site of sites.filter(isMonitored)) {
    for (const c of loadChecks(site.id, since, NOW)) {
      rows.push({ id: site.id, t: c.t, s: c.s, ms: c.ms, ...(c.e ? { e: c.e } : {}) });
    }
  }
  return rows;
}

const payload = {
  generatedAt: new Date(NOW).toISOString(),
  checkEveryMin: CHECK_EVERY_MIN,
  maxGapMin: MAX_GAP_MS / 60000,
  sites: sites.map(sitePayload),
  run: currentRun(),
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
      // پاسخ می‌گوید چند ردیف تازه در تاریخچه نشسته — بدون این، تنها راهِ
      // فهمیدنش باز کردن دیتابیس بود.
      let detail = '';
      try {
        const body = await res.json();
        if (typeof body?.stored === 'number') {
          detail = ` — ${body.stored} new check rows, ${body.days ?? 0} daily rows`;
        }
      } catch { /* پاسخ JSON نبود؛ مهم نیست */ }
      console.log(
        `Pushed to ${new URL(endpoint).host} — HTTP ${res.status}${attempt > 1 ? ` (attempt ${attempt})` : ''}${detail}`,
      );
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
