// تعریف‌های مشترک سنجش آپتایم.
// داشبورد و ایجنت هفتگی هر دو از همین فایل می‌خوانند تا هیچ‌وقت دو تعریف
// متفاوت از «بالا بودن» یا دو روش متفاوت محاسبهٔ درصد وجود نداشته باشد.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// ── ثابت‌ها ────────────────────────────────────────────────────────────────

/** «بالا بودن» = کد وضعیت HTTP بین ۲۰۰ تا ۳۹۹. تنها تعریف موجود در پروژه. */
export const UP_MIN = 200;
export const UP_MAX = 399;

/** تایم‌اوت هر درخواست (میلی‌ثانیه). */
export const TIMEOUT_MS = 15_000;

/** فاصلهٔ اسمی بین دو بررسی (دقیقه). با cron در uptime.yml هماهنگ نگه دارید. */
export const CHECK_EVERY_MIN = 10;

/**
 * بیشترین فاصلهٔ قابل‌قبول بین دو بررسی. بیشتر از این یعنی داده نداریم، نه
 * اینکه سایت پایین بوده. cron گیت‌هاب دقیق نیست و گاهی اجرا از دست می‌رود،
 * پس آستانه را سه برابر فاصلهٔ اسمی می‌گیریم: دو اجرای از دست‌رفته هنوز
 * «شکاف داده» است، نه قطعی.
 */
export const MAX_GAP_MS = 3 * CHECK_EVERY_MIN * 60 * 1000;

/** فایل‌های روزانهٔ قدیمی‌تر از این تعداد روز پاک می‌شوند. */
export const RETENTION_DAYS = 90;

/**
 * محدودیت ذاتی این روش: قطعی کوتاه‌تر از فاصلهٔ بررسی اصلاً دیده نمی‌شود.
 * عدد آپتایم یعنی «در لحظات بررسی بالا بوده»، نه «یک ثانیه هم قطع نشده».
 * این نکته عمداً روی صفحه نوشته نمی‌شود.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export const WINDOWS = [
  { key: 'd1',  label: '24h', ms: DAY_MS },
  { key: 'd7',  label: '7d',  ms: 7 * DAY_MS },
  { key: 'd30', label: '30d', ms: 30 * DAY_MS },
];

// ── مسیرها ─────────────────────────────────────────────────────────────────

export const UPTIME_DIR = fileURLToPath(new URL('..', import.meta.url));
export const DATA_DIR = join(UPTIME_DIR, 'data');
export const SITES_FILE = join(UPTIME_DIR, 'sites.json');
export const ICONS_FILE = join(UPTIME_DIR, 'icons.json');
export const REPORTS_DIR = join(UPTIME_DIR, 'reports');

// ── خواندن داده ────────────────────────────────────────────────────────────

export function readSites() {
  const raw = JSON.parse(readFileSync(SITES_FILE, 'utf8'));
  const sites = raw.sites ?? [];
  const seen = new Set();
  for (const s of sites) {
    if (!s.id || !s.url) throw new Error(`سایت بدون id یا url: ${JSON.stringify(s)}`);
    if (seen.has(s.id)) throw new Error(`id تکراری: ${s.id}`);
    seen.add(s.id);
  }
  return sites;
}

/**
 * آیا این سایت بررسی می‌شود؟
 *
 * بعضی سایت‌ها از بیرون ایران اصلاً در دسترس نیستند و runnerهای گیت‌هاب همه
 * خارج‌اند؛ بررسی‌شان فقط یک قطعیِ دروغین می‌سازد. با `"monitor": false` از
 * چرخه بیرون می‌روند ولی روی داشبورد با توضیح می‌مانند.
 */
export function isMonitored(site) {
  return site?.monitor !== false;
}

export function readIcons() {
  if (!existsSync(ICONS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(ICONS_FILE, 'utf8')).icons ?? {};
  } catch {
    return {};
  }
}

/** نام فایل روزانه از روی زمان (همیشه UTC، تا مرز روز یکتا بماند). */
export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function dayFile(key) {
  return join(DATA_DIR, `${key}.json`);
}

