// Shared server helpers for Huddle. Files in api/_lib are not public endpoints.
const crypto = require('crypto');

const APP_VERSION = 'huddle-1'; // must match APP_VERSION in index.html and version.json

const env = (k) => process.env[k] || '';
const SUPA_URL = () => env('SUPABASE_URL').replace(/\/+$/, '');
const SUPA_KEY = () => env('SUPABASE_SECRET_KEY');
const SESSION_SECRET = () => env('HUDDLE_SESSION_SECRET');
const configured = () => !!(SUPA_URL() && SUPA_KEY() && SESSION_SECRET() && env('HUDDLE_INVITE_KEY'));

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

// ---- Supabase REST ----
function headers(extra) {
  const key = SUPA_KEY();
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (!key.startsWith('sb_')) h.Authorization = 'Bearer ' + key; // legacy service_role JWT
  return h;
}
async function sb(path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${SUPA_URL()}/rest/v1/${path}`, {
    method, headers: headers(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && (data.message || data.error)) || `Supabase ${r.status}`;
    const err = new HttpError(r.status === 409 ? 409 : 502, msg);
    err.code = data && data.code;
    throw err;
  }
  return data;
}
const q = (v) => encodeURIComponent(v);
const inList = (arr) => `(${arr.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`;
const nowIso = () => new Date().toISOString();

// Today's date in Michigan, as YYYY-MM-DD
function todayLocal() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p; // en-CA formats as YYYY-MM-DD
}

// ---- Secrets: PINs and session tokens ----
function hashPin(pin, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pin), salt + SESSION_SECRET(), 32).toString('hex');
  return `${salt}:${h}`;
}
function checkPin(pin, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const test = hashPin(pin, salt).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(test, 'hex'));
}
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHmac('sha256', SESSION_SECRET()).update(String(t)).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// ---- Settings ----
async function getSettings() {
  const rows = await sb('huddle_settings?select=key,value');
  const out = {};
  for (const r of rows || []) out[r.key] = r.value;
  return out;
}
async function setSetting(key, value) {
  await sb('huddle_settings?on_conflict=key', { method: 'POST', prefer: 'resolution=merge-duplicates', body: [{ key, value }] });
}
// The invite key is HUDDLE_INVITE_KEY until admin regenerates it (then it lives in settings)
async function inviteKey() {
  const s = await getSettings();
  return (s.invite_key && String(s.invite_key)) || env('HUDDLE_INVITE_KEY');
}

function sendError(res, e) {
  const status = e.status || 500;
  if (status >= 500) console.error(e);
  res.status(status).json({ error: e.message || 'server_error' });
}

module.exports = {
  APP_VERSION, env, configured, HttpError, fail, sb, q, inList, nowIso, todayLocal,
  hashPin, checkPin, newToken, hashToken, safeEqual, getSettings, setSetting, inviteKey, sendError, crypto,
};
