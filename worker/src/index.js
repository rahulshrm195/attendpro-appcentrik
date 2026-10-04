// AttendPro API — Cloudflare Worker
// All routes except /health need:  Authorization: Bearer <API_KEY>
// See worker/README.md for setup and endpoint reference.

import { createFirestore, newId, FirestoreError } from './firestore.js';
import {
  todayStr, localParts, localHHMM, isValidDate, isValidHHMM, isLateAt, sessionTimes, rollup,
  detectAnomalies, publicRecord,
} from './attendance.js';
import { computePayroll, defaultSalaryCfg } from './payroll.js';

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: { code: e.code, message: e.message } }, e.status);
      if (e instanceof FirestoreError && (e.code === 'FAILED_PRECONDITION' || e.code === 'ALREADY_EXISTS')) {
        return json({ error: { code: 'conflict', message: 'Record changed while saving — retry' } }, 409);
      }
      console.error(e);
      return json({ error: { code: 'internal', message: 'Internal error' } }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = (msg) => new HttpError(400, 'bad_request', msg);
const notFound = (msg) => new HttpError(404, 'not_found', msg);

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ── Routing ──
const ID = '([A-Za-z0-9_-]{1,128})';
const routes = [
  ['GET', '^/biz/list$', listBusinesses],
  ['GET', `^/biz/${ID}/staff$`, listStaff],
  ['POST', `^/biz/${ID}/staff$`, addStaff],
  ['GET', `^/biz/${ID}/attendance/(\\d{4}-\\d{2})$`, monthAttendance],
  ['GET', `^/biz/${ID}/attendance/(\\d{4}-\\d{2}-\\d{2})/${ID}$`, getRecord],
  ['PATCH', `^/biz/${ID}/attendance/(\\d{4}-\\d{2}-\\d{2})/${ID}$`, editSession],
  ['DELETE', `^/biz/${ID}/attendance/(\\d{4}-\\d{2}-\\d{2})/${ID}/session/(\\d+)$`, deleteSession],
  ['GET', `^/biz/${ID}/payroll/(\\d{4}-\\d{2})/${ID}$`, payroll],
  ['POST', `^/biz/${ID}/advance$`, giveAdvance],
].map(([m, re, fn]) => [m, new RegExp(re), fn]);

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/health') return json({ ok: true });

  await requireApiKey(request, env);

  const matches = routes.filter(([, re]) => re.test(path));
  if (!matches.length) throw notFound('No such endpoint');
  const route = matches.find(([m]) => m === request.method);
  if (!route) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');

  const params = route[1].exec(path).slice(1);
  const ctx = {
    env, url, request,
    db: createFirestore(env),
    tz: env.TZ_OFFSET || '+05:30',
    body: null,
  };
  if (request.method === 'POST' || request.method === 'PATCH') {
    ctx.body = await request.json().catch(() => { throw bad('Body must be JSON'); });
    if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw bad('Body must be a JSON object');
  }
  if (path.startsWith('/biz/') && params[0]) await requireBusiness(ctx, params[0]);
  return route[2](ctx, ...params);
}

async function requireApiKey(request, env) {
  if (!env.API_KEY || env.API_KEY.length < 32) {
    throw new HttpError(500, 'not_configured', 'API_KEY secret is missing or shorter than 32 characters');
  }
  const m = /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '');
  if (!m || !(await safeEqual(m[1], env.API_KEY))) throw new HttpError(401, 'unauthorized', 'Invalid API key');
}

// Constant-time comparison via fixed-length digests
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const xa = new Uint8Array(x), ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}

const P = {
  biz: (b) => `businesses/${b}`,
  staff: (b) => `businesses/${b}/staff`,
  staffDoc: (b, s) => `businesses/${b}/staff/${s}`,
  settings: (b) => `businesses/${b}/settings/main`,
  rec: (b, s, d) => `businesses/${b}/attendance/${s}_${d}`,
  recs: (b) => `businesses/${b}/attendance`,
  days: (b) => `businesses/${b}/days`,
  advances: (b) => `businesses/${b}/advances`,
  advLedger: (b, s) => `businesses/${b}/advance_ledger/${s}`,
  advLedgerLog: (b) => `businesses/${b}/advance_ledger_log`,
  salary: (b, s) => `businesses/${b}/salary_config/${s}`,
};

async function requireBusiness(ctx, bizId) {
  const biz = await ctx.db.get(P.biz(bizId));
  if (!biz) throw notFound('Business not found');
  ctx.biz = biz.data;
}

