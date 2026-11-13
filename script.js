/* =====================================================================
   Lynbrook Badminton · Firebase Firestore edition (ES module)

   Firestore layout
     roster/{studentId}        { firstName, lastName, gender, division, grade }
     users/{studentId}         { password (salted SHA-256 hash), role, studentId, style }
     attendance/{date_session_studentId}
                               { studentId, firstName, lastName, division, date,
                                 sessionType, status, timestamp, by? }
     lineups/{matchDate}       { date, V:{BS1:[ids]...}, J:{...}, names:{id:"First Last"} }
     matches/{id}              { date, time, away, home }  or  { date, time, text }
     overrides/{date_session}  { date, type, start, end, cancelled, note }
     announcements/{id}        { title, body, order }
     checklist/{id}            { label, order }
     clearance/{studentId}     { done:{itemId:true}, donated }
     config/init               { matches, announcements, checklist }  (seed flags)
     config/admin              { salt, hash }                         (admin code)

   How data flows: each page opens live onSnapshot listeners for just the
   collections it needs, keeps the results in an in-memory cache, and redraws
   when anything changes (so a check-in on a phone shows up on the coach's
   laptop right away). Writes go straight to Firestore.

   Only per-device things stay in the browser: who is logged in on this
   device, the admin unlock for this tab, which admin tab is open, and which
   announcements this device has read.
   ===================================================================== */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { initializeFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, onSnapshot, query, where, writeBatch } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAT6MwQqksqZz1hAMUx3ugiGTsx9IOxW5U',
  authDomain: 'lynbrook-badminton.firebaseapp.com',
  projectId: 'lynbrook-badminton',
  storageBucket: 'lynbrook-badminton.firebasestorage.app',
  messagingSenderId: '300479637993',
  appId: '1:300479637993:web:0325a3d80f47b1cf7a8378',
  measurementId: 'G-5PH401CSLM'
};
// Auto-detect long-polling so Firestore still connects behind school/office proxies that block streaming connections.
const db = initializeFirestore(initializeApp(firebaseConfig), { experimentalAutoDetectLongPolling: true });

/* ---------- small helpers ---------- */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const keep = area => ({ // per-device storage (session + UI preferences only, never shared data)
  get(k, d) { try { const v = area.getItem('lhsb:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { area.setItem('lhsb:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { area.removeItem('lhsb:' + k); } catch {} }
});
const local = keep(localStorage), sess = keep(sessionStorage);
const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const today = () => iso(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T00:00'); d.setDate(d.getDate() + n); return iso(d); };
const dayOf = s => new Date(s + 'T00:00').getDay();
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const fmt = s => new Date(s + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const shortD = s => +s.slice(5, 7) + '/' + +s.slice(8);
const fmtT = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'); };
const TYPES = ['varsity', 'jv', 'open'];
const TYPE = { varsity: 'Varsity Practice', jv: 'JV Practice', open: 'Saturday Open Gym' };
const STATUS = { present: 'Present', excused: 'Excused Absent', unexcused: 'Unexcused Absent' };
const SHORT = { present: 'Present', excused: 'Excused', unexcused: 'Unexcused' };
const st = r => r.status || 'present';
const badge = r => `<span class="badge st-${st(r)}">${STATUS[st(r)]}</span>`;
const normId = s => String(s ?? '').trim().toLowerCase(); // student IDs are stored lower-case and are used as Firestore document IDs
const sameId = (a, b) => normId(a) === normId(b);
const fullName = p => `${p.first || ''} ${p.last || ''}`.trim();
const sha256 = async s => {
  if (!globalThis.crypto?.subtle) throw Object.assign(new Error('crypto.subtle is only available on https or localhost'), { code: 'insecure-context' });
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
};
const hashPw = (id, pw) => sha256(`lhsb|${normId(id)}|${pw}`);

/* ---------- data you may want to edit ---------- */
const DONATE_URL = ''; // paste your team donation link (Venmo, PayPal, booster club page...) to show a Donate button
const PAGES = [['index.html','Home'],['schedule.html','Schedule'],['attendance.html','Check-In'],['portal.html','Portal'],['admin.html','Admin']];
// Default weekly schedule. Day numbers: 0 = Sun ... 6 = Sat; 24-hour times. Only Saturday Open Gym is scheduled by default.
// Varsity and JV practices appear only when a coach adds them in the Admin page (their times just pre-fill the form).
const DEFAULT_TIMES = { varsity: ['16:00', '18:00'], jv: ['18:00', '20:00'], open: ['17:00', '20:00'] };
const DEFAULT_DAYS = { varsity: [], jv: [], open: [6] };
// Line-up sheet: event code -> [label, players per slot, gender for each player]. POS = ranks per event (1-3 only).
const LINE = { BS:['Boys Singles',1,['Male']], GS:['Girls Singles',1,['Female']], BD:['Boys Doubles',2,['Male','Male']], GD:['Girls Doubles',2,['Female','Female']], MXD:['Mixed Doubles',2,['Male','Female']] };
const POS = 3, BLOCKS = { V:'Varsity', J:'JV' };
const code = (b, n) => (b === 'V' ? 'V' : 'JV') + n;
// Official SCVAL De Anza Division badminton schedule, 2026-27 (posted 7/21/26). Format: AWAY@HOME
const DEFAULT_MATCH_TIME = '5:00 PM';
const TEAMS = { C:'Cupertino', G:'Gunn', H:'Homestead', L:'Lynbrook', M:'Milpitas', V:'Monta Vista', P:'Palo Alto', W:'Wilcox' };
const DAYS = {
  '2027-03-02':'V@G P@W',          '2027-03-04':'C@W P@V M@G L@H', '2027-03-09':'V@C W@M H@P G@L',
  '2027-03-11':'C@M V@H L@W P@G',  '2027-03-16':'H@C M@L G@V W@P', '2027-03-18':'C@L H@G P@M V@W',
  '2027-03-23':'G@C L@P W@H M@V',  '2027-03-25':'C@P G@W V@L H@M', '2027-03-30':'W@C V@P G@M H@L',
  '2027-04-01':'C@V M@W P@H L@G',  '2027-04-06':'C@H L@M',         '2027-04-08':'M@C H@V W@L',
  '2027-04-15':'G@P',              '2027-04-20':'L@C G@H M@P W@V', '2027-04-22':'C@G P@L H@W V@M',
  '2027-04-27':'P@C W@G L@V M@H'
};
const EVENTS = [
  { date:'2027-04-29', time:'1:00 PM', text:'League play @ Fremont' },
  { date:'2027-04-30', time:'1:00 PM', text:'League play @ Fremont' },
  { date:'2027-05-01', time:'9:00 AM', text:'League Finals @ Fremont' }
];
// Used until a coach first edits the matches in Admin (then the list lives in Firestore).
const DEFAULT_MATCHES = [
  ...Object.entries(DAYS).flatMap(([date, s]) => s.split(' ').map(x => { const [a, h] = x.split('@'); return { date, time: DEFAULT_MATCH_TIME, away: TEAMS[a], home: TEAMS[h] }; })),
  ...EVENTS
].sort((a, b) => a.date.localeCompare(b.date)).map((m, i) => ({ id: 'm' + i, ...m }));
const isLyn = m => m.away === 'Lynbrook' || m.home === 'Lynbrook';
const opp = m => m.home === 'Lynbrook' ? m.away : m.home;
const CLEAR = [ // starting checklist (editable in Admin)
  { id:'online', label:'Complete Athletic Clearance online' },
  { id:'physical', label:'Upload doctor’s physical form' },
  { id:'gear', label:'Racket, non-marking shoes & water bottle' }
];
const ANN = [ // starting announcements (editable in Admin)
  { id:'a1', t:'Athletic clearance comes first', b:'You can’t join team practice until your online clearance and physical form are approved.' },
  { id:'a2', t:'Open Gym shoe rule', b:'Non-marking indoor shoes are required for entry.' },
  { id:'a4', t:'No team fees', b:'There are no required dues. Optional donations help cover shuttlecocks and equipment.' }
];
const SAMPLE = [ // Admin > Roster > "Load sample players (testing)". Delete these before real use.
  ['100001','Aarav','Patel','Male','Varsity','12'],['100002','Maya','Chen','Female','Varsity','11'],['100003','Ethan','Wu','Male','Varsity','12'],['100004','Rohan','Iyer','Male','Varsity','11'],
  ['100005','Kevin','Tran','Male','Varsity','10'],['100006','Lily','Zhang','Female','Varsity','12'],['100007','Sophia','Nguyen','Female','Varsity','10'],['100008','Emma','Kim','Female','Varsity','11'],
  ['100009','Daniel','Park','Male','JV','10'],['100010','Jason','Lin','Male','JV','9'],['100011','Priya','Shah','Female','JV','10'],['100012','Chloe','Wang','Female','JV','9'],
  ['100013','Nikhil','Rao','Male','JV','9'],['100014','Andrew','Ho','Male','JV','10'],['100015','Grace','Liu','Female','JV','9'],['100016','Isabella','Cho','Female','JV','10']
].map(([id, first, last, gender, division, grade]) => ({ id, first, last, gender, division, grade }));

/* ---------- Firestore layer: live cache ---------- */
const cache = {}, subs = {}, updaters = new Set();
const DB_TIMEOUT_MS = 12000, SAVE_WARN_MS = 8000;
const dbMsg = e => { const c = e?.code || '';
  if (c === 'permission-denied') return 'Firestore is blocking this request (security rules). In the Firebase console open Firestore Database > Rules, paste firestore.rules, and click Publish.';
  if (c === 'not-found') return 'Firestore says the database doesn’t exist yet. In the Firebase console choose Build > Firestore Database > Create database.';
  if (c === 'insecure-context') return 'This page must be opened over https (or http://localhost), not file:// or a plain http address.';
  if (['unavailable', 'deadline-exceeded', 'timeout'].includes(c)) return 'Can’t reach Firestore. Check the internet connection, that the Firestore database has been created, and that nothing (an ad blocker or network filter) is blocking firestore.googleapis.com.';
  if (c === 'resource-exhausted') return 'Firestore’s daily free quota has been used up.';
  return `Database error${c ? ' (' + c + ')' : ''}: ${e?.message || e}`; };
const dbErr = (what, e) => { console.error(`[Firestore] ${what} failed:`, e?.code, e?.message || e); banner(dbMsg(e), 'err'); }; // log with the real error code and show it on screen
const timed = (p, ms = DB_TIMEOUT_MS) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('Timed out waiting for Firestore'), { code: 'timeout' })), ms); })]).finally(() => clearTimeout(t)); };
function banner(msg, kind = 'info') {
  let b = $('#app-banner');
  if (!msg) { if (b && !b.classList.contains('banner-err')) b.remove(); return; }
  if (!b) { b = document.createElement('div'); b.id = 'app-banner'; b.setAttribute('role', 'status'); document.body.prepend(b); }
  b.className = 'banner-' + kind; b.textContent = msg;
}
function notify() { clearTimeout(notify.t); notify.t = setTimeout(() => updaters.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }), 25); }
const live = fn => { updaters.add(fn); fn(); }; // run a draw function now and again whenever data changes
function watch(key, target) { // live listener; resolves after the first snapshot
  subs[key]?.(); delete cache[key];
  return new Promise(resolve => {
    let first = true;
    const slow = setTimeout(() => { if (first) { first = false; banner('Still connecting to the database…', 'info'); resolve(); } }, DB_TIMEOUT_MS);
    subs[key] = onSnapshot(target, snap => {
      cache[key] = target.type === 'document' ? new Map(snap.exists() ? [[snap.id, snap.data()]] : []) : new Map(snap.docs.map(d => [d.id, d.data()]));
      clearTimeout(slow); if (first) { first = false; resolve(); } else { banner(''); notify(); }
    }, err => { clearTimeout(slow); dbErr('listener "' + key + '"', err); if (first) { first = false; resolve(); } });
  });
}
const need = names => Promise.all(names.map(n => watch(n, n === 'init' ? doc(db, 'config', 'init') : collection(db, n))));
const rows = name => [...(cache[name] || [])].map(([id, d]) => ({ id, ...d }));
const save = p => { // wraps any write: never throws, always reports a failure, warns if it is slow
  const warn = setTimeout(() => banner('Still saving… the database is slow or unreachable. The change will finish when the connection is back.', 'info'), SAVE_WARN_MS);
  const clear = () => { clearTimeout(warn); const b = $('#app-banner'); if (b && /Still saving/.test(b.textContent)) b.remove(); };
  return Promise.resolve(p).then(v => { clear(); return v; }, e => { clear(); dbErr('save', e); toast('Couldn’t save that change. See the red message at the top of the page.'); });
};

