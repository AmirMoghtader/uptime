#!/usr/bin/env node
// گرفتن فاوآیکون سایت‌ها و ذخیرهٔ آن‌ها به‌صورت data URI در uptime/icons.json
//
// چرا اینجا و نه در مرورگر: اگر صفحه موقع نمایش آیکون را از خود سایت یا از یک
// سرویس آیکون بگیرد، هم به شبکهٔ بازدیدکننده وابسته می‌شود هم یک درخواست
// خارجی اضافه می‌کند. صفحه باید خودکفا باشد.
//
// این اسکریپت هفته‌ای یک بار اجرا می‌شود، نه هر ۵ دقیقه.

import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSites, readIcons, ICONS_FILE } from './common.mjs';

const MAX_BYTES = 32 * 1024;
const TIMEOUT_MS = 20_000;
const UA = 'OnwebsUptimeBot/1.0 (+https://github.com/onwebs/uptime)';

async function get(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': UA },
    });
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** آدرس آیکون‌های نامزد را از HTML صفحهٔ اصلی در می‌آورد، به‌ترتیب اولویت. */
function candidatesFromHtml(html, baseUrl) {
  const found = [];
  const linkTag = /<link\b[^>]*>/gi;
  for (const [tag] of html.matchAll(linkTag)) {
    const rel = attr(tag, 'rel')?.toLowerCase();
    if (!rel || !/\bicon\b/.test(rel)) continue;
    const href = attr(tag, 'href');
    if (!href || href.startsWith('data:')) continue;
    const sizes = attr(tag, 'sizes') ?? '';
    const px = parseInt(sizes, 10);
    found.push({
      url: new URL(href, baseUrl).href,
      // نزدیک‌ترین به ۳۲ پیکسل بهترین است؛ apple-touch-icon آخرین انتخاب
      rank: (rel.includes('apple') ? 1000 : 0) + (Number.isFinite(px) ? Math.abs(px - 32) : 100),
    });
  }
  return found.sort((a, b) => a.rank - b.rank).map((c) => c.url);
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4]) : null;
}

function toDataUri(buf, type) {
  return `data:${type};base64,${buf.toString('base64')}`;
}

/**
 * اگر تصویر بزرگ بود، به ۳۲×۳۲ کوچکش می‌کند.
 *
 * روی runner گیت‌هاب ImageMagick از پیش نصب است؛ روی مک `sips` همیشه هست.
 * هر کدام که پیدا شد استفاده می‌شود تا اجرای محلی هم همان نتیجهٔ Workflow را
 * بدهد.
 */
function shrink(buf, type) {
  const dir = mkdtempSync(join(tmpdir(), 'icon-'));
  const src = join(dir, 'in');
  const out = join(dir, 'out.png');

  const tools = [
    ['magick', () => [`${src}${type === 'image/x-icon' ? '[0]' : ''}`, '-resize', '32x32', out]],
    ['convert', () => [`${src}${type === 'image/x-icon' ? '[0]' : ''}`, '-resize', '32x32', out]],
    ['sips', () => ['-s', 'format', 'png', '-Z', '32', src, '--out', out]],
  ];

  try {
    writeFileSync(src, buf);
    for (const [bin, args] of tools) {
      try {
        execFileSync(bin, args(), { stdio: 'ignore' });
      } catch {
        continue; // ابزار نبود یا این فرمت را نفهمید؛ بعدی را امتحان کن
      }
      if (!existsSync(out)) continue;
      const small = readFileSync(out);
      if (small.length && small.length <= MAX_BYTES) return { buf: small, type: 'image/png' };
    }
    return null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function fetchIcon(site) {
  const urls = [];

  // ۱. از روی <link rel="icon"> صفحهٔ اصلی
  const page = await get(site.url);
  if (page) {
    try {
      const html = (await page.text()).slice(0, 200_000); // فقط ابتدای سند لازم است
      urls.push(...candidatesFromHtml(html, page.url));
    } catch { /* بی‌خیال، سراغ favicon.ico */ }
  }

  // ۲. اگر نبود، /favicon.ico
  urls.push(new URL('/favicon.ico', page?.url ?? site.url).href);

  for (const url of [...new Set(urls)].slice(0, 6)) {
    const res = await get(url);
    if (!res) continue;
    let buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) continue;

    let type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) type = guessType(url, buf);
    if (!type) continue;

    // ۳. تبدیل به data URI، و در صورت لزوم کوچک‌سازی به ۳۲×۳۲
    if (buf.length > MAX_BYTES) {
      const smaller = type === 'image/svg+xml' ? null : shrink(buf, type);
      if (!smaller) { console.log(`  ${url} → larger than 32 KB and could not be resized`); continue; }
      ({ buf, type } = smaller);
    }

    return { dataUri: toDataUri(buf, type), source: url, bytes: buf.length, type };
  }
  return null;
}