async function requireStaff(ctx, bizId, staffId) {
  const s = await ctx.db.get(P.staffDoc(bizId, staffId));
  if (!s) throw notFound('Staff not found');
  return s.data;
}

// Never return credentials (owner password, kiosk/staff PINs)
const SECRET_KEY = /pass|pin|secret|token|key/i;
function stripSecrets(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!SECRET_KEY.test(k)) out[k] = v;
  return out;
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  if (m < 1 || m > 12) throw bad('Invalid month');
  return { y, m, from: `${month}-01`, to: `${month}-31` };
}

async function lateStartTime(ctx, bizId, staffId) {
  const [cfg, sett] = await Promise.all([
    ctx.db.get(P.salary(bizId, staffId)), ctx.db.get(P.settings(bizId)),
  ]);
  return (cfg && cfg.data.startTime) || (sett && sett.data.punchInTime) || '10:00';
}

// ── Handlers ──

async function listBusinesses(ctx) {
  const all = await ctx.db.list('businesses');
  return json({ businesses: all.map((b) => ({ id: b.id, ...stripSecrets(b.data) })) });
}

async function listStaff(ctx, bizId) {
  const all = await ctx.db.list(P.staff(bizId));
  const staff = all.map((s) => ({ id: s.id, ...stripSecrets(s.data) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return json({ staff });
}

async function addStaff(ctx, bizId) {
  const b = ctx.body;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
  const pin = typeof b.pin === 'string' ? b.pin : '';
  const joiningDate = b.joiningDate || todayStr(ctx.tz);
  if (!name) throw bad('name is required');
  if (!/^[a-z0-9._-]{2,40}$/.test(username)) throw bad('username: 2-40 chars, letters/numbers/._-');
  if (!/^\d{4}$/.test(pin)) throw bad('pin must be a 4-digit string');
  if (!isValidDate(joiningDate)) throw bad('joiningDate must be YYYY-MM-DD');
  const existing = await ctx.db.list(P.staff(bizId), [['username', '==', username]]);
  if (existing.length) throw new HttpError(409, 'conflict', 'Username already taken');
  const id = newId();
  const data = { name, username, pin, active: true, joiningDate, _createdAt: new Date() };
  await ctx.db.commit([{ set: P.staffDoc(bizId, id), data, ifMissing: true }]);
  return json({ staff: { id, ...stripSecrets(data) } }, 201);
}

async function monthAttendance(ctx, bizId, month) {
  const { from, to } = monthRange(month);
  const filters = [['date', '>=', from], ['date', '<=', to]];
  const staffFilter = ctx.url.searchParams.get('staffId');
  const today = todayStr(ctx.tz);
  let recs = await ctx.db.list(P.recs(bizId), filters);
  if (staffFilter) recs = recs.filter((r) => r.data.staffId === staffFilter);
  let records = recs.map((r) => ({ ...publicRecord(r.id, r.data), flags: detectAnomalies(r.data, today) }))
    .sort((a, b) => (a.date + a.staffName).localeCompare(b.date + b.staffName));
  const byCode = {};
  for (const r of records) for (const f of r.flags) byCode[f.code] = (byCode[f.code] || 0) + 1;
  const flaggedCount = records.filter((r) => r.flags.length).length;
  if (ctx.url.searchParams.get('flagged') === '1') records = records.filter((r) => r.flags.length);
  return json({ month, summary: { records: recs.length, flagged: flaggedCount, byCode }, records });
}

async function getRecord(ctx, bizId, date, staffId) {
  if (!isValidDate(date)) throw bad('Invalid date');
  const rec = await ctx.db.get(P.rec(bizId, staffId, date));
  if (!rec) throw notFound('No attendance record for this staff/date');
  return json({ record: publicRecord(rec.id, rec.data), flags: detectAnomalies(rec.data, todayStr(ctx.tz)) });
}

const STRUCTURAL = ['overlapping_sessions', 'open_session_not_last', 'out_before_in', 'duplicate_session'];
function countCodes(flags) {
  const c = {};
  for (const f of flags) if (STRUCTURAL.includes(f.code)) c[f.code] = (c[f.code] || 0) + 1;
  return c;
}

/**
 * Edit one session's times, or add a session.
 * Body: {session: <index> | "new", in: "HH:MM", out?: "HH:MM" | null}
 */
async function editSession(ctx, bizId, date, staffId) {
  if (!isValidDate(date)) throw bad('Invalid date');
  const { session, in: inT, out: outT } = ctx.body;
  if (!isValidHHMM(inT)) throw bad('in must be HH:MM (24-hour)');
  if (outT != null && outT !== '' && !isValidHHMM(outT)) throw bad('out must be HH:MM (24-hour), or null if still in');
  if (outT && outT < inT) throw bad('out must be after in');
  if (!(session === 'new' || Number.isInteger(session))) throw bad('session must be an index or "new"');
  const times = sessionTimes(date, inT, outT || null, ctx.tz);
  const key = P.rec(bizId, staffId, date);
  const today = todayStr(ctx.tz);
  const startTime = await lateStartTime(ctx, bizId, staffId);
  const existing = await ctx.db.get(key);

  if (!existing) {
    if (session !== 'new' && session !== 0) throw notFound('No attendance record — use session "new" to create one');
    const staff = await requireStaff(ctx, bizId, staffId);
    const sess = { ...times, manual: true, source: 'api' };
    const rec = {
      staffId, staffName: staff.name, date,
      inISO: times.inISO, outISO: times.outISO,
      ...rollup([sess]),
      late: isLateAt(inT, startTime),
      manual: true, manualEdit: true,
      lastApiEdit: { at: new Date().toISOString(), action: 'create' },
      _updatedAt: new Date(),
    };
    await ctx.db.commit([{ set: key, data: rec, ifMissing: true }]);
    return json({ record: publicRecord(key.split('/').pop(), rec), flags: detectAnomalies(rec, today) }, 201);
  }

  const rec = existing.data;
  let sessions = Array.isArray(rec.sessions) && rec.sessions.length ? rec.sessions.slice() : [];
  if (!sessions.length && rec.inTime) {
    // Legacy flat record → treat as one session
    sessions = [{ inTime: rec.inTime, inISO: rec.inISO || '', outTime: rec.outTime || '', outISO: rec.outISO || '',
      workedMins: rec.workedMins || 0, workedDisplay: rec.workedDisplay || '' }];
  }
  const oldFirstIn = sessions[0] && sessions[0].inISO;
  let action;
  if (session === 'new') {
    sessions.push({ ...times, manual: true, source: 'api' });
    action = 'add_session';
  } else {
    if (session < 0 || session >= sessions.length) throw notFound(`Session ${session} does not exist`);
    sessions[session] = { ...sessions[session], ...times };
    action = 'edit_session_' + session;
  }
  sessions.sort((a, b) => String(a.inISO).localeCompare(String(b.inISO)));
  const update = { ...rollup(sessions) };
  if (sessions[0].inISO !== oldFirstIn) update.late = isLateAt(localHHMM(sessions[0].inISO, ctx.tz), startTime);
  const before = countCodes(detectAnomalies(rec, today));
  const after = countCodes(detectAnomalies({ ...rec, ...update }, today));
  for (const code of Object.keys(after)) {
    if (after[code] > (before[code] || 0)) {
      throw new HttpError(422, 'would_create_anomaly', `This change would create a ${code.replace(/_/g, ' ')} — not saved`);
    }
  }
  Object.assign(update, { manualEdit: true, lastApiEdit: { at: new Date().toISOString(), action }, _updatedAt: new Date() });
  await ctx.db.commit([{ set: key, data: update, merge: true, ifUpdateTime: existing.updateTime }]);
  const merged = { ...rec, ...update };
  return json({ record: publicRecord(existing.id, merged), flags: detectAnomalies(merged, today) });
}

async function deleteSession(ctx, bizId, date, staffId, idxStr) {
  if (!isValidDate(date)) throw bad('Invalid date');
  const idx = Number(idxStr);
  const key = P.rec(bizId, staffId, date);
  const existing = await ctx.db.get(key);
  if (!existing) throw notFound('No attendance record for this staff/date');
  const rec = existing.data;
  const sessions = Array.isArray(rec.sessions) ? rec.sessions.slice() : [];
  if (idx >= sessions.length) throw notFound(`Session ${idx} does not exist`);
  if (sessions.length <= 1) {
    throw new HttpError(409, 'last_session', 'Only one session exists — the API will not delete the whole record');
  }
  sessions.splice(idx, 1);
  const update = { ...rollup(sessions) };
  if (idx === 0) {
    const startTime = await lateStartTime(ctx, bizId, staffId);
    update.late = isLateAt(localHHMM(sessions[0].inISO, ctx.tz), startTime);
  }
  Object.assign(update, {
    manualEdit: true, lastApiEdit: { at: new Date().toISOString(), action: 'delete_session_' + idx }, _updatedAt: new Date(),
  });
  await ctx.db.commit([{ set: key, data: update, merge: true, ifUpdateTime: existing.updateTime }]);
  const merged = { ...rec, ...update };
  return json({ record: publicRecord(existing.id, merged), flags: detectAnomalies(merged, todayStr(ctx.tz)) });
}

async function payroll(ctx, bizId, month, staffId) {
  const { y, m, from, to } = monthRange(month);
  const q = ctx.url.searchParams;
  const intParam = (name) => {
    const v = q.get(name);
    if (v == null || v === '') return null;
    if (!/^\d+$/.test(v)) throw bad(name + ' must be a non-negative integer');
    return Number(v);
  };
  const staff = await requireStaff(ctx, bizId, staffId);
  const [cfgDoc, recs, marks, ledger, advances] = await Promise.all([
    ctx.db.get(P.salary(bizId, staffId)),
    ctx.db.list(P.recs(bizId), [['staffId', '==', staffId], ['date', '>=', from], ['date', '<=', to]]),
    ctx.db.list(P.days(bizId), [['date', '>=', from], ['date', '<=', to]]),
    ctx.db.get(P.advLedger(bizId, staffId)),
    ctx.db.list(P.advances(bizId), [['staffId', '==', staffId]]),
  ]);
  const recMap = {};
  for (const r of recs) recMap[r.data.staffId + '_' + r.data.date] = r.data;
  const markMap = {};
  for (const d of marks) markMap[d.data.date + (d.data.staffId ? '_' + d.data.staffId : '')] = d.data;
  const result = computePayroll({
    cfg: cfgDoc ? cfgDoc.data : defaultSalaryCfg(),
    staff, sid: staffId, year: y, month: m,
    today: localParts(new Date(), ctx.tz),
    recs: recMap, marks: markMap,
    ledgerBalance: ledger ? ledger.data.balance || 0 : 0,
    advances: advances.map((a) => a.data),
    incentive: intParam('incentive') || 0,
    advanceRecover: intParam('advanceRecover'),
  });
  return json({ staffId, staffName: staff.name, salaryConfigured: !!cfgDoc, ...result });
}

async function giveAdvance(ctx, bizId) {
  const { staffId, amount, note } = ctx.body;
  const date = ctx.body.date || todayStr(ctx.tz);
  if (typeof staffId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(staffId)) throw bad('staffId is required');
  if (!Number.isInteger(amount) || amount <= 0) throw bad('amount must be a positive integer (₹)');
  if (!isValidDate(date)) throw bad('date must be YYYY-MM-DD');
  if (note != null && typeof note !== 'string') throw bad('note must be a string');
  const staff = await requireStaff(ctx, bizId, staffId);
  const advId = newId(), logId = newId();
  // Advance, ledger balance and log are written atomically; retry if the
  // ledger changed between read and write (e.g. owner gave one in the app).
  for (let attempt = 0; attempt < 3; attempt++) {
    const ledger = await ctx.db.get(P.advLedger(bizId, staffId));
    const prev = ledger && ledger.data.balance > 0 ? ledger.data.balance : 0;
    const ledgerWrite = {
      set: P.advLedger(bizId, staffId),
      data: { staffId, staffName: staff.name, balance: prev + amount, lastUpdated: new Date().toISOString() },
      merge: true,
      ...(ledger ? { ifUpdateTime: ledger.updateTime } : { ifMissing: true }),
    };
    try {
      await ctx.db.commit([
        { set: `${P.advances(bizId)}/${advId}`, ifMissing: true,
          data: { staffId, staffName: staff.name, amount, date, note: note || '', recovered: false,
            countedInLedger: true, source: 'api', _createdAt: new Date() } },
        ledgerWrite,
        { set: `${P.advLedgerLog(bizId)}/${logId}`, ifMissing: true,
          data: { type: 'given', staffId, staffName: staff.name, amount, date, note: note || '',
            balanceBefore: prev, balanceAfter: prev + amount, ts: Date.now(), source: 'api', _createdAt: new Date() } },
      ]);
      return json({ advance: { id: advId, staffId, amount, date, note: note || '' },
        ledger: { balanceBefore: prev, balanceAfter: prev + amount } }, 201);
    } catch (e) {
      const retryable = e instanceof FirestoreError && e.code === 'FAILED_PRECONDITION';
      if (!retryable || attempt === 2) throw e;
    }
  }
}