/* ---------- domain accessors (read from the live cache) ---------- */
const toPlayer = (id, d) => ({ id, first: d.firstName || '', last: d.lastName || '', gender: d.gender || '', division: d.division || '', grade: d.grade || '' });
const playerCache = new Map();
const roster = () => rows('roster').map(r => toPlayer(r.id, r));
const player = id => { const k = normId(id), hit = cache.roster?.get(k); return hit ? toPlayer(k, hit) : playerCache.get(k) || null; };
async function loadPlayer(id) { // one-document lookup (players never download the whole roster)
  const k = normId(id); if (!k || /[^a-z0-9_-]/.test(k)) return null; const hit = player(k); if (hit) return hit;
  const s = await timed(getDoc(doc(db, 'roster', k))); if (!s.exists()) return null;
  const p = toPlayer(k, s.data()); playerCache.set(k, p); return p;
}
let curUser = null; // { id, role, style } for whoever is logged in on this device
const me = () => curUser;
async function loadUser(id) { const s = await timed(getDoc(doc(db, 'users', normId(id)))); return s.exists() ? { id: s.id, ...s.data() } : null; }
async function restoreSession() { const id = local.get('session', null); if (!id) return; try { curUser = await loadUser(id); if (!curUser) local.del('session'); } catch (e) { dbErr('restoring your login', e); } }
const nameOf = u => { const p = player(u.id); return p ? fullName(p) : String(u.id); };
const firstOf = u => player(u.id)?.first || String(u.id);
const byName = (a, b) => (a.last + ' ' + a.first).localeCompare(b.last + ' ' + b.first);

const attId = (date, type, id) => `${date}_${type}_${normId(id)}`; // one document per player + date + session
const attData = (p, date, type, status, by, ts) => ({ studentId: p.id, firstName: p.first, lastName: p.last, division: p.division, date, sessionType: type, status, timestamp: ts || Date.now(), ...(by ? { by } : {}) });
const records = () => rows('attendance').map(r => ({ rid: r.id, id: r.studentId, first: r.firstName || '', last: r.lastName || '', div: r.division || '', date: r.date, type: r.sessionType, status: r.status, ts: r.timestamp || 0, by: r.by }));
const lineupOf = date => cache.lineups?.get(date) || {};
const nameFor = (date, id) => lineupOf(date).names?.[id] || (player(id) ? fullName(player(id)) : id);
const initFlags = () => cache.init?.get('init') || {};
const matches = () => (initFlags().matches ? rows('matches') : DEFAULT_MATCHES).slice().sort((a, b) => a.date.localeCompare(b.date));
const announcements = () => initFlags().announcements ? rows('announcements').sort((a, b) => b.order - a.order).map(a => ({ id: a.id, t: a.title, b: a.body })) : ANN;
const checklist = () => initFlags().checklist ? rows('checklist').sort((a, b) => a.order - b.order) : CLEAR.map((c, i) => ({ ...c, order: i + 1 }));
const overrides = () => rows('overrides');
const clearRec = id => cache.clearance?.get(normId(id)) || {};
const clearOf = id => clearRec(id).done || {};
const setClear = (id, item, v) => save(setDoc(doc(db, 'clearance', normId(id)), { done: { [item]: v } }, { merge: true }));
const seniorId = (ms = matches()) => { const h = ms.filter(m => m.home === 'Lynbrook'); return h.length ? h[h.length - 1].id : null; }; // final home game
const matchLabel = (m, sid = seniorId()) => `${opp(m)} – ${shortD(m.date)} (${m.home === 'Lynbrook' ? 'Home' : 'Away'})${m.id === sid ? ' · 🎓 Senior Night' : ''}`;
async function ensureInit(name) { // first coach edit copies the built-in defaults into Firestore so they can be changed
  if (initFlags()[name]) return;
  const b = writeBatch(db);
  if (name === 'matches') DEFAULT_MATCHES.forEach(({ id, ...m }) => b.set(doc(db, 'matches', id), m));
  if (name === 'announcements') ANN.forEach((a, i) => b.set(doc(db, 'announcements', a.id), { title: a.t, body: a.b, order: ANN.length - i }));
  if (name === 'checklist') CLEAR.forEach((c, i) => b.set(doc(db, 'checklist', c.id), { label: c.label, order: i + 1 }));
  b.set(doc(db, 'config', 'init'), { [name]: true }, { merge: true });
  await timed(b.commit());
  cache.init = new Map([['init', { ...initFlags(), [name]: true }]]);
}
const ready = async n => { try { await ensureInit(n); return true; } catch (e) { dbErr('saving the starting ' + n, e); toast('Couldn’t save. See the red message at the top of the page.'); return false; } };

/* ---------- practice schedule: defaults + per-date coach changes ---------- */
const defTimes = (t, date) => DEFAULT_DAYS[t].includes(dayOf(date)) ? DEFAULT_TIMES[t] : null;
function sessionsOn(date) {
  const ov = overrides().filter(o => o.date === date);
  return TYPES.flatMap(t => { const def = defTimes(t, date), o = ov.find(x => x.type === t);
    if (!def && !o) return [];
    const start = o ? o.start : def[0], end = o ? o.end : def[1];
    return [{ type: t, date, start, end, note: o?.note || '', cancelled: !!o?.cancelled, changed: !!o && !!def && (!!o.cancelled || start !== def[0] || end !== def[1]) }]; })
    .sort((a, b) => a.start.localeCompare(b.start));
}
const daysLabel = a => a.length === 1 ? DOW_FULL[a[0]] + 's' : a.length > 2 && a[a.length - 1] - a[0] === a.length - 1 ? DOW[a[0]] + '–' + DOW[a[a.length - 1]] : a.map(d => DOW[d]).join(', ');
const sessionLine = (date, t) => { if (!date) return ''; const s = sessionsOn(date).find(x => x.type === t);
  return !s ? `No ${TYPE[t]} is scheduled on this date.` : s.cancelled ? `${TYPE[t]} is cancelled on this date.` : `${TYPE[t]} · ${fmtT(s.start)} – ${fmtT(s.end)}${s.changed ? ' (time changed)' : ''}`; };

