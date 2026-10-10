// Owner push notifications: Web Push crypto + the cron logic against the
// Firestore emulator (own project id, so it can run next to api.test.mjs).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createFirestore } from '../src/firestore.js';
import { encryptPayload, vapidJwt, ensureVapid, b64urlEncode, b64urlDecode } from '../src/webpush.js';
import { runNotifications } from '../src/notify.js';
import worker from '../src/index.js';

const env = {
  API_KEY: 'n'.repeat(40),
  FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080',
  FIREBASE_PROJECT_ID: 'demo-notify',
  TZ_OFFSET: '+05:30',
};
const db = createFirestore(env);
const B = 'businesses/N1';
const D = '2026-10-10'; // a Saturday
const at = (hhmm, date = D) => new Date(`${date}T${hhmm}:00+05:30`);
const iso = (hhmm) => at(hhmm).toISOString();
const sess = (i, o) => ({ inTime: i, inISO: iso(i), outTime: o || '', outISO: o ? iso(o) : '',
  workedMins: o ? Math.round((at(o) - at(i)) / 60000) : 0 });
const rec = (sid, name, sessions) => ({ staffId: sid, staffName: name, date: D, sessions });

// Captures pushes instead of sending them; endpoint "gone" answers 410
const sent = [];
const send = async (sub, msg) => {
  if (sub.endpoint.includes('gone')) return { ok: false, status: 410, gone: true };
  sent.push({ to: sub.endpoint, ...msg });
  return { ok: true, status: 201 };
};
const run = (hhmm) => runNotifications(env, at(hhmm), { send });
const take = () => sent.splice(0);

before(async () => {
  await fetch(`http://${env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-notify/databases/(default)/documents`, { method: 'DELETE' });
  const w = (path, data) => ({ set: path, data });
  const cfg = (o) => ({ base: 20000, weeklyOff: -1, startTime: '10:00', endTime: '21:00', standardHours: 11, minHours: 1, ...o });
  await db.commit([
    w(B, { name: 'SR Shoes', pushEnabled: true }),
    w('businesses/N2', { name: 'No push' }),
    w(`${B}/settings/main`, { punchInTime: '10:00', notif: { morningAt: '11:20', dayEndFrom: '20:00', dayEndLatest: '23:30' } }),
    w(`${B}/staff/S1`, { name: 'Mukesh Varma', active: true }),
    w(`${B}/staff/S2`, { name: 'Yogesh Patil', active: true }),
    w(`${B}/staff/S3`, { name: 'Kashish Sharma', active: true }),
    w(`${B}/staff/S4`, { name: 'Poonam Rao', active: true }),
    w(`${B}/staff/S5`, { name: 'Sahil Jadhav', active: false }),
    w(`${B}/staff/S6`, { name: 'Aishwarya K', active: true }),
    w(`${B}/salary_config/S1`, cfg()),
    w(`${B}/salary_config/S2`, cfg()),
    w(`${B}/salary_config/S3`, cfg()),
    w(`${B}/salary_config/S4`, cfg({ weeklyOff: 6 })), // Saturday off
    w(`${B}/salary_config/S6`, cfg()),
    w(`${B}/days/${D}_S6`, { type: 'leave', date: D, staffId: 'S6' }),
    w(`${B}/push_subs/a`, { endpoint: 'https://push.example/a', p256dh: 'x', auth: 'y' }),
    w(`${B}/push_subs/old`, { endpoint: 'https://push.example/gone', p256dh: 'x', auth: 'y' }),
  ]);
});

test('payload encryption matches the RFC 8291 example', async () => {
  const out = await encryptPayload(
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    new TextEncoder().encode('When I grow up, I want to be a watermelon'),
    { asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
      asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
      salt: 'DGv6ra1nlYgDCS1FRnbzlw' });
  assert.equal(b64urlEncode(out), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('VAPID key is made once, sealed, and signs verifiable JWTs', async () => {
  const v1 = await ensureVapid(db, env.API_KEY);
  const v2 = await ensureVapid(db, env.API_KEY);
  assert.equal(v1.publicKey, v2.publicKey);
  const stored = (await db.get('push_config/vapid')).data;
  assert.ok(!JSON.stringify(stored).includes(v1.privateJwk.d), 'private key must not be stored in clear');
  const jwt = await vapidJwt(v1, 'https://fcm.googleapis.com', 'https://attendpro.appcentrik.in', 1000);
  const [h, b, sig] = jwt.split('.');
  const pub = await crypto.subtle.importKey('raw', b64urlDecode(v1.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(sig), new TextEncoder().encode(h + '.' + b)));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(b))), { aud: 'https://fcm.googleapis.com', exp: 1000 + 43200, sub: 'https://attendpro.appcentrik.in' });
});

