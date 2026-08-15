#!/usr/bin/env node
// ساخت uptime/index.html از روی فایل‌های داده.
//
// همه‌چیز همین‌جا — موقع ساخت — حساب و رندر می‌شود، نه در مرورگر. نتیجه‌اش این
// است که صفحه بدون هیچ جاوااسکریپتی کامل کار می‌کند: وضعیت، درصدها، نوار
// ۳۰ روز، نمودار و فهرست قطعی‌ها همه HTML و SVG ساکن هستند.
//
// متن صفحه انگلیسی و چیدمانش چپ‌به‌راست است.

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readSites, readIcons, loadChecks, computeUptime, findOutages, avgResponse,
  currentStatus, isUp, isMonitored, WINDOWS, DAY_MS, UPTIME_DIR, MAX_GAP_MS,
  CHECK_EVERY_MIN,
} from './common.mjs';
import { findOutages as outagesOf } from './common.mjs';

const NOW = Date.now();
const SITE_TITLE = 'Service Status';
const STRIP_DAYS = 30;
const TZ = 'Asia/Tehran';

/**
 * فونت‌های جاسازی‌شده در صفحه.
 *
 * Geist برای متن و Geist Mono برای هر چیزی که عدد است — ارقام هم‌عرض و صفرِ
 * خط‌دار باعث می‌شوند ستون‌ها با تغییر عدد تکان نخورند. هر دو SIL OFL هستند،
 * پس انتشارشان در ریپوی عمومی مشکلی ندارد.
 *
 * فقط گلیف‌های لاتین جاسازی می‌شوند؛ رابط انگلیسی است. اگر روزی نام سایتی
 * فارسی شد، فونت فارسی را کنار همین‌ها اضافه کنید.
 */
const FONTS = [
  ['Geist',      'Geist-Light.latin.woff2',       300],
  ['Geist',      'Geist-Regular.latin.woff2',     400],
  ['Geist',      'Geist-Medium.latin.woff2',      500],
  ['Geist Mono', 'GeistMono-Regular.latin.woff2', 400],
];

// ── قالب‌بندی ──────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('en-US');
const dtFull = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, dateStyle: 'medium', timeStyle: 'short',
});
const dtDay = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
const dtTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeStyle: 'short' });

const n = (v) => nf.format(v);
const plural = (count, word) => `${n(count)} ${word}${count === 1 ? '' : 's'}`;

function pct(value) {
  if (value === null) return null;
  if (value >= 99.995) return '100%';
  return `${Number(value.toFixed(2))}%`;
}