/* ---------- shared UI ---------- */
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}
const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
function eyes() { // adds a show/hide button to every password box on the page
  $$('input[type=password]').forEach(inp => {
    if (inp.parentElement.classList.contains('pw')) return;
    const w = document.createElement('span'); w.className = 'pw'; inp.before(w); w.append(inp);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'eye'; b.setAttribute('aria-label', 'Show password'); b.setAttribute('aria-pressed', 'false'); b.innerHTML = EYE;
    b.onclick = () => { const show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; b.innerHTML = show ? EYE_OFF : EYE; b.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); b.setAttribute('aria-pressed', String(show)); };
    w.append(b);
  });
}
// show "First Last" under an ID box as the player types (looks up one roster document)
function idLookup(input, note, firstEl, lastEl, extra) {
  let seq = 0, timer;
  const run = async () => { const v = normId(input.value), n = ++seq; run.err = null;
    if (!v) { if (firstEl) firstEl.value = ''; if (lastEl) lastEl.value = ''; extra?.(null); note.textContent = ''; return null; }
    note.textContent = 'Looking up…'; let p = null;
    try { p = await loadPlayer(v); } catch (e) { if (n === seq) { run.err = e; dbErr('player lookup', e); note.textContent = 'Can’t reach the database right now.'; } return null; }
    if (n !== seq) return p;
    if (firstEl) firstEl.value = p ? p.first : ''; if (lastEl) lastEl.value = p ? p.last : ''; extra?.(p);
    note.textContent = p ? `✓ ${fullName(p)}` : 'No player with that ID. Check the number or ask your coach.'; return p; };
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 250); };
  return run;
}
function layout() {
  const page = location.pathname.split('/').pop() || 'index.html', u = me();
  $('#site-header').innerHTML = `<header class="site-header"><div class="wrap bar">
    <a class="logo" href="index.html">🏸 LYNBROOK <span>BADMINTON</span></a>
    <button class="menu-btn" aria-label="Toggle menu" aria-expanded="false" aria-controls="nav">☰</button>
    <nav id="nav" aria-label="Main">${PAGES.map(([h, t]) =>
      `<a href="${h}"${h === page ? ' aria-current="page"' : ''}>${h === 'portal.html' && u ? 'My Portal' : t}</a>`).join('')}</nav></div></header>`;
  const btn = $('.menu-btn'), nav = $('#nav');
  btn.onclick = () => btn.setAttribute('aria-expanded', nav.classList.toggle('open'));
  nav.onclick = e => { if (e.target.closest('a')) { nav.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); } };
  $('#site-footer').innerHTML = `<footer><div class="wrap"><div class="faq"><h3>FAQ &amp; Contact</h3>
    <details><summary>Do I need experience for Open Gym?</summary><p>No. All skill levels are welcome.</p></details>
    <details><summary>What shoes do I need?</summary><p>Non-marking indoor shoes are required.</p></details>
    <details><summary>Are there team fees?</summary><p>No. Donations for shuttlecocks and equipment are optional.</p></details>
    <details><summary>How do I check in?</summary><p>Open the Check-In page and enter your Student ID. Your details fill in automatically. Pick the session you attended and tap Check In. Your coach can fix any mistakes.</p></details>
    <p style="margin-top:.8rem">Questions? Email <a href="mailto:badminton@example.com">badminton@example.com</a></p></div>
    <p>&copy; Lynbrook Badminton Club · San Jose, CA</p><p>Follow us on <a href="#">Instagram</a> | Join our <a href="#">Discord</a></p></div></footer>`;
}

/* ---------- line-up helpers ---------- */
function setSlot(date, b, k, j, val) {
  const arr = [...((lineupOf(date)[b] || {})[k] || [])]; arr[j] = val; for (let i = 0; i < arr.length; i++) arr[i] = arr[i] || '';
  if (arr[0] && arr[1] && sameId(arr[0], arr[1])) return false;
  const p = val && player(val), patch = { date, [b]: { [k]: arr.every(x => !x) ? [] : arr } };
  if (p) patch.names = { [p.id]: fullName(p) }; // names are stored with the line-up so players don't need roster access
  save(setDoc(doc(db, 'lineups', date), patch, { merge: true })); return true;
}
function matrix(date, b, o = {}) {
  const lu = lineupOf(date)[b] || {}, cats = Object.keys(LINE), dv = BLOCKS[b], ro = o.edit ? roster().sort(byName) : [];
  // dropdown: players who fit the slot (division + gender) first, then everyone else
  const opts = (sel, g) => { const mk = p => `<option value="${esc(p.id)}"${sameId(p.id, sel) ? ' selected' : ''}>${esc(fullName(p))}</option>`, fit = p => p.division === dv && p.gender === g;
    const a = ro.filter(fit), z = ro.filter(p => !fit(p));
    return '<option value="">—</option>' + (a.length ? `<optgroup label="${dv} ${g === 'Male' ? 'boys' : 'girls'}">${a.map(mk).join('')}</optgroup>` : '') + (z.length ? `<optgroup label="${a.length ? 'Other players' : 'All players'}">${z.map(mk).join('')}</optgroup>` : ''); };
  let h = `<div class="table-wrap"><table class="matrix"><thead><tr><th>${dv}</th>${cats.map(c => `<th title="${LINE[c][0]}">${c}</th>`).join('')}</tr></thead><tbody>`;
  for (let n = 1; n <= POS; n++) h += `<tr><th scope="row">${code(b, n)}</th>` + cats.map(c => { const k = c + n, raw = lu[k] || [], ids = raw.filter(Boolean);
    const body = o.edit ? Array.from({ length: LINE[c][1] }, (_, j) => `<select data-k="${k}" data-j="${j}" aria-label="${dv} ${k} player ${j + 1}">${opts(raw[j], LINE[c][2][j])}</select>`).join('')
      : ids.length ? esc(ids.map(i => nameFor(date, i)).join(' / ')) : '<span class="muted">—</span>';
    return `<td class="${o.me && ids.some(i => sameId(i, o.me)) ? 'me' : ''}">${body}</td>`; }).join('') + '</tr>';
  return h + '</tbody></table></div>';
}
function mySlots(date, id) {
  const lu = lineupOf(date);
  return Object.keys(BLOCKS).flatMap(b => Object.entries(lu[b] || {}).filter(([, ids]) => ids.some(i => sameId(i, id)))
    .map(([k, ids]) => { const [, cat, n] = k.match(/^([A-Z]+)(\d+)$/); return { b, k, cat, n: +n, partner: ids.filter(i => i && !sameId(i, id)).map(i => nameFor(date, i)) }; }))
    .filter(s => LINE[s.cat] && s.n <= POS).sort((x, y) => x.b.localeCompare(y.b) * -1 || x.n - y.n);
}
const hasLineup = date => { const lu = lineupOf(date); return Object.keys(BLOCKS).some(b => Object.values(lu[b] || {}).some(a => a.some(Boolean))); };

/* ---------- home ---------- */
async function home() {
  await need(['matches', 'overrides', 'announcements', 'init']);
  live(() => {
    const t = today(), ms = matches(), sid = seniorId(ms), nm = ms.find(m => m.date >= t && isLyn(m)), nowT = new Date().toTimeString().slice(0, 5); let nd = null;
    for (let i = 0; i < 30 && !nd; i++) { const d = addDays(t, i), ss = sessionsOn(d).filter(s => !s.cancelled && (i > 0 || s.end > nowT)); if (ss.length) nd = { d, ss }; }
    $('#next').innerHTML = `<div class="card"><span class="tag">Next Lynbrook match</span>${nm
      ? `<h3>${nm.home === 'Lynbrook' ? 'vs ' : '@ '}${esc(opp(nm))}</h3><p>${fmt(nm.date)} · ${esc(nm.time)}</p><p class="muted">${nm.home === 'Lynbrook' ? 'Home match' : 'Away match'}</p>${nm.id === sid ? '<p><span class="sn">🎓 Senior Night</span></p>' : ''}`
      : '<h3>Season complete</h3>'}<a href="schedule.html">Full schedule</a></div>
      <div class="card"><span class="tag">Next practice or open gym</span>${nd
      ? `<h3>${fmt(nd.d)}</h3>${nd.ss.map(s => `<p><strong>${TYPE[s.type]}</strong> · ${fmtT(s.start)} – ${fmtT(s.end)}${s.changed ? ' <span class="badge st-excused">changed</span>' : ''}</p>`).join('')}`
      : '<h3>Nothing scheduled yet</h3><p class="muted">Your coach will post practices here.</p>'}<a href="schedule.html">View schedule</a></div>`;
    const open = $$('#ann details[open]').map(d => d.dataset.id), read = local.get('read', []), an = announcements();
    $('#ann').innerHTML = an.length ? an.map(a => `<details class="ann" data-id="${esc(a.id)}"><summary>${esc(a.t)}${read.includes(a.id) ? '' : '<span class="new">NEW</span>'}</summary><p class="muted">${esc(a.b)}</p></details>`).join('') : '<p class="muted">No announcements right now.</p>';
    $$('#ann details').forEach(d => { d.open = open.includes(d.dataset.id);
      d.ontoggle = () => { if (!d.open) return; const r = local.get('read', []); if (!r.includes(d.dataset.id)) local.set('read', [...r, d.dataset.id]); $('.new', d)?.remove(); }; });
  });
}

