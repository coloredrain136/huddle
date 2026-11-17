// Live calendar feed: GET /cal/<token>.ics (rewritten to /api/cal?f=<token>.ics)
// Apple / Google / Outlook subscribe to this URL and re-check it on their own schedule.
// Lists the person's invited events that have a locked date, except ones they said they can't make.
const { configured, sb, q, inList } = require('./_lib/core');

const TZ = 'America/Detroit';
const HOURS = 3; // events only store a start time; assume 3 hours
const SITE = 'https://huddle.zerogee.dev';

const VTIMEZONE = [
  'BEGIN:VTIMEZONE', `TZID:${TZ}`,
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Fold lines to 75 octets as the spec asks
function fold(line) {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;
  const out = []; let cur = '', len = 0, limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (len + n > limit) { out.push(cur); cur = ' '; len = 1; limit = 75; }
    cur += ch; len += n;
  }
  out.push(cur);
  return out.join('\r\n');
}
const pad = (n) => String(n).padStart(2, '0');
const dateOnly = (d) => d.replace(/-/g, '');
function addDay(d) { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); }
// Local wall time + hours, still as local wall time (no zone math needed)
function localPlus(day, time, hours) {
  const [y, m, d] = day.split('-').map(Number); const [h, mi] = time.split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, h + hours, mi));
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00`;
}
const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

module.exports = async (req, res) => {
  const send = (status, body, type = 'text/plain; charset=utf-8') => { res.statusCode = status; res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'no-cache, no-store, max-age=0'); res.end(body); };
  try {
    if (!configured()) return send(500, 'not configured');
    const raw = String((req.query && (req.query.f || req.query.t)) || '').replace(/\.ics$/, '');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(raw)) return send(404, 'not found');
    const ppl = await sb(`huddle_people?cal_token=eq.${q(raw)}&removed=eq.false&select=id,name`);
    if (!ppl || !ppl.length) return send(404, 'not found');
    const me = ppl[0];
    const inv = ((await sb(`huddle_invites?person_id=eq.${q(me.id)}&select=event_id`)) || []).map((r) => r.event_id);
    let events = [];
    if (inv.length) events = (await sb(`huddle_events?id=in.${inList(inv)}&deleted=eq.false&state=eq.locked&select=id,title,final_date,final_time,time_mode,location,notes,updated_at,created_at`)) || [];
    const mine = inv.length ? ((await sb(`huddle_rsvps?person_id=eq.${q(me.id)}&event_id=in.${inList(inv)}&select=event_id,answer`)) || []) : [];
    const cant = new Set(mine.filter((r) => r.answer === 'cant').map((r) => r.event_id));
    const now = stamp(new Date().toISOString());
    const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Huddle//Family Events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:Huddle', `X-WR-TIMEZONE:${TZ}`, 'X-WR-CALDESC:Family get-togethers from Huddle', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H', ...VTIMEZONE];
    for (const e of events) {
      if (cant.has(e.id) || !e.final_date) continue;
      const day = String(e.final_date).slice(0, 10);
      const time = e.final_time ? String(e.final_time).slice(0, 5) : null;
      const timed = e.time_mode === 'set' && time;
      const notes = [e.time_mode === 'tbd' ? 'Time TBD' : '', e.notes || '', `Open in Huddle: ${SITE}/#/e/${e.id}`].filter(Boolean).join('\n\n');
      L.push('BEGIN:VEVENT', `UID:${e.id}@huddle.zerogee.dev`, `DTSTAMP:${now}`,
        `LAST-MODIFIED:${stamp(e.updated_at || e.created_at)}`, `SEQUENCE:${Math.max(0, Math.floor((new Date(e.updated_at || e.created_at) - new Date('2026-01-01')) / 1000))}`);
      if (timed) L.push(`DTSTART;TZID=${TZ}:${localPlus(day, time, 0)}`, `DTEND;TZID=${TZ}:${localPlus(day, time, HOURS)}`);
      else L.push(`DTSTART;VALUE=DATE:${dateOnly(day)}`, `DTEND;VALUE=DATE:${dateOnly(addDay(day))}`, 'TRANSP:TRANSPARENT');
      L.push(`SUMMARY:${esc(e.title)}`);
      if (e.location) L.push(`LOCATION:${esc(e.location)}`);
      L.push(`DESCRIPTION:${esc(notes)}`, `URL:${SITE}/#/e/${e.id}`, 'STATUS:CONFIRMED', 'END:VEVENT');
    }
    L.push('END:VCALENDAR');
    res.setHeader('Content-Disposition', 'inline; filename="huddle.ics"');
    send(200, L.map(fold).join('\r\n') + '\r\n', 'text/calendar; charset=utf-8');
  } catch (e) {
    console.error(e);
    send(500, 'error');
  }
};
