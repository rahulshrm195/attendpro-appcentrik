// Integration tests: the Worker's fetch handler against the Firestore emulator.
// Run with `npm test` (starts the emulator automatically).
import { test, before } from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createFirestore } from '../src/firestore.js';

const KEY = 'k'.repeat(40);
const env = {
  API_KEY: KEY,
  FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080',
  FIREBASE_PROJECT_ID: 'demo-attendpro',
  TZ_OFFSET: '+05:30',
};
const db = createFirestore(env);
const B = 'businesses/B1';

async function call(method, path, body, key = KEY) {
  const res = await worker.fetch(new Request('https://api.test' + path, {
    method,
    headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: res.status, body: await res.json() };
}

const iso = (date, hhmm) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();
const sess = (date, i, o, extra = {}) => {
  const s = { inTime: i, inISO: iso(date, i), outTime: o || '', outISO: o ? iso(date, o) : '', ...extra };
  if (o) s.workedMins = Math.round((new Date(s.outISO) - new Date(s.inISO)) / 60000);
  return s;
};
const rec = (sid, date, sessions, extra = {}) => ({
  staffId: sid, staffName: sid === 'S1' ? 'Ravi' : 'Amit', date, sessions,
  inTime: sessions[0].inTime, outTime: sessions[sessions.length - 1].outTime,
  workedMins: sessions.reduce((a, s) => a + (s.workedMins || 0), 0), ...extra,
});

before(async () => {
  await fetch(`http://${env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-attendpro/databases/(default)/documents`,
    { method: 'DELETE' });
  const w = (path, data) => ({ set: path, data });
  const sep = (d) => '2026-09-' + String(d).padStart(2, '0');
  await db.commit([
    w(B, { name: 'SR Shoes', companyCode: 'SRS', ownerUser: 'owner', ownerPass: 'secret1', kioskPin: '9999' }),
    w('businesses/B2', { name: 'Other Shop', companyCode: 'OTH', ownerPass: 'x' }),
    w(`${B}/settings/main`, { punchInTime: '10:00' }),
    w(`${B}/staff/S1`, { name: 'Ravi', username: 'ravi', pin: '1111', active: true, joiningDate: '2026-01-01' }),
    w(`${B}/staff/S2`, { name: 'Amit', username: 'amit', pin: '2222', active: true, joiningDate: '2026-01-01' }),
    w(`${B}/salary_config/S1`, { base: 30000, weeklyOff: 0, startTime: '10:00', endTime: '19:00', standardHours: 0,
      minHours: 1, otRateMode: 'manual', otRate: 100, lateRule: 'fixed', lateAmount: 50, lateHalfAfter: 3, showWoPay: false }),
    // ── payroll month: Sept 2026 (Sundays: 6, 13, 20, 27) ──
    w(`${B}/attendance/S1_${sep(1)}`, rec('S1', sep(1), [sess(sep(1), '10:15', '19:15')], { late: true })), // 540, late
    w(`${B}/attendance/S1_${sep(2)}`, rec('S1', sep(2), [sess(sep(2), '09:00', '19:00')])),                 // 600 → OT 60
    w(`${B}/attendance/S1_${sep(3)}`, rec('S1', sep(3), [sess(sep(3), '10:00', '14:30')])),                 // 270 short
    w(`${B}/attendance/S1_${sep(4)}`, rec('S1', sep(4), [sess(sep(4), '10:00', '10:30')])),                 // 30 → absent
    w(`${B}/attendance/S1_${sep(6)}`, rec('S1', sep(6), [sess(sep(6), '10:00', '14:30')])),                 // Sunday 270
    w(`${B}/days/${sep(5)}`, { type: 'holiday', date: sep(5) }),
    w(`${B}/days/${sep(7)}_S1`, { type: 'leave', date: sep(7), staffId: 'S1', paidLeave: true }),
    w(`${B}/days/${sep(8)}_S2`, { type: 'leave', date: sep(8), staffId: 'S2', paidLeave: true }),
    w(`${B}/advance_ledger/S1`, { staffId: 'S1', balance: 3000 }),
    w(`${B}/advances/A1`, { staffId: 'S1', amount: 1000, date: sep(10) }),
    w(`${B}/advances/A2`, { staffId: 'S1', amount: 2000, date: '2026-08-20' }),
    // ── anomalies: Aug 2026 ──
    w(`${B}/attendance/S1_2026-08-10`, rec('S1', '2026-08-10', [
      sess('2026-08-10', '10:00', '13:00', { inSelfie: 'data:image/jpeg;base64,AAAA' }),
      sess('2026-08-10', '10:01', '19:00', { inSelfie: 'data:image/jpeg;base64,BBBB' }),
    ], { late: false })),
    w(`${B}/attendance/S1_2026-08-11`, rec('S1', '2026-08-11', [sess('2026-08-11', '10:00', '10:01')])),
    w(`${B}/attendance/S1_2026-08-12`, rec('S1', '2026-08-12', [sess('2026-08-12', '10:00', null)])),
    w(`${B}/attendance/S1_2026-08-13`, rec('S1', '2026-08-13', [
      sess('2026-08-13', '10:00', '15:00'), sess('2026-08-13', '14:00', '19:00')])),
    w(`${B}/attendance/S2_2026-08-10`, rec('S2', '2026-08-10', [sess('2026-08-10', '09:55', '19:00')])),
  ]);
});

test.before(async () => {
  // July 2026 data for auto-fix / month-end (Amit, no weekly off, 10:00–19:00)
  const jul = (d) => '2026-07-' + String(d).padStart(2, '0');
  await db.commit([
    { set: `${B}/salary_config/S2`, data: { base: 31000, weeklyOff: -1, startTime: '10:00', endTime: '19:00', standardHours: 9,
      minHours: 1, otRateMode: 'none', otRate: 0, lateRule: 'fixed', lateAmount: 0 } },
    // double tap: open session + same-minute session with punch-out
    { set: `${B}/attendance/S2_${jul(6)}`, data: rec('S2', jul(6), [sess(jul(6), '10:31', '13:00'), sess(jul(6), '14:05', null), sess(jul(6), '14:05', '21:58')]) },
    // triple tap
    { set: `${B}/attendance/S2_${jul(7)}`, data: rec('S2', jul(7), [sess(jul(7), '11:24', null), sess(jul(7), '11:24', null), sess(jul(7), '11:24', '21:36')]) },
    // unclear: two different punch-outs → left for a person
    { set: `${B}/attendance/S2_${jul(8)}`, data: rec('S2', jul(8), [sess(jul(8), '10:00', '13:00'), sess(jul(8), '10:01', '19:00')]) },
    // 22-minute day → needs a check
    { set: `${B}/attendance/S2_${jul(9)}`, data: rec('S2', jul(9), [sess(jul(9), '21:13', '21:35')]) },
    { set: `${B}/payments/S2_2026-07`, data: { staffId: 'S2', month: '2026-07', net: '₹100', mode: 'upi', date: '1/8/2026', incentive: 250, advRecovered: 0 } },
  ]);
});

test('auth and routing', async () => {
  assert.equal((await call('GET', '/health', null, null)).status, 200);
  assert.equal((await call('GET', '/biz/list', null, null)).status, 401);
  assert.equal((await call('GET', '/biz/list', null, 'wrong')).status, 401);
  assert.equal((await call('GET', '/biz/NOPE/staff')).status, 404);
  assert.equal((await call('GET', '/nothing')).status, 404);
  assert.equal((await call('PUT', '/biz/B1/staff')).status, 405);
  assert.equal((await call('GET', '/biz/B1/staff/../../x')).status, 404);
});

test('API refuses to run with a weak key', async () => {
  const res = await worker.fetch(new Request('https://api.test/biz/list', { headers: { Authorization: 'Bearer short' } }),
    { ...env, API_KEY: 'short' });
  assert.equal(res.status, 500);
});

test('GET /biz/list hides passwords and PINs', async () => {
  const { status, body } = await call('GET', '/biz/list');
  assert.equal(status, 200);
  assert.equal(body.businesses.length, 2);
  const b1 = body.businesses.find((b) => b.id === 'B1');
  assert.equal(b1.name, 'SR Shoes');
  assert.equal(b1.ownerPass, undefined);
  assert.equal(b1.kioskPin, undefined);
});

test('staff: list hides PINs, add validates and rejects duplicate usernames', async () => {
  let r = await call('GET', '/biz/B1/staff');
  assert.equal(r.body.staff.length, 2);
  assert.ok(r.body.staff.every((s) => s.pin === undefined));
  assert.equal((await call('POST', '/biz/B1/staff', { name: 'X', username: 'x1', pin: '12' })).status, 400);
  assert.equal((await call('POST', '/biz/B1/staff', { name: 'Dup', username: 'Ravi', pin: '1234' })).status, 409);
  r = await call('POST', '/biz/B1/staff', { name: 'Neha', username: 'Neha', pin: '4321', joiningDate: '2026-10-01' });
  assert.equal(r.status, 201);
  assert.equal(r.body.staff.username, 'neha');
  assert.equal(r.body.staff.pin, undefined);
  const saved = await db.get(`${B}/staff/${r.body.staff.id}`);
  assert.equal(saved.data.pin, '4321');
  assert.equal(saved.data.active, true);
});

test('attendance month: flags anomalies, strips selfies', async () => {
  const { status, body } = await call('GET', '/biz/B1/attendance/2026-08');
  assert.equal(status, 200);
  assert.equal(body.summary.records, 5);
  const codes = (date, sid = 'S1') => body.records.find((r) => r.date === date && r.staffId === sid).flags.map((f) => f.code);
  assert.deepEqual(codes('2026-08-10'), ['duplicate_session']);
  assert.deepEqual(codes('2026-08-11'), ['tiny_session', 'short_day']);
  assert.deepEqual(codes('2026-08-12'), ['missing_punch_out']);
  assert.deepEqual(codes('2026-08-13'), ['overlapping_sessions']);
  assert.deepEqual(codes('2026-08-10', 'S2'), []);
  assert.equal(body.summary.flagged, 4);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('base64'), 'no selfie data in response');
  const dup = body.records.find((r) => r.date === '2026-08-10' && r.staffId === 'S1');
  assert.equal(dup.sessions[0].hasInSelfie, true);
  const flagged = await call('GET', '/biz/B1/attendance/2026-08?flagged=1');
  assert.equal(flagged.body.records.length, 4);
  const one = await call('GET', '/biz/B1/attendance/2026-08?staffId=S2');
  assert.equal(one.body.records.length, 1);
});

test('DELETE session removes the duplicate and recomputes totals', async () => {
  let r = await call('DELETE', '/biz/B1/attendance/2026-08-10/S1/session/0');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.flags, []);
  assert.equal(r.body.record.sessions.length, 1);
  assert.equal(r.body.record.workedMins, 539);
  assert.equal(r.body.record.inTime, '10:01');
  assert.equal(r.body.record.late, true, 'late recomputed from new first session (10:01 > 10:00)');
  const saved = await db.get(`${B}/attendance/S1_2026-08-10`);
  assert.equal(saved.data.sessions[0].inSelfie, 'data:image/jpeg;base64,BBBB', 'remaining selfie kept');
  assert.equal(saved.data.manualEdit, true);
  r = await call('DELETE', '/biz/B1/attendance/2026-08-10/S1/session/0');
  assert.equal(r.status, 409, 'will not delete the last session');
  assert.equal((await call('DELETE', '/biz/B1/attendance/2026-08-10/S1/session/5')).status, 404);
});