test('requests: first run starts from now, then each new request is sent once', async () => {
  await run('09:00');
  assert.equal(take().length, 0);
  await db.commit([
    { set: `${B}/requests/R1`, data: { type: 'leave', leaveType: 'full', staffId: 'S1', staffName: 'Mukesh Varma', from: '2026-10-12', to: '2026-10-13', reason: 'Wedding', status: 'pending', _createdAt: at('09:01') } },
    { set: `${B}/requests/R2`, data: { type: 'advance', staffId: 'S2', staffName: 'Yogesh Patil', amount: 2000, reason: 'Rent', status: 'pending', _createdAt: at('09:01') } },
  ]);
  const r = await run('09:02');
  const got = take();
  assert.deepEqual(got.map((m) => m.title).sort(), ['💰 Advance request — Yogesh Patil', '📋 Leave request — Mukesh Varma']);
  assert.match(got.find((m) => m.tag === 'req-R1').body, /Mon, 12 Oct → Tue, 13 Oct · Full day\nReason: Wedding/);
  assert.match(got.find((m) => m.tag === 'req-R2').body, /₹2,000/);
  assert.equal(r[0].removed, 1, 'dead subscription is removed');
  assert.equal(await db.get(`${B}/push_subs/old`), null);
  await run('09:04');
  assert.equal(take().length, 0, 'not sent twice');
});

test('morning: who is in the store at 11:20', async () => {
  await db.commit([
    { set: `${B}/attendance/S1_${D}`, data: rec('S1', 'Mukesh Varma', [sess('09:58', null)]) },
    { set: `${B}/attendance/S2_${D}`, data: rec('S2', 'Yogesh Patil', [sess('10:12', null)]) },
  ]);
  await run('11:18');
  assert.equal(take().length, 0, 'not before 11:20');
  await run('11:20');
  const [m] = take();
  assert.equal(m.title, '🏪 11:20 am — 2 of 3 in the store');
  assert.equal(m.body, '✅ In: Mukesh 9:58am, Yogesh 10:12am (late)\n❌ Not in: Kashish\n🏖️ Off: Poonam (weekly off), Aishwarya (leave)');
  await run('11:22');
  assert.equal(take().length, 0, 'once a day');
});

test('day end: waits until everyone has punched out, then sends once', async () => {
  await db.commit([
    { set: `${B}/attendance/S1_${D}`, data: rec('S1', 'Mukesh Varma', [sess('09:58', '21:05')]) },
    { set: `${B}/attendance/S2_${D}`, data: rec('S2', 'Yogesh Patil', [sess('10:12', '15:00'), sess('16:00', null)]) },
  ]);
  await run('21:10');
  assert.equal(take().length, 0, 'Yogesh is still in');
  await db.commit([{ set: `${B}/attendance/S2_${D}`, data: rec('S2', 'Yogesh Patil', [sess('10:12', '15:00'), sess('16:00', '20:30')]) }]);
  await run('21:12');
  const [m] = take();
  assert.equal(m.title, '🌙 Day end Sat, 10 Oct — 2 came, 1 absent');
  assert.equal(m.body, '✅ Full day: Mukesh 11h 7m\n⏱️ Short day: Yogesh 9h 18m of 11h 0m\n❌ Absent: Kashish\n🏖️ Off: Poonam (weekly off), Aishwarya (leave)');
  await run('21:14');
  assert.equal(take().length, 0);
});

test('day end at the latest time lists missed punch-outs; test button; other businesses skipped', async () => {
  const D2 = '2026-10-11';
  await db.commit([
    { set: `${B}/attendance/S3_${D2}`, data: { staffId: 'S3', staffName: 'Kashish Sharma', date: D2,
      sessions: [{ inTime: '10:02', inISO: at('10:02', D2).toISOString(), outISO: '' }] } },
    { set: `${B}/push_state/main`, data: { morningDay: D2 }, merge: true },
    { set: `${B}/settings/main`, data: { notifTestAt: Date.now() }, merge: true },
  ]);
  await runNotifications(env, at('23:00', D2), { send });
  assert.deepEqual(take().map((m) => m.title), ['✅ AttendPro notifications work'], 'only the test; day end waits');
  const r = await runNotifications(env, at('23:30', D2), { send });
  const [m] = take();
  assert.match(m.title, /^🌙 Day end Sun, 11 Oct — 1 came, 4 absent/);
  assert.match(m.body, /⚠️ No punch-out: Kashish \(in since 10:02am\)/);
  assert.deepEqual(r.map((x) => x.biz), ['N1']);
});

test('POST /notify/run needs the API key', async () => {
  const res = await worker.fetch(new Request('https://api.test/notify/run', { method: 'POST', body: '{}' }), env);
  assert.equal(res.status, 401);
});
