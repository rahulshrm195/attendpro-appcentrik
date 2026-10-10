// AttendPro API — Cloudflare Worker
// All routes except /health and /ping/punch need:  Authorization: Bearer <API_KEY>
// See worker/README.md for setup and endpoint reference.

import { createFirestore, newId, FirestoreError } from './firestore.js';
import {
  todayStr, localParts, localHHMM, isValidDate, isValidHHMM, isLateAt, sessionTimes, rollup,
  detectAnomalies, publicRecord, planDoubleTapFix, reviewFlags, minsToHM,
} from './attendance.js';
import { slipHtml, slipsDocument } from './slip.js';
import { computePayroll, defaultSalaryCfg } from './payroll.js';
import { runNotifications, runPunchPing } from './notify.js';

export default {
  // Cron (wrangler.toml [triggers]): owner push notifications
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNotifications(env, new Date(event.scheduledTime)).catch((e) => console.error('notify', e)));
  },
  async fetch(request, env, ctx) {
    try {
      const path = new URL(request.url).pathname.replace(/\/+$/, '');
      if (path === '/ping/punch') return await punchPing(request, env, ctx);
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
  ['POST', `^/biz/${ID}/attendance/(\\d{4}-\\d{2})/autofix$`, autofix],
  ['GET', `^/biz/${ID}/payroll/(\\d{4}-\\d{2})$`, payrollAll],
  ['GET', `^/biz/${ID}/payroll/(\\d{4}-\\d{2})/slips$`, slipsAll],
  ['GET', `^/biz/${ID}/payroll/(\\d{4}-\\d{2})/${ID}$`, payroll],
  ['GET', `^/biz/${ID}/payroll/(\\d{4}-\\d{2})/${ID}/slip$`, slipOne],
  ['POST', `^/biz/${ID}/monthend/(\\d{4}-\\d{2})$`, monthEnd],
  ['POST', `^/biz/${ID}/advance$`, giveAdvance],
  ['POST', '^/notify/run$', notifyRun],
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
  salaries: (b) => `businesses/${b}/salary_config`,
  ledgers: (b) => `businesses/${b}/advance_ledger`,
  payments: (b) => `businesses/${b}/payments`,
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
  const M = await loadMonth(ctx, bizId, month);
  const staffFilter = ctx.url.searchParams.get('staffId');
  let recs = M.recs;
  if (staffFilter) recs = recs.filter((r) => r.data.staffId === staffFilter);
  let records = recs.map((r) => ({ ...publicRecord(r.id, r.data), flags: allFlags(M, r.data) }))
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

// ── Month data shared by attendance, payroll, slips, auto-fix and month-end ──
async function loadMonth(ctx, bizId, month) {
  const { y, m, from, to } = monthRange(month);
  const [staffDocs, cfgs, recs, marks, ledgers, advances, sett, pays] = await Promise.all([
    ctx.db.list(P.staff(bizId)),
    ctx.db.list(P.salaries(bizId)),
    ctx.db.list(P.recs(bizId), [['date', '>=', from], ['date', '<=', to]]),
    ctx.db.list(P.days(bizId), [['date', '>=', from], ['date', '<=', to]]),
    ctx.db.list(P.ledgers(bizId)),
    ctx.db.list(P.advances(bizId)),
    ctx.db.get(P.settings(bizId)),
    ctx.db.list(P.payments(bizId), [['month', '==', month]]),
  ]);
  const byId = (docs) => Object.fromEntries(docs.map((d) => [d.id, d.data]));
  const settings = sett ? sett.data : {};
  return {
    bizId, month, y, m, settings,
    staff: staffDocs, staffMap: byId(staffDocs), cfgMap: byId(cfgs), ledgerMap: byId(ledgers),
    recs, recMap: recMapOf(recs), marks: markMapOf(marks),
    advances, payMap: Object.fromEntries(pays.map((d) => [d.data.staffId, d.data])),
    today: localParts(new Date(), ctx.tz), todayStr: todayStr(ctx.tz), tz: ctx.tz,
    weeklyOffPaid: settings.weeklyOffPaid !== false,
    holidayPaid: settings.holidayPaid !== false,
  };
}

function recMapOf(recs) {
  const m = {};
  for (const r of recs) m[r.data.staffId + '_' + r.data.date] = r.data;
  return m;
}
function markMapOf(marks) {
  const m = {};
  for (const d of marks) m[d.data.date + (d.data.staffId ? '_' + d.data.staffId : '')] = d.data;
  return m;
}

// Errors + "needs a check" flags for one record, with the staff's own hours and days off
function allFlags(M, rec) {
  const cfg = M.cfgMap[rec.staffId] || defaultSalaryCfg();
  const std = cfg.standardHours || autoStdHours(cfg);
  const dow = new Date(rec.date + 'T00:00:00Z').getUTCDay();
  const mark = M.marks[rec.date] || M.marks[rec.date + '_' + rec.staffId];
  const off = (cfg.weeklyOff >= 0 && dow == cfg.weeklyOff) || (mark && (mark.type === 'holiday' || mark.type === 'leave')); // eslint-disable-line eqeqeq
  return detectAnomalies(rec, M.todayStr).concat(reviewFlags(rec, M.todayStr, {
    stdMins: Math.round(std * 60), startTime: cfg.startTime || M.settings.punchInTime || '10:00', off,
  }, M.tz));
}
function autoStdHours(cfg) {
  const s = (cfg.startTime || '10:00').split(':').map(Number), e = (cfg.endTime || '21:00').split(':').map(Number);
  return Math.max(1, Math.round(((e[0] * 60 + e[1]) - (s[0] * 60 + s[1])) / 60 * 2) / 2);
}

// Payroll for one staff member. A paid month uses what was saved at payment
// (incentive, advance recovered; outstanding = current balance + that recovery).
function staffPayroll(M, sid, opts = {}) {
  const staff = M.staffMap[sid];
  const cfgDoc = M.cfgMap[sid];
  const paid = M.payMap[sid] || null;
  const curBal = M.ledgerMap[sid] ? M.ledgerMap[sid].balance || 0 : 0;
  const result = computePayroll({
    cfg: cfgDoc || defaultSalaryCfg(),
    staff, sid, year: M.y, month: M.m, today: M.today,
    recs: M.recMap, marks: M.marks,
    ledgerBalance: curBal + (paid ? paid.advRecovered || 0 : 0),
    advances: M.advances.filter((a) => a.data.staffId === sid).map((a) => a.data),
    weeklyOffPaid: M.weeklyOffPaid, holidayPaid: M.holidayPaid,
    incentive: opts.incentive != null ? opts.incentive : (paid ? paid.incentive || 0 : 0),
    advanceRecover: opts.advanceRecover != null ? opts.advanceRecover : (paid ? paid.advRecovered || 0 : null),
  });
  return {
    staffId: sid, staffName: staff.name, active: !!staff.active, salaryConfigured: !!cfgDoc,
    payment: paid ? { paid: true, date: paid.date, mode: paid.mode, note: paid.note || '', net: paid.net } : { paid: false },
    ...result,
  };
}

// Staff included in a month's payroll: active, or anyone with attendance that month
function payrollStaffIds(M) {
  const withRecs = new Set(M.recs.map((r) => r.data.staffId));
  return M.staff
    .filter((s) => s.data.active || withRecs.has(s.id))
    .sort((a, b) => String(a.data.name).localeCompare(String(b.data.name)))
    .map((s) => s.id);
}
function totals(list) {
  return list.reduce((t, s) => ({ gross: t.gross + s.pay.gross, net: t.net + s.pay.net,
    advanceRecovered: t.advanceRecovered + s.pay.advanceRecovered }), { gross: 0, net: 0, advanceRecovered: 0 });
}

async function payroll(ctx, bizId, month, staffId) {
  const q = ctx.url.searchParams;
  const intParam = (name) => {
    const v = q.get(name);
    if (v == null || v === '') return null;
    if (!/^\d+$/.test(v)) throw bad(name + ' must be a non-negative integer');
    return Number(v);
  };
  const incentive = intParam('incentive'), advanceRecover = intParam('advanceRecover');
  const M = await loadMonth(ctx, bizId, month);
  if (!M.staffMap[staffId]) throw notFound('Staff not found');
  return json(staffPayroll(M, staffId, { incentive, advanceRecover }));
}

/** Payroll for every active staff member (and anyone with attendance that month). */
async function payrollAll(ctx, bizId, month) {
  const M = await loadMonth(ctx, bizId, month);
  const staff = payrollStaffIds(M).map((sid) => staffPayroll(M, sid));
  return json({ month, total: totals(staff), staff });
}

// ── Salary slips (HTML, printable / attachable) ──
function html(body) {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function slipOne(ctx, bizId, month, staffId) {
  const M = await loadMonth(ctx, bizId, month);
  if (!M.staffMap[staffId]) throw notFound('Staff not found');
  return html(slipsDocument(ctx.biz, month, [staffPayroll(M, staffId)], M.staffMap));
}
async function slipsAll(ctx, bizId, month) {
  const M = await loadMonth(ctx, bizId, month);
  const list = payrollStaffIds(M).map((sid) => staffPayroll(M, sid));
  return html(slipsDocument(ctx.biz, month, list, M.staffMap));
}

// ── Auto-fix double taps for a month ──
// Body: {dryRun?: boolean, staffId?: string}. Days up to today only.
async function autofix(ctx, bizId, month) {
  const dryRun = !!(ctx.body && ctx.body.dryRun);
  const only = ctx.body && ctx.body.staffId;
  const M = await loadMonth(ctx, bizId, month);
  return json(await runAutofix(ctx, M, { dryRun, only }));
}

async function runAutofix(ctx, M, { dryRun, only }) {
  const fixed = [], failed = [];
  for (const r of M.recs) {
    const rec = r.data;
    if (only && rec.staffId !== only) continue;
    if (!rec.date || rec.date > M.todayStr) continue;
    const plan = planDoubleTapFix(rec);
    if (!plan) continue;
    const sessions = plan.keep.map((i) => rec.sessions[i]);
    const removed = plan.removed.map((i) => rec.sessions[i]);
    const entry = {
      staffId: rec.staffId, staffName: rec.staffName, date: rec.date,
      removed: removed.map((x) => ({ inTime: x.inTime || '', outTime: x.outTime || '' })),
      kept: sessions.map((x) => ({ inTime: x.inTime || '', outTime: x.outTime || '', workedMins: x.workedMins || 0 })),
    };
    if (!dryRun) {
      const update = {
        ...rollup(sessions),
        manualEdit: true,
        removedDuplicates: (Array.isArray(rec.removedDuplicates) ? rec.removedDuplicates : []).concat(removed.map((x) => ({
          inTime: x.inTime || '', inISO: x.inISO || '', outTime: x.outTime || '', outISO: x.outISO || '',
          removedAt: new Date().toISOString(),
        }))),
        lastApiEdit: { at: new Date().toISOString(), action: 'autofix' },
        _updatedAt: new Date(),
      };
      try {
        await ctx.db.commit([{ set: `businesses/${M.bizId}/attendance/${r.id}`, data: update, merge: true, ifUpdateTime: r.updateTime }]);
        Object.assign(rec, update);
      } catch (e) {
        failed.push({ ...entry, error: e.message });
        continue;
      }
    }
    fixed.push(entry);
  }
  // What still needs a person, after the fixes
  const needsReview = M.recs
    .filter((r) => !only || r.data.staffId === only)
    .map((r) => ({ staffId: r.data.staffId, staffName: r.data.staffName, date: r.data.date, flags: allFlags(M, r.data) }))
    .filter((x) => x.flags.length)
    .sort((a, b) => (a.date + a.staffName).localeCompare(b.date + b.staffName));
  return {
    month: M.month, dryRun: !!dryRun,
    summary: { daysFixed: fixed.length, sessionsRemoved: fixed.reduce((t, f) => t + f.removed.length, 0),
      failed: failed.length, needsReview: needsReview.length },
    fixed, failed, needsReview,
  };
}

// ── Month end in one call: auto-fix → what needs a person → payroll for everyone ──
// Body: {apply?: boolean = true}. With apply:false nothing is changed (preview).
async function monthEnd(ctx, bizId, month) {
  const apply = !(ctx.body && ctx.body.apply === false);
  const M = await loadMonth(ctx, bizId, month);
  const fix = await runAutofix(ctx, M, { dryRun: !apply });
  const staff = payrollStaffIds(M).map((sid) => staffPayroll(M, sid));
  const base = new URL(ctx.request.url).origin;
  return json({
    business: ctx.biz.name || bizId, month, applied: apply,
    autofix: { summary: fix.summary, fixed: fix.fixed, failed: fix.failed },
    needsReview: fix.needsReview,
    payroll: {
      total: totals(staff),
      notConfigured: staff.filter((s) => !s.salaryConfigured).map((s) => s.staffName),
      staff: staff.map((s) => ({
        staffId: s.staffId, staffName: s.staffName, paid: s.payment.paid,
        present: s.attendance.present, absent: s.attendance.absent, late: s.attendance.late,
        gross: s.pay.gross, advanceRecovered: s.pay.advanceRecovered, net: s.pay.net,
        advanceCarryForward: s.advances.carryForwardAfter,
        slipUrl: `${base}/biz/${bizId}/payroll/${month}/${s.staffId}/slip`,
      })),
    },
    allSlipsUrl: `${base}/biz/${bizId}/payroll/${month}/slips`,
  });
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
            countedInLedger: true, source: 'api', ts: Date.now(), _createdAt: new Date() } },
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

// Run the notification check now (the cron does this every 5 minutes)
// POST /ping/punch {"biz": "<id>"} — sent (navigator.sendBeacon) by a staff
// phone or kiosk right after a punch is saved. No key: it only makes the
// Worker do now what its cron would do within 5 minutes (send that
// business's new punches, if the owner turned punch alerts on).
// Pings for a business that arrive while one runs are folded into one rerun.
const punchRuns = new Map();
async function punchPing(request, env, ctx) {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
  if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });
  const body = await request.json().catch(() => null);
  const biz = body && typeof body.biz === 'string' && new RegExp(`^${ID}$`).test(body.biz) ? body.biz : null;
  if (!biz) return new Response('bad request', { status: 400, headers: cors });
  if (punchRuns.has(biz)) { punchRuns.get(biz).again = true; return new Response(null, { status: 202, headers: cors }); }
  const run = { again: false };
  punchRuns.set(biz, run);
  const work = (async () => {
    try {
      do { run.again = false; await runPunchPing(env, biz); } while (run.again);
    } catch (e) { console.error('punch ping', biz, e); }
    finally { punchRuns.delete(biz); }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
  return new Response(null, { status: 202, headers: cors });
}

async function notifyRun(ctx) {
  return json({ ok: true, report: await runNotifications(ctx.env, new Date(), { db: ctx.db }) });
}
