#!/usr/bin/env node
// ایجنت هفتگی — دادهٔ هفتهٔ گذشته را می‌خواند و در uptime/reports/YYYY-WW.md
// یک خلاصهٔ انگلیسی می‌نویسد.
//
// کارش تفسیر است، نه گزارش خام: فهرست قطعی‌ها را داشبورد نشان می‌دهد، این
// فایل دنبال الگو می‌گردد — تکرار در ساعت مشخص، روند زمان پاسخ، مقایسه با
// هفتهٔ قبل. اگر هفته بی‌اتفاق بود، همان را در یک جمله می‌نویسد.
//
// این ایجنت هیچ سایتی را چک نمی‌کند. آن کار Workflow سنجش است؛ اینجا فقط
// دادهٔ از پیش جمع‌شده خوانده می‌شود.
//
// اگر متغیر ANTHROPIC_API_KEY تنظیم شده باشد، متن نهایی را با Claude
// روان‌تر می‌نویسد. بدون کلید هم کامل کار می‌کند.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  readSites, loadChecks, computeUptime, findOutages, avgResponse, isMonitored,
  REPORTS_DIR, DAY_MS,
} from './common.mjs';

const WEEK_MS = 7 * DAY_MS;
const NOW = Date.now();
const TZ = 'Asia/Tehran';

// گزارش فارسی است، چون جایی که خوانده می‌شود پنل فارسی آنوبز است.
const nf = new Intl.NumberFormat('fa-IR');
const n = (v) => nf.format(v);
// سال نباید جداکنندهٔ هزارگان بگیرد: «۲٬۰۲۶» غلط است.
const nPlain = (v) => new Intl.NumberFormat('fa-IR', { useGrouping: false }).format(v);
const fmtDate = (ms) => new Intl.DateTimeFormat('fa-IR', { timeZone: TZ, dateStyle: 'long' }).format(new Date(ms));
const tehranHour = (ms) => Number(new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour: '2-digit', hour12: false,
}).format(new Date(ms)));

const pct = (v) => (v === null ? '—' : `${n(Number(v.toFixed(2)))}٪`);
const hour = (h) => `${n(h)}:۰۰`;

function duration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'کمتر از یک دقیقه';
  if (min < 60) return `${n(min)} دقیقه`;
  const h = Math.floor(min / 60), rest = min % 60;
  if (h < 24) return rest ? `${n(h)} ساعت و ${n(rest)} دقیقه` : `${n(h)} ساعت`;
  const d = Math.floor(h / 24), hr = h % 24;
  return hr ? `${n(d)} روز و ${n(hr)} ساعت` : `${n(d)} روز`;
}

/** شمارهٔ هفتهٔ ISO — کلید نام فایل گزارش. */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

// ── جمع‌آوری داده ──────────────────────────────────────────────────────────

const weekEnd = NOW;
const weekStart = NOW - WEEK_MS;
const prevStart = NOW - 2 * WEEK_MS;

const sites = readSites().filter(isMonitored);

const data = sites.map((site) => {
  const all = loadChecks(site.id, prevStart, weekEnd);
  const week = all.filter((c) => c.at >= weekStart);
  const prev = all.filter((c) => c.at < weekStart);

  const half = weekStart + WEEK_MS / 2;
  return {
    site,
    checks: week.length,
    uptime: computeUptime(week, weekStart, weekEnd),
    prevUptime: prev.length ? computeUptime(prev, prevStart, weekStart) : null,
    outages: findOutages(week, weekEnd),
    avg: avgResponse(week),
    prevAvg: prev.length ? avgResponse(prev) : null,
    avgFirstHalf: avgResponse(week.filter((c) => c.at < half)),
    avgSecondHalf: avgResponse(week.filter((c) => c.at >= half)),
  };
});

const withData = data.filter((d) => d.checks > 0);

// ── تفسیر ──────────────────────────────────────────────────────────────────

