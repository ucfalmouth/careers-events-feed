import { mkdir, writeFile } from 'node:fs/promises';

const BASE = 'https://falmouth-csm.symplicity.com/api/public/v1';
const ENDPOINT = process.env.ENDPOINT || '/calendar-events';
const SITE = process.env.SITE_URL || 'https://ucfalmouth.github.io/careers-events-feed'; // your Pages URL
const TOKEN = process.env.SYMPLICITY_TOKEN;
if (!TOKEN) throw new Error('SYMPLICITY_TOKEN is not set');

// CONFIRM against /v1/fields/calendar-events. First match wins.
const FIELDS = {
  id:    ['id'],
  title: ['title', 'label'],
  desc:  ['description'],
  where: ['location'],
  link:  ['externalLink'],
  cat:   ['category']
};

// Pick values and relation objects come back as {id, label}
const flat = v => (v && typeof v === 'object' ? v.label ?? '' : v ?? '');
const pick = (e, names) => {
  for (const n of names) if (e[n] != null && e[n] !== '') return flat(e[n]);
  return '';
};

// Combine date + time into a real Date, treating the values as UK local time
function londonToDate(dateStr, timeStr) {
  if (!dateStr) return null;
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const [hh = 0, mm = 0, ss = 0] = String(timeStr || '00:00:00').split(':').map(Number);
  if (!y || !m || !d) return null;
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const p = Object.fromEntries(
	new Intl.DateTimeFormat('en-GB', {
	  timeZone: 'Europe/London', hour12: false,
	  year: 'numeric', month: '2-digit', day: '2-digit',
	  hour: '2-digit', minute: '2-digit', second: '2-digit'
	}).formatToParts(new Date(guess)).map(x => [x.type, x.value])
  );
  const asLondon = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return new Date(guess - (asLondon - guess));   // shift to the true UTC instant
}

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

const raw = await fetchAll();
if (process.env.DEBUG && raw[0]) console.log('Fields:', Object.keys(raw[0])); // keys only, logs may be public
if (raw.length === 0) throw new Error('API returned no records'); // If job fails, the last good feed stays online, as it does for API errors.

const now = new Date();

// Keep each item's original pubDate from the live feed so it stays stable between builds
const firstSeen = new Map();
try {
  const res = await fetch(`${SITE}/feed.xml`);
  if (res.ok) {
	const xml = await res.text();
	for (const [item] of xml.matchAll(/<item>[\s\S]*?<\/item>/g)) {
	  const guid = item.match(/<guid[^>]*>([^<]*)<\/guid>/)?.[1];
	  const pub = item.match(/<pubDate>([^<]*)<\/pubDate>/)?.[1];
	  const d = pub ? new Date(pub) : null;
	  if (guid && d && !isNaN(d) && d <= now) firstSeen.set(guid, d); // ignore future dates
	}
  }
} catch { /* first run or fetch failed: new items just get "now" */ }

const mapped = raw.map(e => {
  const start = londonToDate(e.date, e.startTime);
  const end = londonToDate(e.date, e.endTime) || start;
  return {
	id: pick(e, FIELDS.id),
	title: pick(e, FIELDS.title) || 'Untitled event',
	desc: pick(e, FIELDS.desc),
	cat: pick(e, FIELDS.cat),
	start, end,
	where: pick(e, FIELDS.where),
	link: pick(e, FIELDS.link) || 'https://falmouth-csm.symplicity.com/'
  };
});

const events = mapped
  .filter(e => e.start && !isNaN(e.start) && e.end >= now)
  .sort((a, b) => a.start - b.start)
  .slice(0, 200);

const fmt = d => new Date(d).toLocaleString('en-GB', {
	dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/London'
  });
  
const fmtShort = d => new Date(d).toLocaleString('en-GB', {
	day: '2-digit', month: '2-digit', year: 'numeric',
	hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London'
  });

const day = d => new Date(d).toLocaleDateString('en-GB', {
	day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London'
  });
  
const items = events.map(e => {
	const guid = xmlEsc(e.id || e.title + e.start);
	const published = firstSeen.get(guid) || now;
	return `  <item>
	  <title>${xmlEsc(`${day(e.start)}: ${e.title}`)}</title>
	  <link>${xmlEsc(e.link)}</link>${e.cat ? `
		<category>${xmlEsc(e.cat)}</category>` : ''}
	  <guid isPermaLink="false">${guid}</guid>
	  <pubDate>${published.toUTCString()}</pubDate>
	  <description>${cdata(
		  `<p><strong>When:</strong> ${fmt(e.start)}${e.end ? ' to ' + fmt(e.end) : ''}</p>` +
		  (e.where ? `<p><strong>Where:</strong> ${e.where}</p>` : '') +
		  (e.desc ? `<p>${e.desc.replace(/\n/g, '<br>')}</p>` : '')
		)}</description>
	</item>`;
  }).join('\n');

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

await mkdir('public', { recursive: true });
await writeFile('public/feed.xml', rss);
console.log(`Wrote ${events.length} events`);
