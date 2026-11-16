// Huddle data endpoint. Every call: POST /api/huddle  { action, ...fields }
// Headers: x-huddle-token (session), x-huddle-version (app version), x-huddle-admin (admin passcode, admin actions only)
const {
  APP_VERSION, env, configured, fail, sb, q, inList, nowIso, todayLocal,
  hashPin, checkPin, newToken, hashToken, safeEqual, getSettings, setSetting, inviteKey, sendError, crypto,
} = require('./_lib/core');

const ANSWERS = ['going', 'cant', 'maybe'];
const TIME_MODES = ['set', 'allday', 'tbd'];
const KINDS = ['holiday', 'birthday', 'custom'];
const PIN_RE = /^\d{4}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const ID_RE = /^[0-9a-f-]{36}$/i;
const PID_RE = /^[a-z0-9-]{1,40}$/;
const MAX_FAILS = 5, LOCK_MIN = 15;

const PEOPLE_COLS = 'id,name,bday_month,bday_day,has_account,is_admin,pin_hash,pin_fails,pin_locked_until,lead_time_days,partner_id,sort,removed';
const EVENT_COLS = 'id,title,kind,preset_key,subject_id,state,final_date,final_time,time_mode,location,notes,creator_id,created_at,updated_at';

// No actions below read anything before the version check; reads are allowed on an old version
const READS = new Set(['roster', 'boot', 'chat_list', 'admin_check', 'admin_data', 'ping']);
const PUBLIC = new Set(['roster', 'claim', 'signin', 'ping']);

const clean = (s, max) => String(s == null ? '' : s).trim().slice(0, max);
const oneOf = (v, list, msg) => { if (!list.includes(v)) fail(400, msg); return v; };
const day = (v) => { if (!DAY_RE.test(String(v || ''))) fail(400, 'bad_date'); return v; };
const timeOrNull = (v) => (v == null || v === '' ? null : (TIME_RE.test(v) ? v : fail(400, 'bad_time')));
const eid = (v) => { if (!ID_RE.test(String(v || ''))) fail(400, 'bad_id'); return v; };
const pid = (v) => { if (!PID_RE.test(String(v || ''))) fail(400, 'bad_person'); return v; };

// ---------- loaders ----------
async function allPeople() { return (await sb(`huddle_people?select=${PEOPLE_COLS}&order=sort.asc,name.asc`)) || []; }
async function getPerson(id) {
  const rows = await sb(`huddle_people?id=eq.${q(pid(id))}&select=${PEOPLE_COLS}`);
  if (!rows || !rows.length) fail(404, 'person_not_found');
  return rows[0];
}
async function getEvent(id) {
  const rows = await sb(`huddle_events?id=eq.${eid(id)}&deleted=eq.false&select=${EVENT_COLS}`);
  if (!rows || !rows.length) fail(404, 'event_not_found');
  return rows[0];
}
async function invitesOf(eventId) { return ((await sb(`huddle_invites?event_id=eq.${eventId}&select=person_id`)) || []).map((r) => r.person_id); }
async function guardiansOf(personId) { return ((await sb(`huddle_dependents?dependent_id=eq.${q(personId)}&select=guardian_id`)) || []).map((r) => r.guardian_id); }

// Can `me` see this event? Invitees, the creator, and admin.
async function canSee(ev, ctx) {
  if (ctx.admin || ev.creator_id === ctx.me.id) return true;
  return (await invitesOf(ev.id)).includes(ctx.me.id);
}
async function seeOrFail(id, ctx) {
  const ev = await getEvent(id);
  if (!(await canSee(ev, ctx))) fail(404, 'event_not_found');
  return ev;
}
const canManage = (ev, ctx) => ctx.admin || ev.creator_id === ctx.me.id;