/** آیا قطعی‌ها در یک بازهٔ سه‌ساعته جمع شده‌اند؟ (نشانهٔ کرون‌جاب یا بکاپ) */
function hourPattern(outages) {
  if (outages.length < 2) return null;
  const hours = outages.map((o) => tehranHour(o.startMs));
  let best = null;
  for (let start = 0; start < 24; start++) {
    const band = [start, (start + 1) % 24, (start + 2) % 24];
    const hits = hours.filter((h) => band.includes(h)).length;
    if (!best || hits > best.hits) best = { start, hits };
  }
  const share = best.hits / hours.length;
  if (best.hits < 2 || share < 0.6) return null;
  return { from: best.start, to: (best.start + 3) % 24, hits: best.hits, total: hours.length };
}

function findings() {
  const out = [];

  for (const d of withData) {
    const lines = [];

    // ۱. الگوی ساعتی
    const pattern = hourPattern(d.outages);
    if (pattern) {
      lines.push(`${n(pattern.hits)} قطعی از ${n(pattern.total)} قطعی این هفته بین ساعت ${hour(pattern.from)} و ${hour(pattern.to)} به وقت تهران شروع شده. تکرار در یک بازهٔ باریک معمولاً یعنی چیزی در همان ساعت روی سرور اجرا می‌شود — کرون‌جاب، بکاپ، یا چرخش لاگ. سراغ کارهای زمان‌بندی‌شده بروید، نه ترافیک.`);
    }

    // ۲. روند زمان پاسخ داخل همین هفته
    if (d.avgFirstHalf && d.avgSecondHalf) {
      const change = (d.avgSecondHalf - d.avgFirstHalf) / d.avgFirstHalf;
      if (change >= 0.2) {
        lines.push(`زمان پاسخ در نیمهٔ دوم هفته ${n(Math.round(change * 100))}٪ بیشتر از نیمهٔ اول بوده (${n(d.avgFirstHalf)} → ${n(d.avgSecondHalf)} میلی‌ثانیه). روند صعودی است؛ اگر هفتهٔ بعد هم ادامه داشت، ارزش رسیدگی دارد.`);
      } else if (change <= -0.2) {
        lines.push(`زمان پاسخ در نیمهٔ دوم هفته ${n(Math.abs(Math.round(change * 100)))}٪ بهتر شده (${n(d.avgFirstHalf)} → ${n(d.avgSecondHalf)} میلی‌ثانیه).`);
      }
    }

    // ۳. مقایسه با هفتهٔ قبل
    if (d.prevUptime && d.prevUptime.pct !== null && d.uptime.pct !== null) {
      const diff = d.uptime.pct - d.prevUptime.pct;
      if (Math.abs(diff) >= 0.1) {
        lines.push(diff > 0
          ? `نسبت به هفتهٔ قبل بهتر شده: ${pct(d.prevUptime.pct)} ← ${pct(d.uptime.pct)}.`
          : `نسبت به هفتهٔ قبل بدتر شده: ${pct(d.prevUptime.pct)} ← ${pct(d.uptime.pct)}.`);
      }
    }
    if (d.prevAvg && d.avg) {
      const change = (d.avg - d.prevAvg) / d.prevAvg;
      if (Math.abs(change) >= 0.25) {
        lines.push(`میانگین زمان پاسخ نسبت به هفتهٔ قبل ${n(Math.abs(Math.round(change * 100)))}٪ ${change > 0 ? 'بیشتر' : 'کمتر'} شده (${n(d.prevAvg)} → ${n(d.avg)} میلی‌ثانیه).`);
      }
    }

    // ۴. قطعی طولانی
    const longest = d.outages.slice().sort((a, b) => b.durationMs - a.durationMs)[0];
    if (longest && longest.durationMs >= 30 * 60 * 1000) {
      lines.push(`طولانی‌ترین قطعی ${duration(longest.durationMs)} طول کشید؛ کد ${longest.codes.map((c) => c.code).join('، ')}.`);
    }

    // ۵. پوشش ناقص داده
    if (d.uptime.gapMs > 3 * 60 * 60 * 1000) {
      lines.push(`${duration(d.uptime.gapMs)} از این هفته هیچ بررسی‌ای ندارد و از محاسبهٔ درصد بیرون گذاشته شده. احتمالاً چند اجرا از دست رفته، پس عدد آپتایم این هفته پشتوانهٔ کمتری از همیشه دارد.`);
    }

    if (lines.length) out.push({ name: d.site.name, lines });
  }

  // ۶. یک سایت مدام کندتر از بقیه — فقط وقتی داده‌اش آن‌قدر هست که «مدام»
  //    معنی بدهد؛ با چند بررسی نمی‌شود گفت اختلاف پایدار است.
  const avgs = withData
    .filter((d) => d.avg && d.checks >= 50)
    .map((d) => ({ name: d.site.name, avg: d.avg }));
  if (avgs.length >= 2) {
    const sorted = avgs.slice().sort((a, b) => a.avg - b.avg);
    const slowest = sorted[sorted.length - 1];
    const median = sorted[Math.floor((sorted.length - 1) / 2)].avg;
    if (slowest.avg >= median * 1.8) {
      out.push({
        name: 'بین سایت‌ها',
        lines: [`میانگین پاسخ ${slowest.name} برابر ${n(slowest.avg)} میلی‌ثانیه است، محسوس‌تر از بقیه (میانهٔ ${n(median)} میلی‌ثانیه). این فاصله پایدار است و ربطی به قطعی ندارد — سراغ خود سرور یا مسیر شبکه بروید.`],
      });
    }
  }

  return out;
}