function guessType(url, buf) {
  const ext = new URL(url).pathname.split('.').pop()?.toLowerCase();
  if (ext === 'svg' || buf.slice(0, 200).toString('utf8').trimStart().startsWith('<svg')) return 'image/svg+xml';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString('utf8') === 'RIFF') return 'image/webp';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01) return 'image/x-icon';
  if (ext === 'ico') return 'image/x-icon';
  if (ext === 'png') return 'image/png';
  return null;
}

const all = readSites();
const previous = readIcons();
const icons = {};
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// با --missing فقط سایت‌هایی که هنوز آیکون ندارند گرفته می‌شوند.
//
// این حالت هر ده دقیقه کنار بررسی‌ها اجرا می‌شود تا سایتی که تازه از پنل
// اضافه شده، همان اجرا آیکونش را بگیرد و کارتش خالی نماند. تازه‌سازی کاملِ
// همه‌ی آیکون‌ها همچنان هفته‌ای یک بار است.
const onlyMissing = process.argv.includes('--missing');
const sites = onlyMissing ? all.filter((s) => !previous[s.id]) : all;

// آیکون‌های موجود باید حفظ شوند، وگرنه فایل با هر اجرای --missing خالی می‌شود.
if (onlyMissing) {
  for (const [id, icon] of Object.entries(previous)) icons[id] = icon;
  if (!sites.length) {
    console.log('Every site already has an icon — nothing to fetch.');
    process.exit(0);
  }
  console.log(`${sites.length} site(s) without an icon.`);
}

for (const site of sites) {
  console.log(`${site.id}: ${site.url}`);
  const icon = await fetchIcon(site);
  if (icon) {
    icons[site.id] = { ...icon, fetchedAt: now };
    console.log(`  ✓ ${icon.type} — ${icon.bytes} bytes — ${icon.source}`);
  } else if (previous[site.id]) {
    // آیکون قبلی را نگه می‌داریم؛ یک بار به‌دست‌نیامدن دلیل حذف نیست
    icons[site.id] = previous[site.id];
    console.log('  ! could not fetch; kept the previous icon');
  } else {
    // «آیکون ندارد» هم یک نتیجه است و ثبت می‌شود، وگرنه حالت --missing هر ده
    // دقیقه سراغ سایتی می‌رفت که اصلاً فاوآیکونی ندارد. تازه‌سازی هفتگی
    // دوباره امتحانش می‌کند، چون ممکن است بعداً آیکون بگذارند.
    icons[site.id] = { none: true, fetchedAt: now };
    console.log('  ! no icon found — the dashboard shows the first letter of the name');
  }
}

writeFileSync(ICONS_FILE, JSON.stringify({ generatedAt: now, icons }, null, 1) + '\n');
const withIcon = Object.values(icons).filter((i) => i?.dataUri).length;
console.log(`Wrote uptime/icons.json (${withIcon} icons, ${Object.keys(icons).length - withIcon} without one)`);
if (!existsSync(ICONS_FILE)) process.exit(1);
