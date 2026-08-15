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

const nf = new Intl.NumberFormat('en-US');
const n = (v) => nf.format(v);
const plural = (count, word) => `${n(count)} ${word}${count === 1 ? '' : 's'}`;
const fmtDate = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, dateStyle: 'long' }).format(new Date(ms));
const tehranHour = (ms) => Number(new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour: '2-digit', hour12: false,
}).format(new Date(ms)));

const pct = (v) => (v === null ? '—' : `${Number(v.toFixed(2))}%`);
const hour = (h) => `${String(h).padStart(2, '0')}:00`;

function duration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return plural(min, 'minute');
  const h = Math.floor(min / 60), rest = min % 60;
  return rest ? `${plural(h, 'hour')} ${plural(rest, 'minute')}` : plural(h, 'hour');
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
      lines.push(`${n(pattern.hits)} of this week's ${n(pattern.total)} outages started between ${hour(pattern.from)} and ${hour(pattern.to)} Tehran time. A repeat in one narrow band usually means something runs on the server at that hour — a cron job, a backup, or log rotation. Look at scheduled jobs, not traffic.`);
    }

    // ۲. روند زمان پاسخ داخل همین هفته
    if (d.avgFirstHalf && d.avgSecondHalf) {
      const change = (d.avgSecondHalf - d.avgFirstHalf) / d.avgFirstHalf;
      if (change >= 0.2) {
        lines.push(`Response time in the second half of the week was ${Math.round(change * 100)}% higher than the first half (${n(d.avgFirstHalf)} → ${n(d.avgSecondHalf)} ms). The trend is upward; if it continues next week it is worth acting on.`);
      } else if (change <= -0.2) {
        lines.push(`Response time in the second half of the week improved by ${Math.abs(Math.round(change * 100))}% (${n(d.avgFirstHalf)} → ${n(d.avgSecondHalf)} ms).`);
      }
    }

    // ۳. مقایسه با هفتهٔ قبل
    if (d.prevUptime && d.prevUptime.pct !== null && d.uptime.pct !== null) {
      const diff = d.uptime.pct - d.prevUptime.pct;
      if (Math.abs(diff) >= 0.1) {
        lines.push(diff > 0
          ? `Better than last week: ${pct(d.prevUptime.pct)} → ${pct(d.uptime.pct)}.`
          : `Worse than last week: ${pct(d.prevUptime.pct)} → ${pct(d.uptime.pct)}.`);
      }
    }
    if (d.prevAvg && d.avg) {
      const change = (d.avg - d.prevAvg) / d.prevAvg;
      if (Math.abs(change) >= 0.25) {
        lines.push(`Average response time is ${Math.abs(Math.round(change * 100))}% ${change > 0 ? 'higher' : 'lower'} than last week (${n(d.prevAvg)} → ${n(d.avg)} ms).`);
      }
    }

    // ۴. قطعی طولانی
    const longest = d.outages.slice().sort((a, b) => b.durationMs - a.durationMs)[0];
    if (longest && longest.durationMs >= 30 * 60 * 1000) {
      lines.push(`The longest outage lasted ${duration(longest.durationMs)}; code ${longest.codes.map((c) => c.code).join(', ')}.`);
    }

    // ۵. پوشش ناقص داده
    if (d.uptime.gapMs > 3 * 60 * 60 * 1000) {
      lines.push(`${duration(d.uptime.gapMs)} of this week has no checks at all and was excluded from the percentage. Scheduled runs were probably missed, so this week's uptime figure rests on thinner evidence than usual.`);
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
        name: 'Across sites',
        lines: [`${slowest.name} averages ${n(slowest.avg)} ms, noticeably slower than the rest (median ${n(median)} ms). The gap is steady and unrelated to outages — look at the server itself or the network path.`],
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
      '| Site | Uptime | Checks | Avg response | Outages |',
      '| --- | --- | --- | --- | --- |',
      ...withData.map((d) => `| ${d.site.name} | ${pct(d.uptime.pct)} | ${n(d.checks)} | ${d.avg ? `${n(d.avg)} ms` : '—'} | ${n(d.outages.length)} |`),
    ].join('\n')
  : '_No data recorded for this week yet._';

const body = notes.length
  ? notes.map((x) => `### ${x.name}\n\n${x.lines.map((l) => `- ${l}`).join('\n')}`).join('\n\n')
  : totalOutages === 0
    ? 'A quiet week: no outages recorded and no meaningful change in response times.'
    : `${plural(totalOutages, 'outage')} were recorded this week, but no reliable pattern stands out — no repeating hour, no shift in response times.`;

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

let markdown = `# Weekly uptime report — week ${week}, ${year}

${fmtDate(weekStart)} to ${fmtDate(weekEnd)}

${table}

${totalOutages > 0 ? `Total downtime this week: ${duration(totalDownMs)} across ${plural(totalOutages, 'event')}.\n` : ''}
## What the data shows

${body}
`;

const polished = await polish(markdown, digest);
if (polished) markdown = polished;

mkdirSync(REPORTS_DIR, { recursive: true });
writeFileSync(join(REPORTS_DIR, `${slug}.md`), markdown);
console.log(`Wrote uptime/reports/${slug}.md`);
if (!existsSync(join(REPORTS_DIR, `${slug}.md`))) process.exit(1);

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