/* ---------- schedule ---------- */
async function schedule() {
  await need(['matches', 'overrides', 'init']);
  let f = 'all', view = today().slice(0, 7);
  const hm = t => { const [h, m] = t.split(':').map(Number); return ((h % 12) || 12) + (m ? ':' + String(m).padStart(2, '0') : ''); }, ap = t => +t.slice(0, 2) < 12 ? 'AM' : 'PM';
  const rng = (s, e) => `${hm(s)}${ap(s) === ap(e) ? '' : ' ' + ap(s)}–${hm(e)} ${ap(e)}`, SH = { varsity: 'Varsity', jv: 'JV', open: 'Open Gym' };
  const drawDefaults = () => { $('#defaults').innerHTML = TYPES.filter(t => DEFAULT_DAYS[t].length).map(t => `<article class="card session ${t}"><span class="tag t-${t}">${TYPE[t]}</span><h3>${daysLabel(DEFAULT_DAYS[t])}</h3><p>${fmtT(DEFAULT_TIMES[t][0])} – ${fmtT(DEFAULT_TIMES[t][1])}</p></article>`).join(''); };
  const drawCal = () => { const [y, m] = view.split('-').map(Number), lead = new Date(y, m - 1, 1).getDay(), n = new Date(y, m, 0).getDate(), total = Math.ceil((lead + n) / 7) * 7, notes = [], ms = matches(), sid = seniorId(ms); let cells = '';
    for (let i = 0; i < total; i++) { const day = i - lead + 1;
      if (day < 1 || day > n) { cells += '<div class="cal-day off"></div>'; continue; }
      const date = `${view}-${String(day).padStart(2, '0')}`;
      const chips = (f === 'match' ? [] : sessionsOn(date).filter(s => f === 'all' || s.type === f)).map(s => { if (s.note) notes.push(`${fmt(date)} · ${SH[s.type]}: ${s.note}`);
          return `<span class="chip t-${s.type}${s.cancelled ? ' x' : ''}${s.changed && !s.cancelled ? ' chg' : ''}" title="${esc(TYPE[s.type] + (s.cancelled ? ' (cancelled)' : '') + (s.note ? ' – ' + s.note : ''))}">${SH[s.type]} ${s.cancelled ? 'cancelled' : rng(s.start, s.end)}</span>`; })
        .concat(f === 'all' || f === 'match' ? ms.filter(x => x.date === date && isLyn(x)).map(x => `<span class="chip match${x.id === sid ? ' senior' : ''}" title="Lynbrook match · ${esc(x.time)}${x.id === sid ? ' · Senior Night' : ''}">${x.id === sid ? '🎓 Senior Night · ' : ''}${x.home === 'Lynbrook' ? 'vs' : '@'} ${esc(opp(x))}</span>`) : []);
      cells += `<div class="cal-day${date === today() ? ' today' : ''}"><span class="cal-num">${day}</span>${chips.join('')}</div>`; }
    $('#cal-title').textContent = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    $('#cal-grid').innerHTML = DOW.map(d => `<div class="cal-dow">${d}</div>`).join('') + cells;
    $('#cal-notes').innerHTML = notes.map(x => `<li class="muted">${esc(x)}</li>`).join(''); };
  const shift = k => { const [y, m] = view.split('-').map(Number), d = new Date(y, m - 1 + k, 1); view = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; drawCal(); };
  $('#cal-prev').onclick = () => shift(-1); $('#cal-next').onclick = () => shift(1); $('#cal-today').onclick = () => { view = today().slice(0, 7); drawCal(); };
  $$('[data-filter]').forEach(b => b.onclick = () => { f = b.dataset.filter; $$('[data-filter]').forEach(x => x.setAttribute('aria-pressed', x === b)); drawCal(); });
  const q = $('#q'), lf = $('#lf'), body = $('#matches'), team = t => t === 'Lynbrook' ? '<span class="vik">Lynbrook</span>' : esc(t);
  const drawM = () => { const s = q.value.trim().toLowerCase(), l = lf.value, all = matches(), sid = seniorId(all);
    const list = all.filter(m => (l === 'all' || (l === 'lyn' && isLyn(m)) || (l === 'home' && m.home === 'Lynbrook') || (l === 'away' && m.away === 'Lynbrook'))
      && (!s || `${m.away || ''} ${m.home || ''} ${m.text || ''} ${fmt(m.date)}`.toLowerCase().includes(s)));
    body.innerHTML = list.length ? list.map(m => { const sn = m.id === sid;
      return `<tr class="${isLyn(m) ? 'lyn' : ''}${sn ? ' senior' : ''}${m.date < today() ? ' past' : ''}"><td>${fmt(m.date)}${sn ? '<br><span class="sn">🎓 Senior Night</span>' : ''}</td><td>${esc(m.time)}</td>${m.text ? `<td colspan="2"><strong>${esc(m.text)}</strong></td>` : `<td>${team(m.away)}</td><td>${team(m.home)}</td>`}</tr>`; }).join('')
      : '<tr><td colspan="4">No matches found.</td></tr>'; };
  q.oninput = lf.onchange = drawM;
  live(() => { drawDefaults(); drawCal(); drawM(); });
}

/* ---------- attendance (ID-based check-in, tagged with the session attended) ---------- */
async function attendance() {
  await need(['overrides']);
  const date = $('#date'), who = $('#who'), type = $('#type'), fb = $('#feedback'), btn = $('#checkin button'); date.value = date.max = today(); let manual = false, cur = null;
  const suggest = p => dayOf(date.value) === 6 ? 'open' : p && p.division === 'JV' ? 'jv' : 'varsity';
  const hint = () => { $('#sess-note').textContent = sessionLine(date.value, type.value); };
  const lookup = idLookup(who, $('#idnote'), $('#pfirst'), $('#plast'), p => { cur = p; $('#pgender').value = p?.gender || ''; $('#pdiv').value = p ? p.division : ''; if (!manual) type.value = suggest(p); hint(); });
  type.onchange = () => { manual = true; hint(); };
  date.onchange = () => { if (!manual) type.value = suggest(cur); hint(); };
  const u = me(); if (u) { who.value = u.id; await lookup(); }
  live(hint);
  $('#checkin').onsubmit = async e => { e.preventDefault();
    const msg = (m, c) => { fb.className = 'msg ' + c; fb.textContent = m; }, t = type.value, d = date.value;
    if (!who.value.trim() || !d) return msg('Enter your Student ID and pick a date.', 'err');
    btn.disabled = true;
    try {
      const p = cur && sameId(cur.id, who.value) ? cur : await lookup();
      if (!p) return msg(lookup.err ? dbMsg(lookup.err) : 'That Student ID isn’t on the team roster. Check the number or ask your coach.', 'err');
      const ref = doc(db, 'attendance', attId(d, t, p.id)), ex = await timed(getDoc(ref));
      if (ex.exists()) return msg(`${fullName(p)} is already on the ${TYPE[t]} list for ${fmt(d)} as ${STATUS[st(ex.data())]}. See your coach to change it.`, 'err');
      await timed(setDoc(ref, attData(p, d, t, 'present')));
      msg(`✅ Checked in! ${fullName(p)} (${p.division}) · ${TYPE[t]} · ${fmt(d)}`, 'ok'); manual = false; if (!u) { who.value = ''; await lookup(); }
    } catch (err) { dbErr('check-in', err); msg(dbMsg(err), 'err'); }
    finally { btn.disabled = false; }
  };
}