function duration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'under a minute';
  if (min < 60) return plural(min, 'minute');
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h < 24) return rest ? `${plural(h, 'hour')} ${plural(rest, 'minute')}` : plural(h, 'hour');
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${plural(d, 'day')} ${plural(hr, 'hour')}` : plural(d, 'day');
}

const ago = (ms) => `${duration(NOW - ms)} ago`;
const at = (ms) => dtFull.format(new Date(ms));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ── نوار ۳۰ روز ────────────────────────────────────────────────────────────

/**
 * چه کسری از ارتفاع میله قرمز شود.
 *
 * نگاشت خطی جواب نمی‌دهد: قطعی‌های واقعی چند درصدِ روزند، پس روزِ یک‌درصدی و
 * روزِ بیست‌درصدی هر دو یک باریکهٔ نازک می‌شدند. با جذر، تفاوت در همان بازه‌ی
 * کوچک باز می‌شود — ۱٪ قطعی حدود ۱۰٪ میله، ۲۰٪ قطعی نزدیک نصف، و روزِ کاملاً
 * پایین تمام میله. کف ۱۵٪ تا کوتاه‌ترین قطعی هم دیده شود.
 */
function downShare(pctUp) {
  const downFraction = Math.min(1, Math.max(0, (100 - pctUp) / 100));
  return Math.min(100, Math.max(15, Math.round(Math.sqrt(downFraction) * 100)));
}

/**
 * برای هر روز یک میله.
 *
 * میله دو تکه است: سهم قرمز از پایین، به اندازه‌ی شدتِ قطعیِ همان روز. پس روزی
 * که پنج دقیقه قطع بوده با روزی که شش ساعت قطع بوده یک شکل ندارند — چیزی که
 * با قرمزِ یکدست گم می‌شد.
 */
function dayStrip(checks) {
  const bars = [];
  for (let i = STRIP_DAYS - 1; i >= 0; i--) {
    const to = Math.min(NOW, NOW - i * DAY_MS);
    const from = to - DAY_MS;
    const day = checks.filter((c) => c.at >= from - DAY_MS && c.at <= to);
    const u = computeUptime(day, from, to);

    if (!(u.coveredMs > 0) || u.pct === null) {
      bars.push(`<i class="none" title="${esc(dtDay.format(new Date(to)))} — no data"></i>`);
      continue;
    }

    const label = `${esc(dtDay.format(new Date(to)))} — ${esc(pct(u.pct))}`;
    if (u.pct >= 99.995) {
      bars.push(`<i title="${label}"></i>`);
      continue;
    }

    const n = outagesOf(day.filter((c) => c.at >= from), to).length;
    const share = downShare(u.pct);
    bars.push(
      `<i class="part" style="--down-share:${share}%" title="${label} · ${plural(n, 'outage')}"></i>`,
    );
  }

  return `<div class="strip">
            <div class="bars">${bars.join('')}</div>
            <div class="legend"><span>${STRIP_DAYS} days ago</span><span>Today</span></div>
          </div>`;
}

// ── نمودار ۲۴ ساعت اخیر (SVG ساکن) ─────────────────────────────────────────

const BUCKETS = 72; // هر خانه ۲۰ دقیقه

function sparkline(checks, key) {
  if (!checks.length) return '';
  const from = NOW - DAY_MS;
  const width = 720, height = 56, pad = 4;
  const slot = DAY_MS / BUCKETS;

  const buckets = Array.from({ length: BUCKETS }, () => ({ sum: 0, n: 0, down: 0 }));
  for (const c of checks) {
    const i = Math.min(BUCKETS - 1, Math.floor((c.at - from) / slot));
    if (i < 0) continue;
    if (isUp(c)) { buckets[i].sum += c.ms ?? 0; buckets[i].n++; } else buckets[i].down++;
  }

  const values = buckets.map((b) => (b.n ? b.sum / b.n : null));
  const seen = values.filter((v) => v !== null);
  // با کمتر از پنج خانه، نمودار یک خط‌خطی بی‌معنی می‌شود. تا داده جمع شود
  // نوار ۳۰ روز کافی است.
  if (seen.length < 5) return '';

  // بازهٔ عمودی را دور خودِ داده می‌بندیم، نه از صفر — وگرنه نوسان دیده نمی‌شود.
  const hi = Math.max(...seen) * 1.1;
  const lo = Math.max(0, Math.min(...seen) * 0.85);
  const span = Math.max(hi - lo, 1);
  const x = (i) => pad + (i + 0.5) * ((width - 2 * pad) / BUCKETS);
  const y = (v) => height - pad - ((v - lo) / span) * (height - 2 * pad);

  // خط، و زیرش یک سطح با گرادیان محو
  const segments = [];
  let current = [];
  values.forEach((v, i) => {
    if (v === null) { if (current.length) segments.push(current); current = []; return; }
    current.push([x(i), y(v)]);
  });
  if (current.length) segments.push(current);

  const line = segments
    .map((pts) => pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' '))
    .join(' ');
  const area = segments
    .filter((pts) => pts.length > 1)
    .map((pts) => {
      const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
      return `${d} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
    })
    .join(' ');

  const downBars = buckets
    .map((b, i) => (b.down
      ? `<rect x="${(x(i) - 3).toFixed(1)}" y="0" width="6" height="${height}" fill="var(--down)" opacity=".16"/>`
      : ''))
    .join('');

  const min = Math.round(Math.min(...seen));
  const max = Math.round(Math.max(...seen));

  return `<div class="spark">
            <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
                 aria-label="Response time over the last 24 hours, between ${n(min)} and ${n(max)} milliseconds">
              <defs>
                <linearGradient id="g-${esc(key)}" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="var(--ink)" stop-opacity=".16"/>
                  <stop offset="1" stop-color="var(--ink)" stop-opacity="0"/>
                </linearGradient>
              </defs>
              ${downBars}
              <path d="${area}" fill="url(#g-${esc(key)})" stroke="none"/>
              <path d="${line}" fill="none" stroke="var(--ink)" stroke-width="1.5" opacity=".7"
                    stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
            </svg>
            <div class="axis"><span>${esc(dtTime.format(new Date(from)))}</span><span class="num">${n(min)}–${n(max)} ms</span><span>now</span></div>
          </div>`;
}

// ── اجزای صفحه ─────────────────────────────────────────────────────────────

function iconHtml(site, icon) {
  if (icon?.dataUri) {
    return `<img class="icon" src="${esc(icon.dataUri)}" alt="" width="30" height="30" loading="lazy">`;
  }
  // سایت آیکون ندارد: دایره با حرف اول نام روی زمینهٔ برند
  return `<span class="icon-letter" aria-hidden="true">${esc([...site.name][0] ?? '?')}</span>`;
}