export function listDayKeys() {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

export function readDay(key) {
  const file = dayFile(key);
  if (!existsSync(file)) return null;
  try {
    const day = JSON.parse(readFileSync(file, 'utf8'));
    return day && typeof day.checks === 'object' ? day : null;
  } catch {
    return null; // فایل نیمه‌نوشته یا خراب، نباید کل ساخت را بخواباند
  }
}

/**
 * همهٔ بررسی‌های یک سایت از `sinceMs` به بعد، مرتب‌شده بر اساس زمان.
 * فایل‌های روزانه UTC هستند، پس یک روز اضافه از هر طرف خوانده می‌شود.
 */
export function loadChecks(siteId, sinceMs, untilMs = Date.now()) {
  const from = dayKey(new Date(sinceMs - DAY_MS));
  const to = dayKey(new Date(untilMs));
  const out = [];
  for (const key of listDayKeys()) {
    if (key < from || key > to) continue;
    const day = readDay(key);
    for (const c of day?.checks?.[siteId] ?? []) {
      const at = Date.parse(c.t);
      if (Number.isNaN(at) || at < sinceMs || at > untilMs) continue;
      out.push({ ...c, at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ── محاسبه ─────────────────────────────────────────────────────────────────

export function isUp(check) {
  return typeof check?.s === 'number' && check.s >= UP_MIN && check.s <= UP_MAX;
}

/**
 * درصد آپتایم، وزنی بر پایهٔ زمان واقعی.
 *
 * هر بررسی نمایندهٔ بازهٔ بین خودش و بررسی بعدی است. اگر آن بازه از
 * MAX_GAP_MS بیشتر شد، پوشش‌داده‌نشده حساب می‌شود و از مخرج بیرون می‌رود —
 * شکاف در داده، قطعی نیست.
 *
 * شمردن تعداد رکوردها به‌جای این کار عدد غلط می‌دهد، چون فاصلهٔ واقعی
 * اجراها حول CHECK_EVERY_MIN نوسان دارد و گاهی اجرا از دست می‌رود.
 */
export function computeUptime(checks, fromMs, toMs) {
  let coveredMs = 0;
  let upMs = 0;
  let gapMs = 0;

  for (let i = 0; i < checks.length; i++) {
    const start = Math.max(checks[i].at, fromMs);
    const end = Math.min(checks[i + 1]?.at ?? toMs, toMs);
    const span = end - start;
    if (span <= 0) continue;
    if (span > MAX_GAP_MS) { gapMs += span; continue; }
    coveredMs += span;
    if (isUp(checks[i])) upMs += span;
  }

  return {
    pct: coveredMs > 0 ? (upMs / coveredMs) * 100 : null,
    coveredMs,
    gapMs,
    count: checks.length,
    windowMs: toMs - fromMs,
  };
}

/**
 * قطعی‌ها: هر دنبالهٔ پیوسته از بررسی‌های ناموفق.
 * پایان قطعی = زمان اولین بررسی موفق بعدی (یا «تا همین حالا»).
 */
export function findOutages(checks, toMs = Date.now()) {
  const outages = [];
  let current = null;

  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    if (!isUp(c)) {
      if (!current) {
        current = { startMs: c.at, endMs: null, checks: 0, codes: new Map(), lastMs: c.at };
      }
      current.checks++;
      current.lastMs = c.at;
      const code = c.s === 0 ? (c.e || 'no response') : String(c.s);
      current.codes.set(code, (current.codes.get(code) ?? 0) + 1);
    } else if (current) {
      current.endMs = c.at;
      outages.push(finishOutage(current));
      current = null;
    }
  }

  if (current) {
    current.endMs = null; // هنوز ادامه دارد
    outages.push(finishOutage(current, toMs));
  }

  return outages.reverse(); // تازه‌ترین اول
}

function finishOutage(o, nowMs) {
  const end = o.endMs ?? nowMs;
  return {
    startMs: o.startMs,
    endMs: o.endMs,
    ongoing: o.endMs === null,
    durationMs: Math.max(0, end - o.startMs),
    checks: o.checks,
    codes: [...o.codes.entries()].sort((a, b) => b[1] - a[1]).map(([code, n]) => ({ code, n })),
  };
}

/** میانگین زمان پاسخ فقط روی بررسی‌های موفق — تایم‌اوت میانگین را بی‌معنا می‌کند. */
export function avgResponse(checks) {
  const ups = checks.filter((c) => isUp(c) && typeof c.ms === 'number');
  if (!ups.length) return null;
  return Math.round(ups.reduce((sum, c) => sum + c.ms, 0) / ups.length);
}

export function currentStatus(checks) {
  if (!checks.length) return { state: 'unknown', sinceMs: null, lastMs: null, last: null };
  const last = checks[checks.length - 1];
  const up = isUp(last);
  let sinceMs = last.at;
  for (let i = checks.length - 1; i >= 0; i--) {
    if (isUp(checks[i]) !== up) break;
    sinceMs = checks[i].at;
  }
  return { state: up ? 'up' : 'down', sinceMs, lastMs: last.at, last };
}