/* ---------- portal ---------- */
async function portal() {
  await need(['matches', 'lineups', 'checklist', 'init']);
  const auth = $('#auth'), dash = $('#dash'), msg = $('#auth-msg'); let tab = 'dash', selDate = null;
  const err = t => msg.innerHTML = `<p class="msg err">${esc(t)}</p>`;
  const startPersonal = async u => { await Promise.all([watch('attendance', query(collection(db, 'attendance'), where('studentId', '==', u.id))), watch('clearance', doc(db, 'clearance', u.id)), loadPlayer(u.id)]); };
  const stopPersonal = () => { ['attendance', 'clearance'].forEach(k => { subs[k]?.(); delete subs[k]; delete cache[k]; }); };
  const login = async u => { curUser = u; local.set('session', u.id); tab = 'dash'; selDate = null; await startPersonal(u); layout(); show(); };
  const show = () => { const u = me(); auth.hidden = !!u; dash.hidden = !u; if (u) render(u); };
  idLookup($('#li-id'), $('#li-note'))(); idLookup($('#rg-id'), $('#rg-note'), $('#rg-first'), $('#rg-last'))();
  $$('[data-tab]').forEach(b => b.onclick = () => { $$('[data-tab]').forEach(x => x.setAttribute('aria-pressed', x === b));
    $('#login-form').hidden = b.dataset.tab !== 'login'; $('#reg-form').hidden = b.dataset.tab !== 'reg'; msg.innerHTML = ''; });
  $('#login-form').onsubmit = async e => { e.preventDefault(); const id = normId($('#li-id').value), pw = $('#li-pw').value;
    if (!id || !pw) return err('Enter your Student ID and password.');
    try { const u = await loadUser(id);
      if (!u || u.password !== await hashPw(id, pw)) return err('Student ID or password is incorrect.');
      $('#li-pw').value = ''; msg.innerHTML = ''; await login(u); } catch (x) { dbErr('login', x); err(dbMsg(x)); } };
  $('#reg-form').onsubmit = async e => { e.preventDefault(); const id = normId($('#rg-id').value), pw = $('#rg-pw').value;
    try {
      const p = await loadPlayer(id);
      if (!p) return err('That Student ID isn’t on the team roster. Ask your coach to add you.');
      if (pw.length < 4) return err('Password needs 4+ characters.');
      if (await loadUser(id)) return err('That Student ID is already registered. Try logging in.');
      const u = { password: await hashPw(id, pw), role: 'player', studentId: p.id, style: '' };
      await timed(setDoc(doc(db, 'users', id), u));
      $('#rg-pw').value = ''; msg.innerHTML = ''; await login({ id, ...u }); toast('Welcome, ' + p.first + '!');
    } catch (x) { dbErr('registration', x); err(dbMsg(x)); } };
  function render(u) {
    const keepStyle = $('#style')?.value, att = records().filter(r => sameId(r.id, u.id)).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts), pl = player(u.id) || {}, nm = nameOf(u);
    const items = checklist(), cl = clearOf(u.id), n = items.filter(c => cl[c.id]).length, pct = items.length ? Math.round(n / items.length * 100) : 0, don = !!clearRec(u.id).donated;
    const ms = matches(), sid = seniorId(ms), lyn = ms.filter(isLyn), up = lyn.filter(m => m.date >= today()), list = up.length ? up : lyn, nx = list[0], ns = nx ? mySlots(nx.date, u.id) : [];
    const style = keepStyle ?? u.style ?? '';
    dash.innerHTML = `<h2 style="margin-bottom:1rem">Welcome back, ${esc(firstOf(u))} 👋</h2>
    <div class="tabs" role="group" aria-label="Portal sections" style="margin-bottom:1.25rem"><button class="pill" data-pt="dash" aria-pressed="${tab === 'dash'}">Dashboard</button><button class="pill" data-pt="clear" aria-pressed="${tab === 'clear'}">Clearance</button></div>
    <div id="pt-dash"${tab === 'dash' ? '' : ' hidden'}>
    <div class="grid" style="margin-bottom:1.25rem">
      <div class="card stat"><b>${items.length ? (n === items.length ? 'Cleared' : n + '/' + items.length) : '—'}</b>Clearance<br><button class="btn btn-line mini" data-pt="clear" style="margin:.4rem 0 0">Open checklist</button></div>
      <div class="card stat"><b>${don ? 'Thank you 💛' : 'Optional'}</b>Team donation<br><small class="muted">no fees required · shuttlecocks &amp; equipment</small><br>${donateHTML()}<br><button class="btn btn-line mini" id="don" style="margin:.4rem 0 0">${don ? 'Undo' : 'I donated'}</button></div>
      <div class="card stat"><b>${ns.length ? ns.map(s => code(s.b, s.n) + ' ' + s.cat).join(', ') : 'TBD'}</b>Your Next Game Position<br><small class="muted">${nx ? (ns.length ? (nx.home === 'Lynbrook' ? 'vs ' : '@ ') + esc(opp(nx)) + ' · ' + shortD(nx.date) : 'not in the line-up yet') : 'season complete'}</small></div></div>
    <div class="two"><div class="card"><div class="avatar">${esc(((pl.first || nm)[0] || '') + ((pl.last || '')[0] || ''))}</div>
      <h3>${esc(nm)}</h3><p class="muted">ID ${esc(u.id)} · ${esc(pl.division || 'Not on roster')}${pl.gender ? ' · ' + esc(pl.gender) : ''}${pl.grade ? ' · Grade ' + esc(pl.grade) : ''}</p>
      <p class="muted">First name: <strong>${esc(pl.first || nm)}</strong> · Last name: <strong>${esc(pl.last || '')}</strong></p>
      <label for="style">Play style</label><select id="style"><option value="">Select</option>${['Singles', 'Doubles', 'Mixed'].map(x => `<option${x === style ? ' selected' : ''}>${x}</option>`).join('')}</select>
      <button class="btn btn-navy" id="save" style="margin-top:1rem">Save profile</button><button class="btn btn-line" id="logout">Log out</button></div>
      <div class="card"><h3>My attendance</h3><ul class="clean">${att.slice(0, 8).map(r => `<li>${TYPE[r.type] || esc(r.type)} ${badge(r)}<br><span class="muted">${fmt(r.date)}</span></li>`).join('') || '<li class="muted">No check-ins yet. <a href="attendance.html">Check in</a></li>'}</ul></div></div>
    <h2 style="margin:2rem 0 .75rem">Match line-up</h2>
    <div class="tools"><select id="lm" aria-label="Choose a match">${list.map(m => `<option value="${m.date}">${esc(matchLabel(m, sid))}</option>`).join('')}</select></div>
    <div id="me-card"></div><p class="muted" style="margin:1rem 0 .5rem">Full team line-up (ranks 1–3). Gold cells are your spots.</p><div id="lu-view"></div></div>
    <div id="pt-clear"${tab === 'clear' ? '' : ' hidden'}>
      <div class="card" style="max-width:720px"><h2>Player Checklist</h2><p class="muted">Check off each item once you’ve finished it. Your coach can update it too.</p>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><p><strong>${pct}%</strong> · ${items.length && n === items.length ? '✅ Fully cleared!' : `${n} of ${items.length} done`}</p>
        <div id="cl-list">${items.map(c => `<label class="check"><input type="checkbox" data-c="${esc(c.id)}"${cl[c.id] ? ' checked' : ''}><span>${esc(c.label)}</span></label>`).join('') || '<p class="muted">Your coach hasn’t added any checklist items yet.</p>'}</div></div>
      <div class="card" style="max-width:720px;margin-top:1.25rem"><h3>💛 Optional Team Donation</h3><p>There are no required team fees. If you’d like to help, donations go toward shuttlecocks and equipment.</p><div style="margin-top:.75rem">${donateHTML()}</div></div></div>`;
    $$('[data-pt]', dash).forEach(b => b.onclick = () => { tab = b.dataset.pt; $$('.pill[data-pt]', dash).forEach(x => x.setAttribute('aria-pressed', x.dataset.pt === tab)); $('#pt-dash').hidden = tab !== 'dash'; $('#pt-clear').hidden = tab !== 'clear'; });
    $('#cl-list').onchange = e => { const id = e.target.dataset.c; if (id) setClear(u.id, id, e.target.checked); };
    const lm = $('#lm'); if (selDate && [...lm.options].some(o => o.value === selDate)) lm.value = selDate;
    const drawL = () => { const date = lm.value; if (!date) { $('#me-card').innerHTML = ''; $('#lu-view').innerHTML = ''; return; }
      selDate = date; const m = lyn.find(x => x.date === date), slots = mySlots(date, u.id);
      const lines = slots.length ? slots.map(s => `<p><strong>Your Next Game Position: ${BLOCKS[s.b]} ${LINE[s.cat][0]} ${s.n} (${code(s.b, s.n)} ${s.cat})</strong>${s.partner.length ? ' with partner ' + esc(s.partner.join(' & ')) : ''}</p>`).join('')
        : `<p class="muted">${hasLineup(date) ? 'You aren’t in this match’s line-up.' : 'The line-up for this match hasn’t been posted yet.'}</p>`;
      $('#me-card').innerHTML = `<div class="card me-card"><span class="tag">Your Upcoming Match</span><h3>${m.home === 'Lynbrook' ? 'vs ' : '@ '}${esc(opp(m))} · ${fmt(date)}</h3>${m.id === sid ? '<p><span class="sn">🎓 Senior Night</span></p>' : ''}${lines}</div>`;
      $('#lu-view').innerHTML = matrix(date, 'V', { me: u.id }) + '<div style="height:1rem"></div>' + matrix(date, 'J', { me: u.id }); };
    lm.onchange = drawL; drawL();
    $('#don').onclick = () => save(setDoc(doc(db, 'clearance', normId(u.id)), { donated: !don }, { merge: true }));
    $('#save').onclick = async () => { try { await updateDoc(doc(db, 'users', u.id), { style: $('#style').value }); curUser.style = $('#style').value; toast('Profile saved'); } catch (x) { fail(x); } };
    $('#logout').onclick = () => { stopPersonal(); curUser = null; local.del('session'); tab = 'dash'; layout(); show(); };
  }
  const fail = x => save(Promise.reject(x));
  const donateHTML = () => DONATE_URL ? `<a class="btn btn-gold" href="${esc(DONATE_URL)}" target="_blank" rel="noopener" style="margin:0">Donate (optional)</a>` : '<span class="muted">Donation link coming soon. Ask your coach.</span>';
  if (me()) { try { await startPersonal(me()); } catch (x) { dbErr('loading your data', x); } }
  live(() => { const u = me(); if (u) render(u); });
  show();
}