// ── نوشتن گزارش ────────────────────────────────────────────────────────────

const { year, week } = isoWeek(new Date(weekEnd));
const slug = `${year}-${String(week).padStart(2, '0')}`;

const totalOutages = withData.reduce((sum, d) => sum + d.outages.length, 0);
const totalDownMs = withData.reduce((sum, d) => sum + d.outages.reduce((m, o) => m + o.durationMs, 0), 0);
const notes = findings();

const table = withData.length
  ? [
      '| سایت | آپتایم | بررسی | میانگین پاسخ | قطعی |',
      '| --- | --- | --- | --- | --- |',
      ...withData.map((d) => `| ${d.site.name} | ${pct(d.uptime.pct)} | ${n(d.checks)} | ${d.avg ? `${n(d.avg)} ms` : '—'} | ${n(d.outages.length)} |`),
    ].join('\n')
  : '_برای این هفته هنوز داده‌ای ثبت نشده._';

const body = notes.length
  ? notes.map((x) => `### ${x.name}\n\n${x.lines.map((l) => `- ${l}`).join('\n')}`).join('\n\n')
  : totalOutages === 0
    ? 'هفتهٔ بی‌اتفاقی بود: هیچ قطعی‌ای ثبت نشد و تغییر معناداری در زمان پاسخ دیده نمی‌شود.'
    : `این هفته ${n(totalOutages)} قطعی ثبت شد، ولی الگوی قابل اتکایی در آن‌ها نیست — نه ساعت تکرارشونده‌ای، نه تغییری در زمان پاسخ.`;

const digest = {
  week: slug,
  from: new Date(weekStart).toISOString(),
  to: new Date(weekEnd).toISOString(),
  totalOutages,
  totalDownMs,
  sites: withData.map((d) => ({
    id: d.site.id,
    name: d.site.name,
    uptimePct: d.uptime.pct,
    prevUptimePct: d.prevUptime?.pct ?? null,
    checks: d.checks,
    gapMs: d.uptime.gapMs,
    avgMs: d.avg,
    prevAvgMs: d.prevAvg,
    avgFirstHalfMs: d.avgFirstHalf,
    avgSecondHalfMs: d.avgSecondHalf,
    outages: d.outages.map((o) => ({
      startTehranHour: tehranHour(o.startMs),
      durationMs: o.durationMs,
      codes: o.codes.map((c) => c.code),
    })),
  })),
};

let markdown = `# گزارش هفتگی آپتایم — هفتهٔ ${n(week)} سال ${nPlain(year)}

${fmtDate(weekStart)} تا ${fmtDate(weekEnd)}

${table}

${totalOutages > 0 ? `مجموع زمان قطعی این هفته: ${duration(totalDownMs)} در ${n(totalOutages)} رویداد.\n` : ''}
## داده چه می‌گوید

${body}
`;