function statusPill(status) {
  const map = { up: ['up', 'Up'], down: ['down', 'Down'], unknown: ['unknown', 'No data'] };
  const [cls, label] = map[status.state];
  return `<span class="pill ${cls}"><span class="dot"></span>${label}</span>`;
}

/**
 * کارت سایتی که عمداً بررسی نمی‌شود.
 *
 * نه درصدی نشان می‌دهد نه نموداری — چون هیچ بررسی‌ای انجام نشده و هر عددی
 * اینجا از خودمان درآمده است. فقط دلیلش را می‌نویسد و صفرِ واقعی: صفر بررسی.
 */
function pausedCard(site, icon) {
  return `      <div class="card paused">
        <div class="summary-like">
          <div class="head">
            ${iconHtml(site, icon)}
            <span class="title">
              <span class="name">${esc(site.name)}</span>
              <span class="url">${esc(site.url.replace(/^https?:\/\//, ''))}</span>
            </span>
            <span class="pill unknown"><span class="dot"></span>Not monitored</span>
          </div>
          <p class="paused-note">${esc(site.note ?? 'This site is excluded from monitoring.')}</p>
          <p class="paused-count"><span class="num">0</span> checks recorded</p>
        </div>
      </div>`;
}

function statCell(label, value, basis) {
  return `<div class="stat">
              <span class="k">${label}</span>
              <span class="v num${value === null ? ' empty' : ''}">${value ?? '—'}</span>
              <span class="basis">${basis}</span>
            </div>`;
}

function outagesTable(outages) {
  if (!outages.length) return '<p class="none-msg">No outages recorded in the last 30 days.</p>';
  const rows = outages.slice(0, 40).map((o) => `<tr>
                <td class="num">${esc(at(o.startMs))}</td>
                <td class="num">${o.ongoing ? `<span class="ongoing">${esc(duration(o.durationMs))} — ongoing</span>` : esc(duration(o.durationMs))}</td>
                <td class="code">${esc(o.codes.map((c) => c.code).join(', '))}</td>
              </tr>`).join('\n');

  return `<table class="outages">
              <thead><tr><th>Started</th><th>Duration</th><th>Code</th></tr></thead>
              <tbody>
${rows}
              </tbody>
            </table>${outages.length > 40 ? `<p class="hint">${plural(outages.length - 40, 'older outage')} not shown.</p>` : ''}`;
}

function card(site, icon) {
  const checks30 = loadChecks(site.id, NOW - 30 * DAY_MS, NOW);
  const status = currentStatus(checks30);
  const outages = findOutages(checks30, NOW);

  const windows = WINDOWS.map((w) => {
    const from = NOW - w.ms;
    const u = computeUptime(checks30.filter((c) => c.at >= from), from, NOW);
    return { ...w, ...u };
  });

  const day = checks30.filter((c) => c.at >= NOW - DAY_MS);
  const avg = avgResponse(day);
  const avg7 = avgResponse(checks30.filter((c) => c.at >= NOW - 7 * DAY_MS));

  const sinceLine = status.state === 'unknown'
    ? 'No checks recorded for this site yet.'
    : `${status.state === 'up' ? 'Up' : 'Down'} since ${esc(at(status.sinceMs))} — ${esc(ago(status.sinceMs))}`;

  const coverage = windows.map((w) => {
    const cov = w.windowMs ? Math.round((w.coveredMs / w.windowMs) * 100) : 0;
    return `<li>${w.label}: ${plural(w.count, 'check')}, ${cov}% of the window covered${w.gapMs > 0 ? ` (${esc(duration(w.gapMs))} with no data, excluded from the calculation)` : ''}</li>`;
  }).join('\n              ');

  const lastCheckLine = status.lastMs
    ? `<li>Last check: <b>${esc(at(status.lastMs))}</b> — ${esc(ago(status.lastMs))}${
        status.last?.ms != null ? `, responded in ${n(status.last.ms)} ms` : ''}${
        status.last && !isUp(status.last) ? `, code ${esc(status.last.s === 0 ? (status.last.e || 'no response') : String(status.last.s))}` : ''}</li>`
    : '';

  return `      <details class="card"${status.state === 'down' ? ' open' : ''}>
        <summary>
          <div class="head">
            ${iconHtml(site, icon)}
            <span class="title">
              <span class="name">${esc(site.name)}</span>
              <span class="url">${esc(site.url.replace(/^https?:\/\//, ''))}</span>
            </span>
            ${statusPill(status)}
          </div>
          <p class="since">${sinceLine}</p>
          ${dayStrip(checks30)}
          <div class="stats">
${windows.map((w) => statCell(
    `${w.label} uptime`,
    pct(w.pct),
    w.pct === null ? 'no data yet' : `from ${plural(w.count, 'check')}`,
  )).join('\n')}
${statCell('Avg response', avg === null ? null : `${n(avg)}<small>ms</small>`,
    avg7 === null ? 'no data yet' : `last 24h; 7-day ${n(avg7)}`)}
          </div>
          ${sparkline(day, site.id)}
        </summary>
        <div class="detail">
          <h2>Outages — last 30 days</h2>
          ${outagesTable(outages)}
          <h2>Behind the numbers</h2>
          <ul class="facts">
            ${lastCheckLine}
            ${coverage}
            <li>Checked URL: <b>${esc(site.url)}</b> (redirects followed)</li>
            <li>“Up” means an HTTP status between 200 and 399. A gap longer than ${MAX_GAP_MS / 60000} minutes between checks counts as “no data”, not an outage.</li>
          </ul>
        </div>
      </details>`;
}