test('PATCH edits a session, fixes missing punch-out, keeps selfies', async () => {
  let r = await call('PATCH', '/biz/B1/attendance/2026-08-12/S1', { session: 0, in: '10:00', out: '18:30' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.flags, []);
  assert.equal(r.body.record.outTime, '6:30 PM');
  assert.equal(r.body.record.workedMins, 510);
  assert.equal(r.body.record.workedDisplay, '8h 30m');
  const saved = await db.get(`${B}/attendance/S1_2026-08-12`);
  assert.equal(saved.data.sessions[0].outISO, '2026-08-12T13:00:00.000Z', 'IST → UTC');
  assert.equal(saved.data.staffName, 'Ravi', 'untouched fields kept');
});

test('PATCH rejects changes that would create an anomaly', async () => {
  const r = await call('PATCH', '/biz/B1/attendance/2026-08-12/S1', { session: 'new', in: '12:00', out: '13:00' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'would_create_anomaly');
  assert.equal((await call('PATCH', '/biz/B1/attendance/2026-08-12/S1', { session: 0, in: '18:00', out: '10:00' })).status, 400);
  assert.equal((await call('PATCH', '/biz/B1/attendance/2026-08-12/S1', { session: 0, in: '9am' })).status, 400);
});

test('PATCH fixes an overlap and adds a session in time order', async () => {
  let r = await call('PATCH', '/biz/B1/attendance/2026-08-13/S1', { session: 1, in: '15:30', out: '19:00' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.flags, []);
  r = await call('PATCH', '/biz/B1/attendance/2026-08-13/S1', { session: 'new', in: '08:00', out: '09:00' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.record.sessions.map((s) => s.inTime), ['8:00 AM', '10:00', '3:30 PM']);
  assert.equal(r.body.record.inTime, '8:00 AM');
  assert.equal(r.body.record.workedMins, 60 + 300 + 210);
  assert.equal(r.body.record.late, false);
});

test('PATCH with session "new" creates a missing record', async () => {
  const r = await call('PATCH', '/biz/B1/attendance/2026-08-14/S2', { session: 'new', in: '10:20', out: null });
  assert.equal(r.status, 201);
  assert.equal(r.body.record.staffName, 'Amit');
  assert.equal(r.body.record.late, true);
  assert.equal(r.body.record.sessions[0].outTime, '');
  assert.equal((await call('PATCH', '/biz/B1/attendance/2026-08-15/S2', { session: 3, in: '10:00' })).status, 404);
  assert.equal((await call('PATCH', '/biz/B1/attendance/2026-08-15/NOBODY', { session: 'new', in: '10:00' })).status, 404);
});

test('payroll matches the app rules', async () => {
  // Work days 24 (30 − 4 Sundays − holiday − paid leave); present 3, absent 21, late 1
  // base = round(1350/540 × 1000) = 2500, OT 60 min × ₹100 = 100, Sunday 270 min → 500,
  // paid leave 1000, late −50, 4 paid Sundays 4000, paid holiday 1000 → gross 9050; recover ₹1000 → net 8050
  // (Sept has 30 days, so the daily rate is ₹30,000 ÷ 30 = ₹1,000)
  const { status, body } = await call('GET', '/biz/B1/payroll/2026-09/S1');
  assert.equal(status, 200);
  assert.deepEqual(
    { ...body.attendance },
    { workDays: 24, present: 3, absent: 21, late: 1, offDays: 6, weeklyOffDays: 4, holidays: 1, weeklyOffWorked: 1,
      paidLeaveDays: 1, shortDays: 1, shortMins: 270, otMins: 60, baseWorkedMins: 1350 });
  assert.deepEqual(body.pay, { basePay: 2500, otPay: 100, incentive: 0, weeklyOffBonus: 500, weeklyOffPay: 4000,
    holidayPay: 1000, paidLeave: 1000, lateDeduction: 50, gross: 9050, advanceRecovered: 1000, net: 8050 });
  assert.deepEqual(body.advances, { outstanding: 3000, thisMonth: 1000, carriedIn: 2000, carryForwardAfter: 2000 });

  const r2 = await call('GET', '/biz/B1/payroll/2026-09/S1?incentive=200&advanceRecover=5000');
  assert.equal(r2.body.pay.gross, 9250);
  assert.equal(r2.body.pay.advanceRecovered, 3000);
  assert.equal(r2.body.pay.net, 6250);
  assert.equal((await call('GET', '/biz/B1/payroll/2026-09/S1?incentive=-5')).status, 400);
  assert.equal((await call('GET', '/biz/B1/payroll/2026-09/NOBODY')).status, 404);
});

test('weekly offs unpaid when the business turns them off', async () => {
  await db.commit([{ set: `${B}/settings/main`, data: { weeklyOffPaid: false }, merge: true }]);
  const { body } = await call('GET', '/biz/B1/payroll/2026-09/S1');
  assert.equal(body.pay.weeklyOffPay, 0);
  assert.equal(body.pay.gross, 5050);
  await db.commit([{ set: `${B}/settings/main`, data: { weeklyOffPaid: true }, merge: true }]);
});

test('daily rate follows the month length; full month = full salary', async () => {
  // August 2026 (31 days, past): every day worked full standard hours + weekly offs paid → exactly the base salary
  const w = [];
  for (let d = 1; d <= 31; d++) {
    const ds = '2026-08-' + String(d).padStart(2, '0');
    w.push({ set: `${B}/attendance/S9_${ds}`, data: rec('S9', ds, [sess(ds, '10:00', '19:00')]) });
  }
  w.push({ set: `${B}/staff/S9`, data: { name: 'Full Month', username: 'full', pin: '9999', active: true, joiningDate: '2026-01-01' } });
  w.push({ set: `${B}/salary_config/S9`, data: { base: 31000, weeklyOff: -1, startTime: '10:00', endTime: '19:00', standardHours: 9,
    minHours: 1, otRateMode: 'none', otRate: 0, lateRule: 'fixed', lateAmount: 0, showWoPay: false } });
  await db.commit(w);
  const { body } = await call('GET', '/biz/B1/payroll/2026-08/S9');
  assert.equal(body.rates.perDay, 1000);
  assert.equal(body.pay.basePay, 31000);
});

test('payroll for all staff matches the single-staff numbers', async () => {
  const { status, body } = await call('GET', '/biz/B1/payroll/2026-09');
  assert.equal(status, 200);
  const ravi = body.staff.find((x) => x.staffId === 'S1');
  assert.equal(ravi.pay.net, 8050);
  assert.equal(ravi.salaryConfigured, true);
  const neha = body.staff.find((x) => x.staffName === 'Neha');
  assert.equal(neha.salaryConfigured, false);
  assert.equal(body.total.net, body.staff.reduce((t, x) => t + x.pay.net, 0));
  assert.deepEqual(body.staff.map((x) => x.staffName), [...body.staff.map((x) => x.staffName)].sort());
});

test('report script prints problems with fix commands and a salary sheet', async () => {
  const server = createServer(async (req, res) => {
    const r = await worker.fetch(new Request('http://x' + req.url, { method: req.method, headers: req.headers }), env);
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(await r.text());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const csv = '/tmp/attendpro-report-test.csv';
  const out = await new Promise((resolve, reject) => execFile(process.execPath,
    [new URL('../scripts/report.mjs', import.meta.url).pathname, 'srs', '2026-08', '--csv', csv],
    { env: { ...process.env, API_URL: url, API_KEY: KEY } },
    (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));
  server.close();
  assert.match(out, /SR Shoes — 2026-08/);
  assert.match(out, /Session 1 lasted under 2 min/);
  assert.match(out, /curl -X DELETE .*\/attendance\/2026-08-11\/S1\/session\/0/);
  assert.match(out, /TOTAL/);
  assert.ok(!out.includes(KEY), 'API key never printed');
  const sheet = readFileSync(csv, 'utf8');
  assert.match(sheet.split('\n')[0], /^Name,Staff ID,Present/);
  rmSync(csv);
});

test('POST advance writes advance, ledger and log together', async () => {
  assert.equal((await call('POST', '/biz/B1/advance', { staffId: 'S1', amount: -5 })).status, 400);
  assert.equal((await call('POST', '/biz/B1/advance', { staffId: 'NOBODY', amount: 500 })).status, 404);
  const r = await call('POST', '/biz/B1/advance', { staffId: 'S1', amount: 500, date: '2026-09-15', note: 'festival' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.ledger, { balanceBefore: 3000, balanceAfter: 3500 });
  assert.equal((await db.get(`${B}/advance_ledger/S1`)).data.balance, 3500);
  const adv = await db.get(`${B}/advances/${r.body.advance.id}`);
  assert.equal(adv.data.amount, 500);
  assert.equal(adv.data.recovered, false);
  const logs = await db.list(`${B}/advance_ledger_log`);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].data.balanceAfter, 3500);
  // ledger doc missing → created
  const r2 = await call('POST', '/biz/B1/advance', { staffId: 'S2', amount: 700 });
  assert.equal(r2.status, 201);
  assert.equal((await db.get(`${B}/advance_ledger/S2`)).data.balance, 700);
});

test('auto-fix: preview changes nothing, apply fixes clear double taps only', async () => {
  let r = await call('POST', '/biz/B1/attendance/2026-07/autofix', { dryRun: true, staffId: 'S2' });
  assert.equal(r.status, 200);
  assert.equal(r.body.summary.daysFixed, 2);
  assert.equal(r.body.summary.sessionsRemoved, 3);
  assert.equal((await db.get(`${B}/attendance/S2_2026-07-06`)).data.sessions.length, 3, 'dry run wrote nothing');
  r = await call('POST', '/biz/B1/attendance/2026-07/autofix', { staffId: 'S2' });
  assert.equal(r.body.summary.daysFixed, 2);
  const d6 = (await db.get(`${B}/attendance/S2_2026-07-06`)).data;
  assert.deepEqual(d6.sessions.map((x) => x.inTime + '-' + x.outTime), ['10:31-13:00', '14:05-21:58']);
  assert.equal(d6.workedMins, 149 + 473);
  assert.equal(d6.removedDuplicates.length, 1);
  assert.equal((await db.get(`${B}/attendance/S2_2026-07-07`)).data.sessions.length, 1);
  assert.equal((await db.get(`${B}/attendance/S2_2026-07-08`)).data.sessions.length, 2, 'unclear day untouched');
  const codes = r.body.needsReview.map((x) => x.date + ':' + x.flags.map((f) => f.code).join(','));
  assert.ok(codes.includes('2026-07-08:duplicate_session'), codes.join(' | '));
  assert.ok(codes.some((c) => c.startsWith('2026-07-09:') && c.includes('short_day') && c.includes('late_start')), codes.join(' | '));
  r = await call('POST', '/biz/B1/attendance/2026-07/autofix', { staffId: 'S2' });
  assert.equal(r.body.summary.daysFixed, 0, 'second run has nothing left to fix');
});

test('paid month payroll uses the saved payment (incentive)', async () => {
  const { body } = await call('GET', '/biz/B1/payroll/2026-07/S2');
  assert.equal(body.payment.paid, true);
  assert.equal(body.payment.mode, 'upi');
  assert.equal(body.pay.incentive, 250);
});

test('salary slips: one staff and all staff, as HTML', async () => {
  let res = await worker.fetch(new Request('https://api.test/biz/B1/payroll/2026-09/S1/slip', { headers: { Authorization: 'Bearer ' + KEY } }), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  let page = await res.text();
  assert.match(page, /Salary Slip/);
  assert.match(page, /Ravi/);
  assert.match(page, /Net Payable/);
  assert.match(page, /Holiday Pay \(1 day\)/);
  assert.ok(!page.includes('Amit'));
  res = await worker.fetch(new Request('https://api.test/biz/B1/payroll/2026-09/slips', { headers: { Authorization: 'Bearer ' + KEY } }), env);
  page = await res.text();
  assert.ok(page.includes('Ravi') && page.includes('Amit'), 'all staff in one document');
  assert.ok((page.match(/class="slip"/g) || []).length >= 2);
  res = await worker.fetch(new Request('https://api.test/biz/B1/payroll/2026-09/slips'), env);
  assert.equal(res.status, 401, 'slips need the key');
});

test('month end: preview, then apply', async () => {
  await db.commit([{ set: `${B}/attendance/S1_2026-06-15`, data: rec('S1', '2026-06-15', [sess('2026-06-15', '10:00', null), sess('2026-06-15', '10:00', '19:00')]) }]);
  let r = await call('POST', '/biz/B1/monthend/2026-06', { apply: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.applied, false);
  assert.equal(r.body.autofix.summary.daysFixed, 1);
  assert.equal((await db.get(`${B}/attendance/S1_2026-06-15`)).data.sessions.length, 2, 'preview wrote nothing');
  r = await call('POST', '/biz/B1/monthend/2026-06', {});
  assert.equal(r.body.applied, true);
  assert.equal((await db.get(`${B}/attendance/S1_2026-06-15`)).data.sessions.length, 1);
  const ravi = r.body.payroll.staff.find((x) => x.staffId === 'S1');
  assert.ok(ravi && ravi.slipUrl.endsWith('/biz/B1/payroll/2026-06/S1/slip'));
  assert.ok(r.body.allSlipsUrl.endsWith('/biz/B1/payroll/2026-06/slips'));
  assert.equal(typeof r.body.payroll.total.net, 'number');
  assert.equal(r.body.business, 'SR Shoes');
});
