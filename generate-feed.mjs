import { mkdir, writeFile } from 'node:fs/promises';

const BASE = 'https://falmouth-csm.symplicity.com/api/public/v1';
const ENDPOINT = process.env.ENDPOINT || '/calendar-events';
const SITE = process.env.SITE_URL || 'https://ucfalmouth.github.io/careers-events-feed/'; // your Pages URL
const TOKEN = process.env.SYMPLICITY_TOKEN;
if (!TOKEN) throw new Error('SYMPLICITY_TOKEN is not set');

// CONFIRM against /v1/fields/calendar-events. First match wins.
const FIELDS = {
  id:    ['id'],
  title: ['label', 'name', 'title'],
  desc:  ['description', 'details', 'overview'],
  start: ['startDate', 'start', 'startDatetime', 'startTime'],
  end:   ['endDate', 'end', 'endDatetime', 'endTime'],
  where: ['location', 'address'],
  link:  ['url', 'link', 'website']
};

// Pick values and relation objects come back as {id, label}
const flat = v => (v && typeof v === 'object' ? v.label ?? '' : v ?? '');
const pick = (e, names) => {
  for (const n of names) if (e[n] != null && e[n] !== '') return flat(e[n]);
  return '';
};

async function fetchAll() {
  const out = [];
  let page = 1, total = Infinity;
  while (out.length < total) {
    const res = await fetch(`${BASE}${ENDPOINT}?perPage=100&page=${page}`, {
      headers: { Authorization: `Token ${TOKEN}`, Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    if (!data.models?.length) break;
    out.push(...data.models);
    total = data.total;
    page++;
  }
  return out;
}

const xmlEsc = s => String(s).replace(/[<>&'"]/g,
  c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const cdata = s => `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const icsDate = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEsc = s => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m);
const fold = line => line.match(/.{1,73}/g).join('\r\n ');

const raw = await fetchAll();
if (process.env.DEBUG && raw[0]) console.log('Fields:', Object.keys(raw[0])); // keys only, logs may be public

const now = new Date();
console.log('API returned:', raw.length, 'records');
if (raw[0]) console.log('Keys:', Object.keys(raw[0]).join(', '));

const mapped = raw.map(e => ({
  id: pick(e, FIELDS.id),
  title: pick(e, FIELDS.title) || 'Untitled event',
  desc: pick(e, FIELDS.desc),
  start: pick(e, FIELDS.start),
  end: pick(e, FIELDS.end),
  where: pick(e, FIELDS.where),
  link: pick(e, FIELDS.link) || 'https://falmouth-csm.symplicity.com/'
}));
console.log('With a start value:', mapped.filter(e => e.start).length);

const events = mapped
  .filter(e => e.start && new Date(e.end || e.start) >= now)
  .sort((a, b) => new Date(a.start) - new Date(b.start))
  .slice(0, 200);
console.log('Upcoming:', events.length);

const fmt = d => new Date(d).toLocaleString('en-GB', {
  dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/London'
});

const items = events.map(e => `  <item>
    <title>${xmlEsc(e.title)}</title>
    <link>${xmlEsc(e.link)}</link>
    <guid isPermaLink="false">${xmlEsc(e.id || e.title + e.start)}</guid>
    <pubDate>${new Date(e.start).toUTCString()}</pubDate>
    <description>${cdata(
      `<p><strong>When:</strong> ${fmt(e.start)}${e.end ? ' to ' + fmt(e.end) : ''}</p>` +
      (e.where ? `<p><strong>Where:</strong> ${e.where}</p>` : '') +
      (e.desc ? `<p>${e.desc}</p>` : '')
    )}</description>
  </item>`).join('\n');

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Careers events</title>
  <link>${xmlEsc(SITE)}</link>
  <description>Upcoming careers events</description>
  <lastBuildDate>${now.toUTCString()}</lastBuildDate>
  <atom:link href="${xmlEsc(SITE)}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
</channel>
</rss>
`;

const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Careers events//EN', 'CALSCALE:GREGORIAN',
  ...events.flatMap(e => [
    'BEGIN:VEVENT',
    `UID:${e.id || e.title + e.start}@falmouth-csm`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(e.start)}`,
    `DTEND:${icsDate(e.end || e.start)}`,
    fold(`SUMMARY:${icsEsc(e.title)}`),
    ...(e.where ? [fold(`LOCATION:${icsEsc(e.where)}`)] : []),
    fold(`DESCRIPTION:${icsEsc(e.desc)}`),
    fold(`URL:${e.link}`),
    'END:VEVENT'
  ]),
  'END:VCALENDAR'].join('\r\n');

await mkdir('public', { recursive: true });
await writeFile('public/feed.xml', rss);
await writeFile('public/events.ics', ics);
console.log(`Wrote ${events.length} events`);