// Names as one viewer sees them
async function namesFor(viewerId, people) {
  const ov = (await sb(`huddle_name_overrides?viewer_id=eq.${q(viewerId)}&select=subject_id,name`)) || [];
  const map = {};
  for (const p of people) map[p.id] = p.name;
  for (const o of ov) if (map[o.subject_id] != null) map[o.subject_id] = o.name;
  return map;
}
const publicPerson = (p, names) => ({
  id: p.id, name: names[p.id] || p.name, default_name: p.name, bday_month: p.bday_month, bday_day: p.bday_day,
  has_account: p.has_account, claimed: !!p.pin_hash, lead_time_days: p.lead_time_days, partner_id: p.partner_id,
  is_admin: p.is_admin, removed: p.removed,
});

// Build the full event shape the app uses
async function eventBundle(events) {
  if (!events.length) return [];
  const ids = events.map((e) => e.id);
  const list = inList(ids);
  const [inv, rsvps, opts, msgs] = await Promise.all([
    sb(`huddle_invites?event_id=in.${list}&select=event_id,person_id`),
    sb(`huddle_rsvps?event_id=in.${list}&select=event_id,person_id,answer,answered_by,bringing,updated_at`),
    sb(`huddle_date_options?event_id=in.${list}&select=id,event_id,day,time,added_by,created_at&order=day.asc,time.asc`),
    sb(`huddle_messages?event_id=in.${list}&deleted=eq.false&select=event_id,id,created_at,person_id&order=id.asc`),
  ]);
  const optIds = (opts || []).map((o) => o.id);
  const votes = optIds.length ? await sb(`huddle_votes?option_id=in.${inList(optIds)}&select=option_id,person_id`) : [];
  return events.map((e) => {
    const o = (opts || []).filter((x) => x.event_id === e.id).map((x) => ({
      id: x.id, day: x.day, time: x.time ? String(x.time).slice(0, 5) : null, added_by: x.added_by,
      votes: (votes || []).filter((v) => v.option_id === x.id).map((v) => v.person_id),
    }));
    const r = {};
    for (const x of rsvps || []) if (x.event_id === e.id) r[x.person_id] = { answer: x.answer, answered_by: x.answered_by, bringing: !!x.bringing, updated_at: x.updated_at };
    const m = (msgs || []).filter((x) => x.event_id === e.id);
    return {
      ...e, final_time: e.final_time ? String(e.final_time).slice(0, 5) : null,
      invitees: (inv || []).filter((x) => x.event_id === e.id).map((x) => x.person_id),
      rsvps: r, options: o, msg_count: m.length, last_msg_id: m.length ? m[m.length - 1].id : 0,
      last_msg_at: m.length ? m[m.length - 1].created_at : null,
    };
  });
}

// ---------- sessions ----------
async function startSession(personId) {
  const token = newToken();
  await sb('huddle_sessions', { method: 'POST', body: [{ token_hash: hashToken(token), person_id: personId, created_at: nowIso(), last_seen: nowIso() }] });
  return token;
}
async function sessionFrom(req) {
  const t = req.headers['x-huddle-token'] || '';
  if (!t) fail(401, 'signed_out');
  const rows = await sb(`huddle_sessions?token_hash=eq.${hashToken(t)}&select=token_hash,person_id,is_standalone`);
  if (!rows || !rows.length) fail(401, 'signed_out');
  const me = await getPerson(rows[0].person_id).catch(() => fail(401, 'signed_out'));
  if (me.removed || !me.has_account) fail(401, 'signed_out');
  return { me, session: rows[0], tokenHash: rows[0].token_hash };
}
async function checkInvite(k) {
  const key = await inviteKey();
  if (!safeEqual(k, key)) fail(403, 'bad_invite');
}