/* ---------- admin ---------- */
async function admin() {
  const gate = $('#gate'), setup = $('#setup'), panel = $('#panel');
  const adminHash = (salt, c) => sha256(`lhsb-admin|${salt}|${c}`);
  const showErr = e => { // visible error card with the real reason and a retry button (instead of a blank page)
    dbErr('admin start-up', e); gate.hidden = setup.hidden = true; panel.hidden = true;
    let c = $('#admin-err'); if (!c) { c = document.createElement('div'); c.id = 'admin-err'; c.className = 'card auth'; gate.before(c); }
    c.innerHTML = `<h2>Can’t reach the database</h2><p>${esc(dbMsg(e))}</p><p class="muted">Technical detail: ${esc(e?.code || 'no code')} · ${esc(e?.message || '')}</p><button class="btn btn-red" id="admin-retry">Try again</button>`;
    $('#admin-retry').onclick = () => location.reload();
  };
  const unlock = async () => {
    sess.set('isAdmin', true); gate.hidden = setup.hidden = true; panel.hidden = false;
    try { await need(['roster', 'attendance', 'lineups', 'matches', 'overrides', 'announcements', 'checklist', 'clearance', 'init']); build(); } catch (e) { showErr(e); }
  };
  if (sess.get('isAdmin', false)) return unlock();
  let cfg = null;
  try { const s = await timed(getDoc(doc(db, 'config', 'admin'))); cfg = s.exists() ? s.data() : null; } catch (e) { return showErr(e); }
  gate.hidden = !cfg; setup.hidden = !!cfg;
  $('#setup-form').onsubmit = async e => { e.preventDefault(); const a = $('#su-code').value, b = $('#su-code2').value, m = $('#setup-msg');
    const bad = t => { m.innerHTML = `<p class="msg err">${esc(t)}</p>`; };
    if (a.length < 6) return bad('Use at least 6 characters.'); if (a !== b) return bad('The two codes don’t match.');
    try {
      if ((await timed(getDoc(doc(db, 'config', 'admin')))).exists()) return bad('An admin code already exists. Reload the page and log in.');
      const salt = [...crypto.getRandomValues(new Uint8Array(8))].map(x => x.toString(16).padStart(2, '0')).join('');
      await timed(setDoc(doc(db, 'config', 'admin'), { salt, hash: await adminHash(salt, a) })); unlock();
    } catch (err) { dbErr('saving the admin code', err); bad(dbMsg(err)); } };
  $('#gate-form').onsubmit = async e => { e.preventDefault(); const m = $('#gate-msg');
    try { const s = await timed(getDoc(doc(db, 'config', 'admin'))), c = s.exists() ? s.data() : null;
      if (c && await adminHash(c.salt, $('#code').value) === c.hash) unlock(); else m.innerHTML = '<p class="msg err">Incorrect admin code.</p>'; }
    catch (err) { dbErr('admin login', err); m.innerHTML = `<p class="msg err">${esc(dbMsg(err))}</p>`; } };

  function build() {
    $('#logout-admin').onclick = () => { sess.del('isAdmin'); location.reload(); };
    const showTab = t => { local.set('adminTab', t); $$('[data-at]', panel).forEach(b => b.setAttribute('aria-pressed', b.dataset.at === t)); $$('[data-pane]', panel).forEach(p => { p.hidden = p.dataset.pane !== t; }); };
    $$('[data-at]', panel).forEach(b => b.onclick = () => showTab(b.dataset.at));
    const t0 = local.get('adminTab', 'roster'); showTab($(`[data-at="${t0}"]`, panel) ? t0 : 'roster');
    $$('.subtabs', panel).forEach(g => { const grp = g.dataset.group, set = s => { $$('button', g).forEach(b => b.setAttribute('aria-pressed', b.dataset.s === s)); $$(`[data-sg="${grp}"]`, panel).forEach(x => { x.hidden = x.dataset.s !== s; }); local.set('sub:' + grp, s); };
      $$('button', g).forEach(b => b.onclick = () => set(b.dataset.s)); const s0 = local.get('sub:' + grp, ''); set($(`button[data-s="${s0}"]`, g) ? s0 : $('button', g).dataset.s); });
    const ro = () => roster().sort(byName);
    const busy = el => { const a = document.activeElement; return !!a && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); }; // don't redraw a table while someone is editing inside it

    /* ===== roster ===== */
    const pq = $('#p-q'); let editId = null;
    const resetP = () => { editId = null; $('#p-form').reset(); $('#p-id').readOnly = false; $('#p-save').textContent = 'Add player'; $('#p-cancel').hidden = true; };
    const drawP = () => { const s = pq.value.trim().toLowerCase(), l = ro().filter(p => !s || `${p.id} ${p.first} ${p.last} ${p.gender} ${p.division}`.toLowerCase().includes(s));
      $('#p-count').textContent = `${roster().length} registered player${roster().length === 1 ? '' : 's'}`;
      $('#p-body').innerHTML = l.length ? l.map(p => `<tr><td>${esc(p.id)}</td><td>${esc(p.first)}</td><td>${esc(p.last)}</td><td>${esc(p.gender || '—')}</td><td>${esc(p.division)}</td><td>${esc(p.grade)}</td><td><button class="btn btn-line mini" data-edit="${esc(p.id)}">Edit</button><button class="btn btn-line mini" data-rm="${esc(p.id)}">Remove</button></td></tr>`).join('')
        : '<tr><td colspan="7">No players yet. Add one above.</td></tr>'; };
    pq.oninput = drawP; $('#p-cancel').onclick = resetP;
    const rosterDoc = p => ({ firstName: p.first, lastName: p.last, gender: p.gender, division: p.division, grade: p.grade });
    $('#p-form').onsubmit = e => { e.preventDefault();
      const p = { id: normId($('#p-id').value), first: $('#p-first').value.trim(), last: $('#p-last').value.trim(), gender: $('#p-gender').value, division: $('#p-div').value, grade: $('#p-grade').value };
      if (!p.id || !p.first || !p.last) return toast('Enter a Student ID, first name and last name');
      if (!/^[a-z0-9_-]+$/.test(p.id)) return toast('Student ID can use letters, numbers, - and _ only');
      if (!p.gender) return toast('Pick Male or Female');
      const was = editId !== null; if (!was && player(p.id)) return toast('That Student ID is already on the roster');
      save(setDoc(doc(db, 'roster', p.id), rosterDoc(p))); resetP(); toast(was ? 'Player updated' : 'Player added'); };
    $('#p-body').onclick = e => { const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.edit !== undefined) { const p = player(b.dataset.edit); if (!p) return; editId = p.id;
        $('#p-id').value = p.id; $('#p-id').readOnly = true; $('#p-first').value = p.first; $('#p-last').value = p.last; $('#p-gender').value = p.gender || ''; $('#p-div').value = p.division; $('#p-grade').value = p.grade;
        $('#p-save').textContent = 'Save changes'; $('#p-cancel').hidden = false; $('#p-first').focus(); }
      else if (b.dataset.rm !== undefined) { save(deleteDoc(doc(db, 'roster', b.dataset.rm))); resetP(); toast('Player removed (their attendance records are kept)'); } };
    $('#p-sample').onclick = () => { const b = writeBatch(db); let n = 0; SAMPLE.forEach(p => { if (!player(p.id)) { b.set(doc(db, 'roster', p.id), rosterDoc(p)); n++; } });
      if (!n) return toast('Sample players are already loaded'); save(b.commit()); toast(`Loaded ${n} sample players`); };

    /* ===== practices & open gym (defaults + per-date changes) ===== */
    const defs = TYPES.filter(t => DEFAULT_DAYS[t].length);
    $('#def-times').textContent = (defs.length ? 'Default: ' + defs.map(t => `${TYPE[t]} ${daysLabel(DEFAULT_DAYS[t])} ${fmtT(DEFAULT_TIMES[t][0])} – ${fmtT(DEFAULT_TIMES[t][1])}`).join(' · ') + '. ' : '') + 'Varsity and JV practices appear only when you add them here.';
    const oD = $('#o-date'), oT = $('#o-type'), oS = $('#o-start'), oE = $('#o-end'), oN = $('#o-note'), oC = $('#o-cancel'), oU = $('#o-until'); oD.value = today();
    const loadO = () => { if (!oD.value) return; const s = sessionsOn(oD.value).find(x => x.type === oT.value), def = defTimes(oT.value, oD.value);
      oS.value = s ? s.start : DEFAULT_TIMES[oT.value][0]; oE.value = s ? s.end : DEFAULT_TIMES[oT.value][1]; oN.value = s?.note || ''; oC.checked = !!s?.cancelled;
      $('#o-hint').textContent = def ? `Default for ${DOW_FULL[dayOf(oD.value)]}: ${fmtT(def[0])} – ${fmtT(def[1])}.` : s ? 'Added for this date. Change it or cancel it below.' : `${TYPE[oT.value]} isn’t scheduled by default. Saving will add it on this date.`; };
    const drawO = () => { const l = overrides().filter(o => o.date >= today()).sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
      $('#o-list').innerHTML = l.length ? l.slice(0, 60).map(o => `<li><strong>${fmt(o.date)}</strong> · ${TYPE[o.type]} · ${o.cancelled ? '<strong>Cancelled</strong>' : fmtT(o.start) + ' – ' + fmtT(o.end)}${o.note ? ' · ' + esc(o.note) : ''}<button class="btn btn-line mini" data-rm="${esc(o.id)}">${defTimes(o.type, o.date) ? 'Reset to default' : 'Remove'}</button></li>`).join('') : '<li class="muted">Nothing added yet. Only the default schedule is showing.</li>'; };
    oD.onchange = oT.onchange = loadO;
    $('#o-form').onsubmit = e => { e.preventDefault(); if (!oD.value) return toast('Pick a date'); const c = oC.checked, until = oU.value;
      if (!c && (!oS.value || !oE.value || oE.value <= oS.value)) return toast('Pick a valid start and end time');
      if (until && until < oD.value) return toast('“Repeat weekly until” must be on or after the date');
      const dates = []; for (let d = oD.value; d <= (until || oD.value) && dates.length < 60; d = addDays(d, 7)) dates.push(d);
      const base = DEFAULT_TIMES[oT.value], b = writeBatch(db);
      dates.forEach(d => { const def = defTimes(oT.value, d), same = !!def && !c && oS.value === def[0] && oE.value === def[1] && !oN.value.trim(), ref = doc(db, 'overrides', `${d}_${oT.value}`);
        if (same) b.delete(ref); else b.set(ref, { date: d, type: oT.value, start: oS.value || base[0], end: oE.value || base[1], cancelled: c, note: oN.value.trim() }); });
      save(b.commit()); oU.value = ''; toast(dates.length > 1 ? `Saved for ${dates.length} weeks` : c ? 'Session cancelled for that date' : 'Saved for that date'); };
    $('#o-list').onclick = e => { const id = e.target.dataset.rm; if (!id) return; save(deleteDoc(doc(db, 'overrides', id))); toast('Removed'); };

    /* ===== attendance log (edit history) ===== */
    const hq = $('#h-q'), hd = $('#h-date'), ht = $('#h-type'), hs = $('#h-st'), lp = $('#l-player'), ld = $('#l-date'); ld.value = ld.max = today();
    const logRows = () => { const s = hq.value.trim().toLowerCase();
      return records().filter(r => (ht.value === 'all' || r.type === ht.value) && (hs.value === 'all' || st(r) === hs.value) && (!hd.value || r.date === hd.value)
        && (!s || `${r.first} ${r.last} ${r.id || ''}`.toLowerCase().includes(s))).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts); };
    const typeOpts = cur => TYPES.map(k => `<option value="${k}"${k === cur ? ' selected' : ''}>${TYPE[k]}</option>`).join('');
    const drawLP = () => { if (busy(lp)) return; const keepV = lp.value; lp.innerHTML = ro().map(p => `<option value="${esc(p.id)}">${esc(p.last)}, ${esc(p.first)} (${esc(p.id)})</option>`).join('') || '<option value="">No players on roster</option>'; if (keepV) lp.value = keepV; };
    const drawH = () => { const r = logRows(); $('#h-count').textContent = r.length + (r.length === 1 ? ' record' : ' records') + (r.length > 300 ? ' (showing the newest 300)' : '');
      if (busy($('#h-body'))) return;
      $('#h-body').innerHTML = r.length ? r.slice(0, 300).map(x => `<tr><td>${esc(x.id || '')}</td><td>${esc(x.first)}</td><td>${esc(x.last)}</td>
        <td><input type="date" value="${esc(x.date)}" max="${today()}" data-rid="${esc(x.rid)}" data-f="date" aria-label="Date"></td>
        <td><select data-rid="${esc(x.rid)}" data-f="type" aria-label="Session">${typeOpts(x.type)}</select></td>
        <td><select data-rid="${esc(x.rid)}" data-f="status" aria-label="Status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${st(x) === k ? ' selected' : ''}>${v}</option>`).join('')}</select></td>
        <td><button class="btn btn-line mini" data-del="${esc(x.rid)}">Delete</button></td></tr>`).join('') : '<tr><td colspan="7">No records match.</td></tr>'; };
    hq.oninput = hd.onchange = ht.onchange = hs.onchange = drawH;
    $('#h-clear').onclick = () => { hq.value = hd.value = ''; ht.value = hs.value = 'all'; drawH(); };
    $('#h-body').onchange = e => { const t = e.target, id = t.dataset.rid, f = t.dataset.f; if (!id) return; const x = records().find(r => r.rid === id); if (!x) return;
      if (f === 'status') { save(updateDoc(doc(db, 'attendance', id), { status: t.value })); return toast('Attendance updated'); }
      const date = f === 'date' ? t.value : x.date, type = f === 'type' ? t.value : x.type;
      if (!date) { drawH(); return toast('Pick a date'); }
      const nid = attId(date, type, x.id); // date and session are part of the document ID, so a change moves the document
      if (nid !== id && records().some(r => r.rid === nid)) { drawH(); return toast('That player already has a log for that date and session'); }
      const b = writeBatch(db); b.set(doc(db, 'attendance', nid), attData({ id: x.id, first: x.first, last: x.last, division: x.div }, date, type, x.status, x.by, x.ts)); if (nid !== id) b.delete(doc(db, 'attendance', id));
      save(b.commit()); toast('Attendance updated'); };
    $('#h-body').onclick = e => { const b = e.target.closest('button[data-del]'); if (!b) return; save(deleteDoc(doc(db, 'attendance', b.dataset.del))); toast('Log deleted'); };
    $('#l-form').onsubmit = e => { e.preventDefault(); const p = player(lp.value), type = $('#l-type').value;
      if (!p) return toast('Pick a player (add players to the roster first)'); if (!ld.value) return toast('Pick a date');
      const id = attId(ld.value, type, p.id); if (records().some(r => r.rid === id)) return toast(`${fullName(p)} already has a log for that date and session. Edit it in the table.`);
      save(setDoc(doc(db, 'attendance', id), attData(p, ld.value, type, $('#l-st').value, 'admin'))); toast('Log added'); };
    $('#csv').onclick = () => { const q = v => '"' + String(v ?? '').replace(/^([=+\-@])/, "'$1").replace(/"/g, '""') + '"';
      const lines = [['Student ID', 'First Name', 'Last Name', 'Gender', 'Division', 'Date', 'Session', 'Status', 'Recorded at'].map(q).join(',')].concat(logRows().map(r => [r.id || '', r.first, r.last, player(r.id)?.gender || '', r.div || player(r.id)?.division || '', r.date, TYPE[r.type] || r.type, STATUS[st(r)], new Date(r.ts).toISOString()].map(q).join(',')));
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' })); a.download = 'lynbrook-attendance-' + today() + '.csv';
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };

    /* ===== take attendance (per-session grid) ===== */
    const ad = $('#a-date'), at = $('#a-type'), adv = $('#a-div'), ab = $('#a-body'), pick = $('#a-pick'); ad.value = today();
    const divFor = t => t === 'varsity' ? 'Varsity' : t === 'jv' ? 'JV' : 'all'; adv.value = divFor(at.value);
    const dayRecs = () => records().filter(r => r.date === ad.value && r.type === at.value);
    const shown = () => ro().filter(p => adv.value === 'all' || p.division === adv.value);
    const drawA = () => { const day = dayRecs(), c = k => day.filter(r => st(r) === k).length;
      $('#a-sum').textContent = `${TYPE[at.value]} · ${fmt(ad.value)} · ${c('present')} present · ${c('excused')} excused · ${c('unexcused')} unexcused · ${shown().filter(p => !day.some(r => sameId(r.id, p.id))).length} not recorded`;
      ab.innerHTML = shown().length ? shown().map(p => { const r = day.find(x => sameId(x.id, p.id)), cur = r ? st(r) : '';
        return `<tr><td>${esc(p.id)}</td><td>${esc(p.first)}</td><td>${esc(p.last)}</td><td>${esc(p.division)}</td><td><div class="seg" role="group" aria-label="Status for ${esc(fullName(p))}">${Object.entries(SHORT).map(([k, v]) => `<button class="st-${k}" data-id="${esc(p.id)}" data-s="${k}" aria-pressed="${cur === k}">${v}</button>`).join('')}</div></td></tr>`; }).join('')
        : '<tr><td colspan="5">No players to show. Add players to the roster first.</td></tr>'; };
    const drawPick = () => { if (busy(pick)) return; let o = '<option value="">Jump to a recent session…</option>';
      for (let i = 0; i < 21; i++) { const d = addDays(today(), -i); sessionsOn(d).filter(s => !s.cancelled).forEach(s => { o += `<option value="${d}|${s.type}">${fmt(d)} · ${TYPE[s.type]}</option>`; }); }
      pick.innerHTML = o; };
    const setSt = (b, p, s) => { const ref = doc(db, 'attendance', attId(ad.value, at.value, p.id)), has = dayRecs().some(x => sameId(x.id, p.id));
      if (has && !s) b.delete(ref); else if (has) b.set(ref, { status: s }, { merge: true }); else if (s) b.set(ref, attData(p, ad.value, at.value, s, 'admin')); };
    ab.onclick = e => { const btn = e.target.closest('button[data-s]'); if (!btn) return; const p = player(btn.dataset.id); if (!p) return;
      const r = dayRecs().find(x => sameId(x.id, p.id)), b = writeBatch(db); setSt(b, p, r && st(r) === btn.dataset.s ? '' : btn.dataset.s); save(b.commit()); };
    $('#a-all').onclick = () => { const b = writeBatch(db); shown().forEach(p => setSt(b, p, 'present')); save(b.commit()); toast('Marked everyone shown as Present'); };
    ad.onchange = adv.onchange = () => { drawA(); drawH(); }; at.onchange = () => { adv.value = divFor(at.value); drawA(); };
    pick.onchange = () => { if (!pick.value) return; [ad.value, at.value] = pick.value.split('|'); adv.value = divFor(at.value); drawA(); };

    /* ===== game line-ups ===== */
    const lm = $('#lu-match'); let blk = 'V';
    const fillLM = () => { if (busy(lm)) return; const ms = matches(), lyn = ms.filter(isLyn), sid = seniorId(ms), keepV = lm.value;
      lm.innerHTML = lyn.map(m => `<option value="${m.date}">${esc(matchLabel(m, sid))}</option>`).join('') || '<option value="">No Lynbrook matches</option>';
      const ni = lyn.findIndex(m => m.date >= today()); lm.value = lyn.some(m => m.date === keepV) ? keepV : (lyn[ni >= 0 ? ni : 0]?.date ?? ''); };
    const drawLU = () => { if (busy($('#lu-box'))) return; $('#lu-box').innerHTML = lm.value ? matrix(lm.value, blk, { edit: true }) : '<p class="muted">Add a Lynbrook match first (Schedule > League matches).</p>'; };
    lm.onchange = drawLU;
    $$('[data-b]', panel).forEach(b => b.onclick = () => { blk = b.dataset.b; $$('[data-b]', panel).forEach(x => x.setAttribute('aria-pressed', x === b)); drawLU(); });
    $('#lu-box').onchange = e => { const k = e.target.dataset.k; if (!k) return; if (!setSlot(lm.value, blk, k, +e.target.dataset.j, e.target.value)) { toast('Pick two different players for a doubles slot'); drawLU(); } };
    $('#lu-clear').onclick = () => { if (lineupOf(lm.value)[blk]) save(updateDoc(doc(db, 'lineups', lm.value), { [blk]: {} })); toast(BLOCKS[blk] + ' line-up cleared'); };

    /* ===== league matches (edit, add, delete, reset) ===== */
    const mmF = $('#mm-filter'), teamNames = Object.values(TEAMS);
    const teamOpts = cur => (teamNames.includes(cur) ? teamNames : [...teamNames, cur]).map(t => `<option${t === cur ? ' selected' : ''}>${esc(t)}</option>`).join('');
    $('#mm-away').innerHTML = teamOpts('Cupertino'); $('#mm-home').innerHTML = teamOpts('Lynbrook');
    const drawMM = () => { if (busy($('#mm-body'))) return; const l = matches().filter(m => mmF.value === 'all' || m.text !== undefined || isLyn(m));
      $('#mm-body').innerHTML = l.length ? l.map(m => `<tr data-id="${esc(m.id)}"><td><input type="date" data-f="date" value="${esc(m.date)}" aria-label="Date"></td><td><input data-f="time" value="${esc(m.time)}" aria-label="Time"></td>${m.text !== undefined
        ? `<td colspan="2"><input data-f="text" value="${esc(m.text)}" aria-label="Event"></td>`
        : `<td><select data-f="away" aria-label="Away team">${teamOpts(m.away)}</select></td><td><select data-f="home" aria-label="Home team">${teamOpts(m.home)}</select></td>`}<td><button class="btn btn-line mini" data-del="${esc(m.id)}">Delete</button></td></tr>`).join('') : '<tr><td colspan="5">No matches.</td></tr>'; };
    mmF.onchange = drawMM;
    $('#mm-body').onchange = async e => { const t = e.target, f = t.dataset.f; if (!f) return; const id = t.closest('tr').dataset.id, all = matches(), m = all.find(x => x.id === id); if (!m) return; const v = t.value.trim();
      if (f === 'date' && !v) { drawMM(); return toast('Pick a date'); }
      if (f === 'text' && !v) { drawMM(); return toast('The event needs a description'); }
      if ((f === 'away' || f === 'home') && v === (f === 'away' ? m.home : m.away)) { drawMM(); return toast('A team can’t play itself'); }
      if (!(await ready('matches'))) return;
      const b = writeBatch(db); b.update(doc(db, 'matches', id), { [f]: v });
      if (f === 'date' && m.date !== v && isLyn(m)) { const lu = lineupOf(m.date); // keep the line-up with the match when its date moves
        if (Object.keys(lu).length && !cache.lineups.has(v) && !all.some(x => x.id !== id && x.date === m.date && isLyn(x))) { b.set(doc(db, 'lineups', v), { ...lu, date: v }); b.delete(doc(db, 'lineups', m.date)); } }
      save(b.commit()); toast('Match updated'); };
    $('#mm-body').onclick = async e => { const b = e.target.closest('button[data-del]'); if (!b || !(await ready('matches'))) return; save(deleteDoc(doc(db, 'matches', b.dataset.del))); toast('Deleted'); };
    $('#mm-form').onsubmit = async e => { e.preventDefault(); const d = $('#mm-date').value, a = $('#mm-away').value, h = $('#mm-home').value;
      if (!d) return toast('Pick a date'); if (a === h) return toast('A team can’t play itself'); if (!(await ready('matches'))) return;
      save(setDoc(doc(db, 'matches', 'm' + Date.now()), { date: d, time: $('#mm-time').value.trim(), away: a, home: h })); toast('Match added'); };
    $('#me-form').onsubmit = async e => { e.preventDefault(); const d = $('#me-date').value, t = $('#me-text').value.trim(); if (!d || !t) return toast('Add a date and a description'); if (!(await ready('matches'))) return;
      save(setDoc(doc(db, 'matches', 'm' + Date.now()), { date: d, time: $('#me-time').value.trim(), text: t })); $('#me-text').value = ''; toast('Event added'); };
    let mmRst = 0; $('#mm-reset').onclick = async e => { const btn = e.target, label = 'Reset to official SCVAL schedule';
      if (!mmRst) { btn.textContent = 'Click again to restore the official schedule'; mmRst = setTimeout(() => { mmRst = 0; btn.textContent = label; }, 4000); return; }
      clearTimeout(mmRst); mmRst = 0; btn.textContent = label;
      try { const snap = await timed(getDocs(collection(db, 'matches'))), b = writeBatch(db); snap.docs.forEach(d => b.delete(doc(db, 'matches', d.id))); b.set(doc(db, 'config', 'init'), { matches: false }, { merge: true }); await timed(b.commit()); cache.init = new Map([['init', { ...initFlags(), matches: false }]]); toast('Restored the official SCVAL schedule'); }
      catch (x) { save(Promise.reject(x)); } };

    /* ===== home page announcements ===== */
    let anEdit = null; const anT = $('#an-title'), anB = $('#an-body');
    const resetAn = () => { anEdit = null; anT.value = anB.value = ''; $('#an-save').textContent = 'Post announcement'; $('#an-cancel').hidden = true; };
    const drawAn = () => { $('#an-list').innerHTML = announcements().map(a => `<li><strong>${esc(a.t)}</strong><br><span class="muted">${esc(a.b)}</span><br><button class="btn btn-line mini" data-edit="${esc(a.id)}" style="margin:.4rem .4rem 0 0">Edit</button><button class="btn btn-line mini" data-del="${esc(a.id)}" style="margin:.4rem 0 0">Delete</button></li>`).join('') || '<li class="muted">No announcements yet.</li>'; };
    $('#an-form').onsubmit = async e => { e.preventDefault(); const t = anT.value.trim(), b = anB.value.trim(); if (!t) return toast('Add a title'); if (!(await ready('announcements'))) return;
      const was = anEdit; save(was ? updateDoc(doc(db, 'announcements', was), { title: t, body: b }) : setDoc(doc(db, 'announcements', 'n' + Date.now()), { title: t, body: b, order: Date.now() }));
      resetAn(); toast(was ? 'Announcement updated' : 'Announcement posted'); };
    $('#an-cancel').onclick = resetAn;
    $('#an-list').onclick = async e => { const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.edit) { const a = announcements().find(x => x.id === b.dataset.edit); if (!a) return; anEdit = a.id; anT.value = a.t; anB.value = a.b; $('#an-save').textContent = 'Save changes'; $('#an-cancel').hidden = false; anT.focus(); }
      else if (b.dataset.del) { if (!(await ready('announcements'))) return; save(deleteDoc(doc(db, 'announcements', b.dataset.del))); if (anEdit === b.dataset.del) resetAn(); toast('Announcement deleted'); } };

    /* ===== clearance checklist + per-player clearance ===== */
    const ckList = $('#ck-list');
    const drawCk = () => { if (busy(ckList)) return; const l = checklist();
      ckList.innerHTML = l.length ? l.map((c, i) => `<li class="row"><input value="${esc(c.label)}" data-ck="${esc(c.id)}" aria-label="Checklist item ${i + 1}"><button class="btn btn-line mini" data-up="${esc(c.id)}" aria-label="Move up"${i ? '' : ' disabled'}>↑</button><button class="btn btn-line mini" data-down="${esc(c.id)}" aria-label="Move down"${i < l.length - 1 ? '' : ' disabled'}>↓</button><button class="btn btn-line mini" data-del="${esc(c.id)}">Delete</button></li>`).join('') : '<li class="muted">No checklist items. Players will see an empty checklist.</li>'; };
    $('#ck-form').onsubmit = async e => { e.preventDefault(); const v = $('#ck-label').value.trim(); if (!v) return toast('Type the checklist item first'); if (!(await ready('checklist'))) return;
      const mx = Math.max(0, ...checklist().map(c => c.order)); save(setDoc(doc(db, 'checklist', 'c' + Date.now()), { label: v, order: mx + 1 })); $('#ck-label').value = ''; toast('Item added'); };
    ckList.onchange = async e => { const id = e.target.dataset.ck; if (!id) return; const v = e.target.value.trim(); if (!v) { drawCk(); return toast('An item can’t be empty'); } if (!(await ready('checklist'))) return;
      save(updateDoc(doc(db, 'checklist', id), { label: v })); toast('Item updated'); };
    ckList.onclick = async e => { const b = e.target.closest('button'); if (!b || b.disabled) return; if (!(await ready('checklist'))) return;
      const l = checklist(), id = b.dataset.up || b.dataset.down || b.dataset.del, i = l.findIndex(x => x.id === id); if (i < 0) return;
      if (b.dataset.del) return save(deleteDoc(doc(db, 'checklist', id)));
      const j = b.dataset.up ? i - 1 : i + 1; if (j < 0 || j >= l.length) return; const w = writeBatch(db);
      w.update(doc(db, 'checklist', l[i].id), { order: l[j].order }); w.update(doc(db, 'checklist', l[j].id), { order: l[i].order }); save(w.commit()); };
    const pcSel = $('#pc-player'); let pcId = null;
    const drawPC = () => { const ps = ro(), items = checklist(); if (!ps.some(p => sameId(p.id, pcId))) pcId = ps[0]?.id ?? null;
      if (!busy(pcSel)) pcSel.innerHTML = ps.map(p => `<option value="${esc(p.id)}"${sameId(p.id, pcId) ? ' selected' : ''}>${esc(p.last)}, ${esc(p.first)} (${esc(p.id)})</option>`).join('') || '<option value="">No players on roster</option>';
      if (!busy($('#pc-list'))) { const p = player(pcId), c = p ? clearOf(p.id) : {};
        $('#pc-list').innerHTML = !p ? '<p class="muted">Add players to the roster first.</p>' : items.length ? items.map(i => `<label class="check"><input type="checkbox" data-c="${esc(i.id)}"${c[i.id] ? ' checked' : ''}><span>${esc(i.label)}</span></label>`).join('') : '<p class="muted">No checklist items yet. Add some in the Checklist tab.</p>'; }
      $('#pc-body').innerHTML = ps.length ? ps.map(q => { const k = clearOf(q.id), a = items.filter(i => k[i.id]).length; return `<tr><td>${esc(q.first)}</td><td>${esc(q.last)}</td><td>${esc(q.division)}</td><td>${items.length ? `${a} of ${items.length}${a === items.length ? ' ✅' : ''}` : '—'}</td><td><button class="btn btn-line mini" data-pc="${esc(q.id)}">Edit</button></td></tr>`; }).join('') : '<tr><td colspan="5">No players yet.</td></tr>'; };
    pcSel.onchange = () => { pcId = pcSel.value; drawPC(); };
    $('#pc-list').onchange = e => { const id = e.target.dataset.c; if (id && pcId !== null) setClear(pcId, id, e.target.checked); };
    const setAll = v => { if (pcId === null) return; save(setDoc(doc(db, 'clearance', normId(pcId)), { done: Object.fromEntries(checklist().map(i => [i.id, v])) }, { merge: true })); toast(v ? 'Marked all done' : 'Cleared all'); };
    $('#pc-all').onclick = () => setAll(true); $('#pc-none').onclick = () => setAll(false);
    $('#pc-body').onclick = e => { const b = e.target.closest('button[data-pc]'); if (!b) return; pcId = b.dataset.pc; drawPC(); pcSel.scrollIntoView?.({ block: 'center' }); };

    live(() => { drawP(); drawLP(); drawO(); loadO(); drawPick(); drawA(); drawH(); fillLM(); drawLU(); drawMM(); drawAn(); drawCk(); drawPC(); });
  }
}

/* ---------- start ---------- */
window.addEventListener('unhandledrejection', e => dbErr('an action', e.reason)); // last-resort net: nothing fails silently
(async function boot() {
  const key = document.body.dataset.page === 'index' ? 'home' : document.body.dataset.page;
  eyes(); layout(); banner('Connecting…');
  timed(getDoc(doc(db, 'config', 'init'))).catch(e => dbErr('connection check', e)); // surfaces rules / missing-database / network problems right away
  try { await restoreSession(); if (curUser) layout(); await ({ home, schedule, attendance, portal, admin })[key]?.(); }
  catch (e) { dbErr('page start-up', e); }
  banner('');
})();