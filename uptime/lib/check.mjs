#!/usr/bin/env node
// سنجش: هر سایت را یک بار می‌زند و نتیجه را به فایل روز جاری اضافه می‌کند.
// هیچ محاسبه‌ای اینجا انجام نمی‌شود؛ فقط ثبت خام.

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import {
  readSites, dayKey, dayFile, readDay, listDayKeys, isMonitored,
  DATA_DIR, TIMEOUT_MS, RETENTION_DAYS, DAY_MS, isUp,
} from './common.mjs';

const UA = 'OnwebsUptimeBot/1.0 (+https://github.com/onwebs/uptime)';

// یک بررسیِ ناموفق بلافاصله «قطعی» ثبت نمی‌شود.
//
// بیشتر این سایت‌ها روی میزبان‌های ایران‌اند و بررسی‌ها از runnerهای گیت‌هاب در
// خارج انجام می‌شود؛ مسیر بین‌المللی به ایران گاهی برای چند ثانیه می‌افتد و
// همان یک تایم‌اوت، یک قطعیِ کاذب در تاریخچه می‌سازد. پس فقط وقتی پاسخی
// نیامده باشد (s=0 یعنی تایم‌اوت/خطای اتصال) دوباره امتحان می‌کنیم.
//
// کدهای واقعیِ سرور — ۴۰۳، ۵۰۰ و مانند آن‌ها — تکرار نمی‌شوند: آن‌ها پاسخِ خودِ
// سایت‌اند، نه خرابیِ مسیر.
const RETRIES = 2;
const RETRY_WAIT_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkConfirmed(site) {
  let result = await check(site);
  for (let i = 0; i < RETRIES && result.s === 0; i++) {
    await sleep(RETRY_WAIT_MS);
    const again = await check(site);
    if (again.s !== 0) {
      console.log(`${site.id.padEnd(14)} recovered on attempt ${i + 2}`);
      return again;
    }
    result = again;
  }
  return result;
}

async function check(site) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(site.url, {
      method: 'GET',
      redirect: 'follow', // سایت‌ها معمولاً از غیر‌www به www می‌روند
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
    });
    const ms = Math.round(performance.now() - started);
    res.body?.cancel().catch(() => {}); // بدنه لازم نیست؛ زمان تا هدر ملاک است
    return { s: res.status, ms };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    return { s: 0, ms, e: describe(err) };
  } finally {
    clearTimeout(timer);
  }
}

function describe(err) {
  if (err?.name === 'AbortError') return 'timeout';
  const cause = err?.cause;
  return String(cause?.code || cause?.message || err?.message || 'error').slice(0, 120);
}

function appendResults(results) {
  mkdirSync(DATA_DIR, { recursive: true });
  const key = dayKey();
  const day = readDay(key) ?? { date: key, checks: {} };
  day.date = key;
  day.checks ??= {};

  for (const { id, result } of results) {
    (day.checks[id] ??= []).push(result);
  }

  writeFileSync(dayFile(key), format(day));
  return key;
}

/** هر بررسی در یک خط — دیف گیت را خوانا نگه می‌دارد و فایل را کوچک. */
function format(day) {
  const ids = Object.keys(day.checks);
  const body = ids.map((id) => {
    const rows = day.checks[id].map((c) => `      ${JSON.stringify(c)}`).join(',\n');
    return `    "${id}": [\n${rows}\n    ]`;
  }).join(',\n');
  return `{\n  "date": "${day.date}",\n  "checks": {\n${body}\n  }\n}\n`;
}

function prune() {
  const cutoff = dayKey(new Date(Date.now() - RETENTION_DAYS * DAY_MS));
  for (const key of listDayKeys()) {
    if (key < cutoff && existsSync(dayFile(key))) {
      rmSync(dayFile(key));
      console.log(`Pruned (older than ${RETENTION_DAYS} days): ${key}.json`);
    }
  }
}

const all = readSites();
const sites = all.filter(isMonitored);
for (const s of all.filter((x) => !isMonitored(x))) {
  console.log(`${s.id.padEnd(14)} skipped — not monitored`);
}
const t = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); // ISO-8601 با دقت ثانیه

const results = await Promise.all(
  sites.map(async (site) => ({ id: site.id, site, result: { t, ...(await checkConfirmed(site)) } })),
);

for (const { site, result } of results) {
  const state = isUp(result) ? 'up' : 'down';
  console.log(`${site.id.padEnd(12)} ${state.padEnd(5)} s=${result.s} ms=${result.ms}${result.e ? ` e=${result.e}` : ''}`);
}

const key = appendResults(results);
prune();
console.log(`Recorded in uptime/data/${key}.json`);
