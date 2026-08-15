#!/usr/bin/env node
// اضافه و حذف کردن سایت از uptime/sites.json
//
//   node uptime/lib/sites.mjs list
//   node uptime/lib/sites.mjs add "آنوبز" https://onwebs.ir [id]
//   node uptime/lib/sites.mjs remove <id>
//
// همین اسکریپت پشت دکمهٔ «مدیریت سایت‌ها» در تب Actions هم اجرا می‌شود.

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import {
  readSites, SITES_FILE, listDayKeys, dayFile, readDay,
} from './common.mjs';

const n = new Intl.NumberFormat('en-US').format;

/** id از روی دامنه ساخته می‌شود: onwebs.ir → onwebs */
function slugFromUrl(url) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const base = host.split('.')[0].replace(/[^a-z0-9-]/gi, '').toLowerCase();
  return base || 'site';
}

function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  throw new Error(`Could not derive a unique id from "${base}"`);
}

function save(sites) {
  const raw = JSON.parse(readFileSync(SITES_FILE, 'utf8'));
  raw.sites = sites;
  writeFileSync(SITES_FILE, JSON.stringify(raw, null, 2) + '\n');
}

function normalizeUrl(input) {
  const url = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const parsed = new URL(url); // اگر آدرس بی‌معنی باشد همین‌جا خطا می‌دهد
  if (!parsed.hostname.includes('.')) throw new Error(`Not a valid URL: ${input}`);
  return parsed.href.replace(/\/$/, '');
}

// ── دستورها ────────────────────────────────────────────────────────────────

function list() {
  const sites = readSites();
  if (!sites.length) return console.log('No sites configured.');
  console.log(`${n(sites.length)} site(s):`);
  for (const s of sites) console.log(`  ${s.id.padEnd(14)} ${s.name.padEnd(16)} ${s.url}`);
}

function add(name, urlInput, wantedId) {
  if (!name || !urlInput) throw new Error('Usage: sites.mjs add "Name" https://example.com [id]');
  const sites = readSites();
  const url = normalizeUrl(urlInput);

  if (sites.some((s) => s.url === url)) throw new Error(`That URL is already monitored: ${url}`);

  const taken = new Set(sites.map((s) => s.id));
  const id = wantedId
    ? (taken.has(wantedId) ? (() => { throw new Error(`Duplicate id: ${wantedId}`); })() : wantedId)
    : uniqueId(slugFromUrl(url), taken);

  sites.push({ id, name: name.trim(), url });
  save(sites);
  console.log(`Added: ${name} (${id}) → ${url}`);
  console.log('Its icon is fetched on the next run of the "Refresh icons" workflow.');
}

/**
 * حذف سایت. تاریخچه‌اش هم از فایل‌های روزانه پاک می‌شود، وگرنه داده‌ای می‌ماند
 * که هیچ‌جا نمایش داده نمی‌شود و فقط ریپو را سنگین می‌کند.
 */
function remove(id) {
  if (!id) throw new Error('Usage: sites.mjs remove <id>');
  const sites = readSites();
  const site = sites.find((s) => s.id === id);
  if (!site) throw new Error(`No site with id "${id}". Run "list" to see them.`);

  save(sites.filter((s) => s.id !== id));

  let cleaned = 0;
  for (const key of listDayKeys()) {
    const day = readDay(key);
    if (!day?.checks?.[id]) continue;
    delete day.checks[id];
    cleaned++;
    if (Object.keys(day.checks).length === 0) {
      if (existsSync(dayFile(key))) rmSync(dayFile(key));
      continue;
    }
    const body = Object.entries(day.checks)
      .map(([sid, rows]) => `    "${sid}": [\n${rows.map((c) => `      ${JSON.stringify(c)}`).join(',\n')}\n    ]`)
      .join(',\n');
    writeFileSync(dayFile(key), `{\n  "date": "${day.date}",\n  "checks": {\n${body}\n  }\n}\n`);
  }

  console.log(`Removed: ${site.name} (${id})`);
  if (cleaned) console.log(`Its history was cleared from ${n(cleaned)} daily file(s).`);
}

// ── اجرا ───────────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'add') add(args[0], args[1], args[2]);
  else if (cmd === 'remove') remove(args[0]);
  else if (cmd === 'list' || !cmd) list();
  else throw new Error(`Unknown command: ${cmd}\nCommands: list | add | remove`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