// ── ساخت صفحه ──────────────────────────────────────────────────────────────

const sites = readSites();
const icons = readIcons();

// سایت‌های بررسی‌نشده در شمارش نمی‌آیند؛ نه بالا حساب می‌شوند نه پایین.
const watched = sites.filter(isMonitored);
const paused = sites.filter((s) => !isMonitored(s));

const live = watched.map((s) => currentStatus(loadChecks(s.id, NOW - 2 * DAY_MS, NOW)).state);
const upCount = live.filter((s) => s === 'up').length;
const downCount = live.filter((s) => s === 'down').length;
const unknownCount = watched.length - upCount - downCount;

const headline = watched.length === 0
  ? 'No sites are being monitored yet.'
  : downCount > 0
    ? `<span class="bad">${n(downCount)}</span> <span class="bad">of ${plural(watched.length, 'service')} ${downCount === 1 ? 'is' : 'are'} down right now.</span>`
    : unknownCount === watched.length
      ? 'No data collected yet.'
      : `<b>${n(upCount)}</b> of ${plural(watched.length, 'service')} ${upCount === 1 ? 'is' : 'are'} up right now.`;

const pausedNote = paused.length
  ? `<p class="stamp">${plural(paused.length, 'site')} not monitored — see below</p>`
  : '';

/**
 * فونت‌ها را به‌صورت data URI داخل CSS می‌گذارد.
 *
 * چرا base64 و نه url() نسبی: مرورگر برای @font-face قواعد CORS را اعمال
 * می‌کند و روی file:// یا data: — یعنی همان جایی که این صفحه باز می‌شود —
 * فونت را بلاک می‌کند و بی‌صدا به فونت پیش‌فرض می‌افتد. با data URI اصلاً
 * درخواستی زده نمی‌شود.
 */
function inlineFonts() {
  return FONTS.map(([family, file, weight]) => {
    const b64 = readFileSync(join(UPTIME_DIR, 'assets', 'fonts', file)).toString('base64');
    return `@font-face {
  font-family: '${family}';
  src: url(data:font/woff2;base64,${b64}) format('woff2');
  font-weight: ${weight};
  font-style: normal;
  font-display: swap;
}`;
  }).join('\n');
}

// توضیحات CSS فارسی‌اند و به درد بینندهٔ صفحه نمی‌خورند؛ موقع جاسازی حذف
// می‌شوند تا خروجی کاملاً انگلیسی و کمی سبک‌تر بماند. (الفبای base64 ستاره
// ندارد، پس این regex به فونت‌های جاسازی‌شده دست نمی‌زند.)
const css = readFileSync(join(UPTIME_DIR, 'lib', 'style.css'), 'utf8')
  .replace('/*@FONTS@*/', inlineFonts)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const pageIcon = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#133566"/><circle cx="16" cy="16" r="6" fill="#fff"/></svg>',
);

const html = `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SITE_TITLE}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#133566">
<link rel="icon" href="${pageIcon}">
<style>
${css}</style>
</head>
<body>
<div class="wrap">
  <header>
    <p class="eyebrow">CONTINUOUS MONITORING</p>
    <h1>${SITE_TITLE}</h1>
    <p class="headline">${headline}</p>
    <p class="stamp">Updated ${esc(at(NOW))} — checked every ${CHECK_EVERY_MIN} minutes</p>
    ${pausedNote}
  </header>

  <main>
${sites.map((s) => (isMonitored(s) ? card(s, icons[s.id]) : pausedCard(s, icons[s.id]))).join('\n')}
  </main>

  <footer>
    <span>Open a card for details and outage history.</span>
    <span>Add or remove a site: <code>Actions</code> tab → “Manage sites” → Run workflow</span>
  </footer>
</div>
</body>
</html>
`;

writeFileSync(join(UPTIME_DIR, 'index.html'), html);
console.log(`Built uptime/index.html — ${plural(sites.length, 'site')}, ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