const polished = await polish(markdown, digest);
if (polished) markdown = polished;

mkdirSync(REPORTS_DIR, { recursive: true });
writeFileSync(join(REPORTS_DIR, `${slug}.md`), markdown);
console.log(`Wrote uptime/reports/${slug}.md`);
if (!existsSync(join(REPORTS_DIR, `${slug}.md`))) process.exit(1);

await push();

/**
 * همان زیرمجموعه‌ای از Markdown که خودمان تولید می‌کنیم را به HTML تبدیل
 * می‌کند: سرتیتر، جدول، فهرست، پاراگراف و تأکید.
 *
 * عمداً کتابخانه‌ای اضافه نشده — نه اینجا و نه در پنل — چون هاست نمی‌تواند
 * پکیج تازه نصب کند. پنل خروجی را قبل از نمایش با sanitize-html پاک می‌کند.
 */
function toHtml(md) {
  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const inline = (t) =>
    esc(t)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)_([^_]+)_(?=\s|$|[.،:])/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const out = [];
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length + 1); // # → h2، تا h1 برای عنوان صفحه بماند
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // جدول: سطر سرستون، سطر جداکننده، بعد بدنه
    if (line.startsWith('|') && lines[i + 1]?.replace(/[\s|:-]/g, '') === '') {
      const cells = (row) => row.split('|').slice(1, -1).map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) { rows.push(cells(lines[i])); i++; }
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      );
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^([-*]\s|#|\|)/.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

/** گزارش را به پنل می‌فرستد. نرسیدنش نباید اجرا را قرمز کند — فایل در ریپو هست. */
async function push() {
  const endpoint = process.env.UPTIME_ENDPOINT;
  const token = process.env.UPTIME_TOKEN;
  if (!endpoint || !token) {
    console.log('UPTIME_ENDPOINT/UPTIME_TOKEN not set — report written to the repo only.');
    return;
  }

  const payload = {
    kind: 'report',
    week: slug,
    from: new Date(weekStart).toISOString(),
    to: new Date(weekEnd).toISOString(),
    generatedAt: new Date(NOW).toISOString(),
    totalOutages,
    totalDownMs,
    markdown,
    html: toHtml(markdown),
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        console.log(`Report pushed to ${new URL(endpoint).host} — HTTP ${res.status}`);
        return;
      }
      console.log(`Attempt ${attempt}: HTTP ${res.status}`);
      if (res.status === 401 || res.status === 404) return;
    } catch (err) {
      console.log(`Attempt ${attempt}: ${err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 5000));
  }
  console.log('Report push gave up — the file is still committed to the repo.');
}

// ── بازنویسی اختیاری با Claude ─────────────────────────────────────────────

/**
 * اگر ANTHROPIC_API_KEY تنظیم شده باشد، همین تحلیل را به Claude می‌دهد تا
 * روان‌تر بنویسد. عمداً «تحلیل کن» نمی‌گوید — تحلیل بالا انجام شده و قطعی
 * است؛ کار مدل فقط نوشتن است، تا عددی از خودش در نیاورد.
 */
async function polish(draft, facts) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    const res = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4000,
      system: [
        'You write a weekly uptime report in English. You are given a draft and the raw data behind it.',
        'Use only the numbers you are given; never introduce a figure or an event that is not in the data.',
        'Do not restate the list of outages — the dashboard already shows it. Write the pattern and what it means.',
        'If the week was uneventful, say so in one sentence and stop. A long report about a quiet week is not worth reading.',
        'Output Markdown only, with no commentary about what you did. Keep the table at the top exactly as it is.',
      ].join('\n'),
      messages: [{
        role: 'user',
        content: `Raw data:\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\`\n\nDraft:\n\n${draft}`,
      }],
    });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (text.length < 80) return null; // پاسخ ناقص، پیش‌نویس بهتر است
    console.log('Report text rewritten with Claude.');
    return `${text}\n`;
  } catch (err) {
    console.log(`Claude rewrite skipped (${err?.message ?? err}) — keeping the draft.`);
    return null;
  }
}