// ---------- RSVP helpers ----------
async function upsertRsvp(eventId, personId, answer, answeredBy, bringing) {
  await sb('huddle_rsvps?on_conflict=event_id,person_id', {
    method: 'POST', prefer: 'resolution=merge-duplicates',
    body: [{ event_id: eventId, person_id: personId, answer, answered_by: answeredBy, bringing: !!bringing, updated_at: nowIso() }],
  });
}
// Mark the partner Going on my behalf, unless they've answered for themselves (their own answer always wins)
async function applyBringing(ev, me, on) {
  if (!me.partner_id) return;
  const invited = await invitesOf(ev.id);
  if (!invited.includes(me.partner_id)) return;
  const rows = await sb(`huddle_rsvps?event_id=eq.${ev.id}&person_id=eq.${q(me.partner_id)}&select=answered_by`);
  const theirs = rows && rows[0];
  if (theirs && theirs.answered_by === me.partner_id) return;
  if (on) await upsertRsvp(ev.id, me.partner_id, 'going', me.id, false);
  else if (theirs && theirs.answered_by === me.id) await sb(`huddle_rsvps?event_id=eq.${ev.id}&person_id=eq.${q(me.partner_id)}`, { method: 'DELETE' });
}

// ---------- handlers ----------
const handlers = {
  async ping() { return { ok: true, version: APP_VERSION }; },

  // Join screen: the roster's names, and which are claimed
  async roster(b) {
    await checkInvite(b.k);
    const people = await allPeople();
    return { people: people.filter((p) => p.has_account && !p.removed).map((p) => ({ id: p.id, name: p.name, claimed: !!p.pin_hash })) };
  },

  async claim(b) {
    await checkInvite(b.k);
    if (!PIN_RE.test(String(b.pin || ''))) fail(400, 'bad_pin');
    const p = await getPerson(b.person_id);
    if (!p.has_account || p.removed) fail(404, 'person_not_found');
    if (p.pin_hash) fail(409, 'already_claimed');
    const upd = await sb(`huddle_people?id=eq.${q(p.id)}&pin_hash=is.null`, { method: 'PATCH', prefer: 'return=representation', body: { pin_hash: hashPin(b.pin), pin_fails: 0, pin_locked_until: null } });
    if (!upd || !upd.length) fail(409, 'already_claimed');
    return { token: await startSession(p.id) };
  },

  async signin(b) {
    await checkInvite(b.k);
    if (!PIN_RE.test(String(b.pin || ''))) fail(400, 'bad_pin');
    const p = await getPerson(b.person_id);
    if (!p.has_account || p.removed || !p.pin_hash) fail(404, 'person_not_found');
    if (p.pin_locked_until && new Date(p.pin_locked_until) > new Date()) fail(429, 'locked');
    if (!checkPin(b.pin, p.pin_hash)) {
      const fails = (p.pin_fails || 0) + 1;
      const body = fails >= MAX_FAILS ? { pin_fails: 0, pin_locked_until: new Date(Date.now() + LOCK_MIN * 60e3).toISOString() } : { pin_fails: fails };
      await sb(`huddle_people?id=eq.${q(p.id)}`, { method: 'PATCH', body });
      fail(401, fails >= MAX_FAILS ? 'locked' : 'wrong_pin');
    }
    await sb(`huddle_people?id=eq.${q(p.id)}`, { method: 'PATCH', body: { pin_fails: 0, pin_locked_until: null } });
    return { token: await startSession(p.id) };
  },

  // Everything the app needs, with names as this person sees them
  async boot(b, ctx) {
    const { me } = ctx;
    await sb(`huddle_sessions?token_hash=eq.${ctx.tokenHash}`, { method: 'PATCH', body: { last_seen: nowIso(), is_standalone: !!b.standalone } });
    const [people, settings] = await Promise.all([allPeople(), getSettings()]);
    const names = await namesFor(me.id, people);
    const deps = (await sb('huddle_dependents?select=dependent_id,guardian_id')) || [];
    let events;
    if (me.is_admin) {
      events = (await sb(`huddle_events?deleted=eq.false&select=${EVENT_COLS}&order=created_at.desc`)) || [];
    } else {
      const mine = ((await sb(`huddle_invites?person_id=eq.${q(me.id)}&select=event_id`)) || []).map((r) => r.event_id);
      events = (await sb(`huddle_events?deleted=eq.false&or=(creator_id.eq.${q(me.id)}${mine.length ? `,id.in.${inList(mine)}` : ''})&select=${EVENT_COLS}&order=created_at.desc`)) || [];
    }
    return {
      version: APP_VERSION, today: todayLocal(),
      me: { ...publicPerson(me, names), my_name: me.name },
      people: people.filter((p) => !p.removed).map((p) => publicPerson(p, names)),
      dependents: deps.filter((d) => d.guardian_id === me.id).map((d) => d.dependent_id),
      default_lead_days: Number(settings.default_lead_days) || 21,
      events: await eventBundle(events),
    };
  },

  async rsvp(b, ctx) {
    const { me } = ctx;
    const ev = await seeOrFail(b.event_id, ctx);
    const who = b.person_id ? pid(b.person_id) : me.id;
    const answer = b.answer == null ? null : oneOf(b.answer, ANSWERS, 'bad_answer');
    if (who !== me.id && !ctx.admin) {
      const guards = await guardiansOf(who);
      if (!guards.includes(me.id)) fail(403, 'not_allowed');
    }
    const invited = await invitesOf(ev.id);
    if (!invited.includes(who)) fail(400, 'not_invited');
    if (answer === null) {
      await sb(`huddle_rsvps?event_id=eq.${ev.id}&person_id=eq.${q(who)}`, { method: 'DELETE' });
      if (who === me.id) await applyBringing(ev, me, false);
    } else {
      const bringing = who === me.id && answer === 'going' && !!b.bringing;
      await upsertRsvp(ev.id, who, answer, me.id, bringing);
      if (who === me.id) await applyBringing(ev, me, bringing);
    }
    return { event: (await eventBundle([ev]))[0] };
  },

  async vote(b, ctx) {
    const rows = await sb(`huddle_date_options?id=eq.${eid(b.option_id)}&select=id,event_id`);
    if (!rows || !rows.length) fail(404, 'option_not_found');
    const ev = await seeOrFail(rows[0].event_id, ctx);
    if (ev.state !== 'planning') fail(409, 'date_locked');
    if (b.on) await sb('huddle_votes?on_conflict=option_id,person_id', { method: 'POST', prefer: 'resolution=ignore-duplicates', body: [{ option_id: b.option_id, person_id: ctx.me.id }] });
    else await sb(`huddle_votes?option_id=eq.${b.option_id}&person_id=eq.${q(ctx.me.id)}`, { method: 'DELETE' });
    return { event: (await eventBundle([ev]))[0] };
  },

  async add_option(b, ctx) {
    const ev = await seeOrFail(b.event_id, ctx);
    if (ev.state !== 'planning') fail(409, 'date_locked');
    const existing = (await sb(`huddle_date_options?event_id=eq.${ev.id}&select=id,day,time`)) || [];
    if (existing.length >= 12) fail(400, 'too_many_options');
    const d = day(b.day), t = timeOrNull(b.time);
    if (existing.some((o) => o.day === d && (o.time ? String(o.time).slice(0, 5) : null) === t)) fail(409, 'option_exists');
    const ins = await sb('huddle_date_options', { method: 'POST', prefer: 'return=representation', body: [{ event_id: ev.id, day: d, time: t, added_by: ctx.me.id }] });
    // Adding an option counts as a vote for it
    await sb('huddle_votes', { method: 'POST', body: [{ option_id: ins[0].id, person_id: ctx.me.id }] });
    return { event: (await eventBundle([ev]))[0] };
  },

  async remove_option(b, ctx) {
    const rows = await sb(`huddle_date_options?id=eq.${eid(b.option_id)}&select=id,event_id,added_by`);
    if (!rows || !rows.length) fail(404, 'option_not_found');
    const ev = await seeOrFail(rows[0].event_id, ctx);
    if (!canManage(ev, ctx) && rows[0].added_by !== ctx.me.id) fail(403, 'not_allowed');
    await sb(`huddle_date_options?id=eq.${b.option_id}`, { method: 'DELETE' });
    return { event: (await eventBundle([ev]))[0] };
  },

  async lock(b, ctx) {
    const ev = await seeOrFail(b.event_id, ctx);
    if (!canManage(ev, ctx)) fail(403, 'not_allowed');
    const rows = await sb(`huddle_date_options?id=eq.${eid(b.option_id)}&event_id=eq.${ev.id}&select=day,time`);
    if (!rows || !rows.length) fail(404, 'option_not_found');
    const t = rows[0].time ? String(rows[0].time).slice(0, 5) : null;
    const body = { state: 'locked', final_date: rows[0].day, final_time: t, updated_at: nowIso() };
    if (t && ev.time_mode !== 'set') body.time_mode = 'set';
    await sb(`huddle_events?id=eq.${ev.id}`, { method: 'PATCH', body });
    return { event: (await eventBundle([await getEvent(ev.id)]))[0] };
  },

  // Creator or admin: go back to picking a date (votes are kept)
  async reopen(b, ctx) {
    const ev = await seeOrFail(b.event_id, ctx);
    if (!canManage(ev, ctx)) fail(403, 'not_allowed');
    const opts = (await sb(`huddle_date_options?event_id=eq.${ev.id}&select=id`)) || [];
    if (!opts.length && ev.final_date) {
      const ins = await sb('huddle_date_options', { method: 'POST', prefer: 'return=representation', body: [{ event_id: ev.id, day: ev.final_date, time: ev.final_time, added_by: ctx.me.id }] });
      await sb('huddle_votes', { method: 'POST', body: [{ option_id: ins[0].id, person_id: ctx.me.id }] });
    }
    await sb(`huddle_events?id=eq.${ev.id}`, { method: 'PATCH', body: { state: 'planning', final_date: null, final_time: null, updated_at: nowIso() } });
    return { event: (await eventBundle([await getEvent(ev.id)]))[0] };
  },

  async create_event(b, ctx) {
    const { me } = ctx;
    const title = clean(b.title, 80);
    if (!title) fail(400, 'title_required');
    const kind = oneOf(b.kind, KINDS, 'bad_kind');
    const time_mode = oneOf(b.time_mode, TIME_MODES, 'bad_time_mode');
    const people = await allPeople();
    const valid = new Set(people.filter((p) => !p.removed).map((p) => p.id));
    const invitees = [...new Set([...(Array.isArray(b.invitees) ? b.invitees : []), me.id])].filter((x) => valid.has(x));
    let state, final_date = null, final_time = null, options = [];
    if (b.date_mode === 'set') {
      state = 'locked'; final_date = day(b.day);
      final_time = time_mode === 'set' ? (timeOrNull(b.time) || fail(400, 'time_required')) : null;
    } else if (b.date_mode === 'options') {
      state = 'planning';
      const raw = Array.isArray(b.options) ? b.options : [];
      const seen = new Set();
      for (const o of raw) {
        const d = day(o.day), t = time_mode === 'set' ? timeOrNull(o.time) : null;
        const k = d + (t || '');
        if (!seen.has(k)) { seen.add(k); options.push({ day: d, time: t }); }
      }
      if (options.length < 2 || options.length > 5) fail(400, 'need_2_to_5_options');
    } else fail(400, 'bad_date_mode');
    const subject_id = kind === 'birthday' && b.subject_id && valid.has(b.subject_id) ? b.subject_id : null;
    const ins = await sb('huddle_events', {
      method: 'POST', prefer: 'return=representation',
      body: [{ title, kind, preset_key: clean(b.preset_key, 40) || null, subject_id, state, final_date, final_time, time_mode,
        location: clean(b.location, 160) || null, notes: clean(b.notes, 1000) || null, creator_id: me.id, created_at: nowIso(), updated_at: nowIso() }],
    });
    const ev = ins[0];
    await sb('huddle_invites', { method: 'POST', body: invitees.map((p) => ({ event_id: ev.id, person_id: p })) });
    if (options.length) {
      const os = await sb('huddle_date_options', { method: 'POST', prefer: 'return=representation', body: options.map((o) => ({ event_id: ev.id, day: o.day, time: o.time, added_by: me.id })) });
      await sb('huddle_votes', { method: 'POST', body: os.map((o) => ({ option_id: o.id, person_id: me.id })) });
    }
    await upsertRsvp(ev.id, me.id, 'going', me.id, false);
    return { event: (await eventBundle([ev]))[0] };
  },

  async update_event(b, ctx) {
    const ev = await seeOrFail(b.id, ctx);
    if (!canManage(ev, ctx)) fail(403, 'not_allowed');
    const body = { updated_at: nowIso() };
    if (b.title !== undefined) { body.title = clean(b.title, 80); if (!body.title) fail(400, 'title_required'); }
    if (b.location !== undefined) body.location = clean(b.location, 160) || null;
    if (b.notes !== undefined) body.notes = clean(b.notes, 1000) || null;
    if (b.time_mode !== undefined) body.time_mode = oneOf(b.time_mode, TIME_MODES, 'bad_time_mode');
    const mode = body.time_mode || ev.time_mode;
    if (ev.state === 'locked') {
      if (b.final_date !== undefined) body.final_date = day(b.final_date);
      if (b.final_time !== undefined || b.time_mode !== undefined) {
        body.final_time = mode === 'set' ? (timeOrNull(b.final_time !== undefined ? b.final_time : ev.final_time) || fail(400, 'time_required')) : null;
      }
    }
    await sb(`huddle_events?id=eq.${ev.id}`, { method: 'PATCH', body });
    if (Array.isArray(b.invitees)) {
      const people = await allPeople();
      const valid = new Set(people.filter((p) => !p.removed).map((p) => p.id));
      const want = new Set(b.invitees.filter((x) => valid.has(x)));
      want.add(ev.creator_id);
      const have = new Set(await invitesOf(ev.id));
      const add = [...want].filter((x) => !have.has(x)), drop = [...have].filter((x) => !want.has(x));
      if (add.length) await sb('huddle_invites', { method: 'POST', body: add.map((p) => ({ event_id: ev.id, person_id: p })) });
      if (drop.length) {
        await sb(`huddle_invites?event_id=eq.${ev.id}&person_id=in.${inList(drop)}`, { method: 'DELETE' });
        await sb(`huddle_rsvps?event_id=eq.${ev.id}&person_id=in.${inList(drop)}`, { method: 'DELETE' });
      }
    }
    return { event: (await eventBundle([await getEvent(ev.id)]))[0] };
  },

  async delete_event(b, ctx) {
    const ev = await seeOrFail(b.id, ctx);
    if (!canManage(ev, ctx)) fail(403, 'not_allowed');
    await sb(`huddle_events?id=eq.${ev.id}`, { method: 'PATCH', body: { deleted: true, updated_at: nowIso() } });
    return { ok: true };
  },

  async chat_list(b, ctx) {
    const ev = await seeOrFail(b.event_id, ctx);
    const after = Math.max(0, Number(b.after) || 0);
    const rows = await sb(`huddle_messages?event_id=eq.${ev.id}&id=gt.${after}&select=id,person_id,body,photo_path,created_at,deleted&order=id.asc&limit=300`);
    return { messages: (rows || []).map((m) => (m.deleted ? { id: m.id, person_id: m.person_id, created_at: m.created_at, deleted: true } : m)) };
  },

  async chat_send(b, ctx) {
    const ev = await seeOrFail(b.event_id, ctx);
    const body = clean(b.body, 2000);
    if (!body) fail(400, 'empty');
    const rows = await sb('huddle_messages', { method: 'POST', prefer: 'return=representation', body: [{ event_id: ev.id, person_id: ctx.me.id, body, created_at: nowIso() }] });
    return { message: rows[0] };
  },

  async chat_delete(b, ctx) {
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) fail(400, 'bad_id');
    const rows = await sb(`huddle_messages?id=eq.${id}&select=id,event_id,person_id`);
    if (!rows || !rows.length) fail(404, 'message_not_found');
    await seeOrFail(rows[0].event_id, ctx);
    if (rows[0].person_id !== ctx.me.id && !ctx.admin) fail(403, 'not_allowed');
    await sb(`huddle_messages?id=eq.${id}`, { method: 'PATCH', body: { deleted: true, body: '' } });
    return { ok: true };
  },

  async set_pin(b, ctx) {
    if (!PIN_RE.test(String(b.new_pin || ''))) fail(400, 'bad_pin');
    if (!checkPin(b.old_pin, ctx.me.pin_hash)) fail(401, 'wrong_pin');
    await sb(`huddle_people?id=eq.${q(ctx.me.id)}`, { method: 'PATCH', body: { pin_hash: hashPin(b.new_pin), pin_fails: 0, pin_locked_until: null } });
    return { ok: true };
  },

  async set_lead(b, ctx) {
    const v = b.days == null || b.days === '' ? null : Math.round(Number(b.days));
    if (v !== null && !(v >= 0 && v <= 120)) fail(400, 'bad_days');
    await sb(`huddle_people?id=eq.${q(ctx.me.id)}`, { method: 'PATCH', body: { lead_time_days: v } });
    return { ok: true };
  },

  async signout(b, ctx) {
    await sb(`huddle_sessions?token_hash=eq.${ctx.tokenHash}`, { method: 'DELETE' });
    return { ok: true };
  },

  // ---------- admin (Joe only, with passcode) ----------
  async admin_check() { return { ok: true }; },

  async admin_data() {
    const [people, ov, deps, settings, key, sessions] = await Promise.all([
      allPeople(), sb('huddle_name_overrides?select=subject_id,viewer_id,name'), sb('huddle_dependents?select=dependent_id,guardian_id'),
      getSettings(), inviteKey(), sb('huddle_sessions?select=person_id,last_seen,is_standalone'),
    ]);
    return {
      people: people.map((p) => ({ ...publicPerson(p, {}), locked: !!(p.pin_locked_until && new Date(p.pin_locked_until) > new Date()) })),
      overrides: ov || [], dependents: deps || [], default_lead_days: Number(settings.default_lead_days) || 21,
      invite_key: key, sessions: sessions || [],
    };
  },

  async admin_save_person(b) {
    const name = clean(b.name, 40);
    if (!name) fail(400, 'name_required');
    const m = b.bday_month == null || b.bday_month === '' ? null : Number(b.bday_month);
    const d = b.bday_day == null || b.bday_day === '' ? null : Number(b.bday_day);
    if ((m !== null && !(m >= 1 && m <= 12)) || (d !== null && !(d >= 1 && d <= 31))) fail(400, 'bad_birthday');
    const body = { name, bday_month: m, bday_day: d, has_account: b.has_account !== false };
    let id = b.id;
    if (id) {
      await getPerson(id);
      await sb(`huddle_people?id=eq.${q(id)}`, { method: 'PATCH', body });
    } else {
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'person';
      const people = await allPeople();
      id = base; let n = 2;
      while (people.some((p) => p.id === id)) id = `${base}-${n++}`;
      const sort = Math.max(0, ...people.map((p) => p.sort || 0)) + 1;
      await sb('huddle_people', { method: 'POST', body: [{ id, ...body, sort }] });
    }
    // Partner links go both ways
    if (b.partner_id !== undefined) {
      const me = await getPerson(id);
      const next = b.partner_id ? pid(b.partner_id) : null;
      if (next === id) fail(400, 'bad_partner');
      if (me.partner_id && me.partner_id !== next) await sb(`huddle_people?id=eq.${q(me.partner_id)}&partner_id=eq.${q(id)}`, { method: 'PATCH', body: { partner_id: null } });
      if (next) {
        const other = await getPerson(next);
        if (other.partner_id && other.partner_id !== id) await sb(`huddle_people?id=eq.${q(other.partner_id)}`, { method: 'PATCH', body: { partner_id: null } });
        await sb(`huddle_people?id=eq.${q(next)}`, { method: 'PATCH', body: { partner_id: id } });
      }
      await sb(`huddle_people?id=eq.${q(id)}`, { method: 'PATCH', body: { partner_id: next } });
    }
    if (Array.isArray(b.guardians)) {
      await sb(`huddle_dependents?dependent_id=eq.${q(id)}`, { method: 'DELETE' });
      const g = [...new Set(b.guardians.map(pid))].filter((x) => x !== id);
      if (g.length) await sb('huddle_dependents', { method: 'POST', body: g.map((x) => ({ dependent_id: id, guardian_id: x })) });
    }
    return { id };
  },

  // Soft remove: keeps their old answers and messages readable
  async admin_remove_person(b, ctx) {
    const p = await getPerson(b.id);
    if (p.id === ctx.me.id) fail(400, 'cant_remove_self');
    await sb(`huddle_people?id=eq.${q(p.id)}`, { method: 'PATCH', body: { removed: true, partner_id: null, pin_hash: null } });
    await sb(`huddle_people?partner_id=eq.${q(p.id)}`, { method: 'PATCH', body: { partner_id: null } });
    await sb(`huddle_sessions?person_id=eq.${q(p.id)}`, { method: 'DELETE' });
    return { ok: true };
  },

  async admin_restore_person(b) {
    const p = await getPerson(b.id);
    await sb(`huddle_people?id=eq.${q(p.id)}`, { method: 'PATCH', body: { removed: false } });
    return { ok: true };
  },

  async admin_set_override(b) {
    const s = pid(b.subject_id), v = pid(b.viewer_id);
    const name = clean(b.name, 40);
    await sb(`huddle_name_overrides?subject_id=eq.${q(s)}&viewer_id=eq.${q(v)}`, { method: 'DELETE' });
    if (name) await sb('huddle_name_overrides', { method: 'POST', body: [{ subject_id: s, viewer_id: v, name }] });
    return { ok: true };
  },

  // Clears the PIN so they can pick it again from the invite link; signs them out everywhere
  async admin_reset_pin(b) {
    const p = await getPerson(b.id);
    await sb(`huddle_people?id=eq.${q(p.id)}`, { method: 'PATCH', body: { pin_hash: null, pin_fails: 0, pin_locked_until: null } });
    await sb(`huddle_sessions?person_id=eq.${q(p.id)}`, { method: 'DELETE' });
    return { ok: true };
  },

  async admin_regen_invite() {
    const key = crypto.randomBytes(12).toString('base64url');
    await setSetting('invite_key', key);
    return { invite_key: key };
  },

  async admin_set_default_lead(b) {
    const v = Math.round(Number(b.days));
    if (!(v >= 0 && v <= 120)) fail(400, 'bad_days');
    await setSetting('default_lead_days', v);
    return { ok: true };
  },
};

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'post_only' });
    if (!configured()) return res.status(500).json({ error: 'not_configured' });
    const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) || {};
    const fn = handlers[b.action];
    if (!fn) return res.status(400).json({ error: 'bad_action' });
    // Writes from an old version of the app are rejected so nobody writes with stale rules
    if (!READS.has(b.action) && (req.headers['x-huddle-version'] || '') !== APP_VERSION) {
      return res.status(426).json({ error: 'update_required', version: APP_VERSION });
    }
    let ctx = null;
    if (!PUBLIC.has(b.action)) {
      ctx = await sessionFrom(req);
      const pass = env('HUDDLE_ADMIN_PASSCODE');
      ctx.admin = !!(ctx.me.is_admin && pass && safeEqual(req.headers['x-huddle-admin'], pass));
      if (b.action.startsWith('admin_') && !ctx.admin) return res.status(403).json({ error: ctx.me.is_admin ? 'bad_passcode' : 'not_allowed' });
    }
    const out = await fn(b, ctx);
    res.status(200).json(out);
  } catch (e) { sendError(res, e); }
};
