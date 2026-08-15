#!/usr/bin/env node
// گرفتن فهرست سایت‌ها از پنل ادمین و نوشتنش در uptime/sites.json
//
// مرجعِ فهرست، پنل است نه این ریپو. دلیلش جهت شبکه است: سرور سایت در ایران
// است و دسترسی‌اش به api.github.com قابل اتکا نیست، ولی runner گیت‌هاب بیرون
// است و onwebs.ir را بی‌مشکل می‌بیند. پس به‌جای اینکه پنل روی گیت‌هاب بنویسد،
// گیت‌هاب از پنل می‌خواند.
//
// اگر پنل در دسترس نبود یا پاسخش بی‌معنی بود، فایل فعلی دست‌نخورده می‌ماند و
// بررسی‌ها با همان فهرست قبلی ادامه پیدا می‌کنند — یک قطعیِ پنل نباید رصد را
// بخواباند.

import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { SITES_FILE } from './common.mjs';

/**
 * به Workflow می‌گوید فهرست عوض شد یا نه.
 *
 * مرحله‌ی گرفتن آیکون به همین وابسته است: آیکون و لوگو عوض نمی‌شوند، پس
 * فقط وقتی لازم است که سایتی تازه اضافه شده باشد.
 */
function report(changed) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed ? 'true' : 'false'}\n`);
  }
}

// همان مسیر /api/uptime است: GET فهرست می‌دهد و POST بسته را می‌گیرد.
const endpoint = process.env.UPTIME_SITES_ENDPOINT || process.env.UPTIME_ENDPOINT;
const token = process.env.UPTIME_TOKEN;

if (!endpoint || !token) {
  console.log('UPTIME_ENDPOINT/UPTIME_TOKEN not set — keeping the committed site list.');
  report(false);
  process.exit(0);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 20_000);

try {
  const res = await fetch(endpoint, {
    signal: controller.signal,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) {
    console.log(`Panel returned HTTP ${res.status} — keeping the committed site list.`);
    report(false);
    process.exit(0);
  }

  const body = await res.json();
  const sites = Array.isArray(body?.sites) ? body.sites : null;
  if (!sites) {
    console.log('Panel response had no site list — keeping the committed one.');
    report(false);
    process.exit(0);
  }

  // اعتبارسنجی قبل از نوشتن: یک پاسخ خراب نباید فهرست سالم را از بین ببرد.
  const seen = new Set();
  const clean = [];
  for (const s of sites) {
    if (typeof s?.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/i.test(s.id)) continue;
    if (typeof s?.url !== 'string') continue;
    let url;
    try { url = new URL(s.url); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);

    const site = { id: s.id, name: String(s.name || s.id).slice(0, 80), url: s.url };
    if (s.monitor === false) {
      site.monitor = false;
      if (s.note) site.note = String(s.note).slice(0, 400);
    }
    clean.push(site);
  }

  if (!clean.length) {
    console.log('Panel sent an empty list — keeping the committed one (refusing to wipe every site).');
    report(false);
    process.exit(0);
  }

  const before = readFileSync(SITES_FILE, 'utf8');
  const after = JSON.stringify({ sites: clean }, null, 2) + '\n';
  if (before === after) {
    console.log(`Site list unchanged (${clean.length} sites).`);
    report(false);
    process.exit(0);
  }

  writeFileSync(SITES_FILE, after);
  console.log(`Site list updated from the panel: ${clean.length} sites.`);
  report(true);
} catch (err) {
  console.log(`Could not reach the panel (${err?.message ?? err}) — keeping the committed site list.`);
  report(false);
} finally {
  clearTimeout(timer);
}
