// Owner notifications, run by the Worker's cron (every 5 minutes):
//   • new leave / advance requests
//   • morning "who is in the store" (default 11:20)
//   • day-end summary once everyone has punched out (or at the latest time,
//     listing anyone who never punched out)
//   • optional: every punch in / out. The punching device pings /ping/punch
//     so these go out within seconds; the cron picks up anything missed.
//
// Settings live in settings/main → notif (edited in the app's Settings →
// Notifications). Owner devices register in businesses/{biz}/push_subs, and
// the app marks the business doc pushEnabled so the cron skips the others.
// What was already sent is kept in businesses/{biz}/push_state/main (punches:
// push_state/punches, claimed with a precondition so the cron and a ping
// never send the same punch twice).

import { createFirestore, FirestoreError } from './firestore.js';
import { ensureVapid, sendPush } from './webpush.js';
import { todayStr, localHHMM, isLateAt, minsToHM, pad } from './attendance.js';
import { defaultSalaryCfg } from './payroll.js';

export const NOTIF_DEFAULTS = {
  requests: true,
  morning: true, morningAt: '11:20',
  dayEnd: true, dayEndFrom: '20:00', dayEndLatest: '23:30',
  punches: false,
};
const SUBJECT = 'https://attendpro.appcentrik.in';
const FULL_DAY_GRACE_MINS = 15;   // this close to the standard hours still counts as a full day
const MORNING_WINDOW_MINS = 120;  // morning message is skipped if the cron was down longer than this
const PUNCH_FIRST_SEEN_MINS = 30; // a record seen for the first time today: only punches this recent are sent
const PUNCH_GROUP_OVER = 4;       // more new punches than this in one go: one combined message

const P = {
  settings: (b) => `businesses/${b}/settings/main`,
  state: (b) => `businesses/${b}/push_state/main`,
  punchState: (b) => `businesses/${b}/push_state/punches`,
  subs: (b) => `businesses/${b}/push_subs`,
  sub: (b, id) => `businesses/${b}/push_subs/${id}`,
  requests: (b) => `businesses/${b}/requests`,
  staff: (b) => `businesses/${b}/staff`,
  salaries: (b) => `businesses/${b}/salary_config`,
  recs: (b) => `businesses/${b}/attendance`,
  days: (b) => `businesses/${b}/days`,
};

const toMins = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const inr = (n) => '₹' + Math.round(n || 0).toLocaleString('en-IN');

export async function runNotifications(env, now = new Date(), opts = {}) {
  const db = opts.db || createFirestore(env);
  const tz = env.TZ_OFFSET || '+05:30';
  const send = opts.send || sendPush;
  // Key first: the app needs push_config/vapid before any business can turn push on
  const vapid = await ensureVapid(db, env.API_KEY);
  const bizDocs = await db.list('businesses', [['pushEnabled', '==', true]]);
  if (!bizDocs.length) return [];
  const report = [];
  for (const b of bizDocs) {
    try {
      report.push({ biz: b.id, ...(await runBusiness({ db, tz, now, bizId: b.id, biz: b.data, vapid, send })) });
    } catch (e) {
      console.error('notify', b.id, e);
      report.push({ biz: b.id, error: e.message });
    }
  }
  return report;
}

async function runBusiness({ db, tz, now, bizId, biz, vapid, send }) {
  const [settDoc, stateDoc] = await Promise.all([db.get(P.settings(bizId)), db.get(P.state(bizId))]);
  const settings = settDoc ? settDoc.data : {};
  const prefs = { ...NOTIF_DEFAULTS, ...(settings.notif || {}) };
  const state = stateDoc ? stateDoc.data : {};
  const next = {};
  const messages = [];
  const today = todayStr(tz, now);
  const nowMins = toMins(localHHMM(now.toISOString(), tz));

  // Test button in the app
  if (settings.notifTestAt && settings.notifTestAt > (state.testAt || 0)) {
    next.testAt = settings.notifTestAt;
    messages.push({ title: '✅ AttendPro notifications work', body: `${biz.name || 'Your business'}: this phone will get alerts.`, tag: 'test', url: './' });
  }

  // New requests
  if (prefs.requests) {
    if (!state.lastReqAt) {
      next.lastReqAt = now.toISOString(); // first run: start from now, don't replay old requests
    } else {
      // >= plus the ids already sent: timestamps are finer than a JS Date
      const seen = new Set(state.lastReqIds || []);
      const all = await db.list(P.requests(bizId), [['_createdAt', '>=', new Date(state.lastReqAt)]]);
      const rows = all.filter((r) => !seen.has(r.id) && r.data._createdAt);
      if (rows.length) {
        const ms = (r) => Date.parse(r.data._createdAt);
        const latest = all.filter((r) => r.data._createdAt).reduce((a, r) => (ms(r) > Date.parse(a) ? r.data._createdAt : a), state.lastReqAt);
        next.lastReqAt = latest;
        next.lastReqIds = all.filter((r) => r.data._createdAt && ms(r) >= Date.parse(latest) - 1).map((r) => r.id);
        messages.push(...requestMessages(rows.map((r) => ({ id: r.id, ...r.data })).filter((r) => r.status === 'pending')));
      }
    }
  }

  // Morning and day end need today's attendance
  const morningAt = toMins(prefs.morningAt);
  const wantMorning = prefs.morning && state.morningDay !== today && nowMins >= morningAt && nowMins < morningAt + MORNING_WINDOW_MINS;
  const wantDayEnd = prefs.dayEnd && state.dayEndDay !== today && nowMins >= toMins(prefs.dayEndFrom);
  if (wantMorning || wantDayEnd) {
    const day = await loadDay(db, bizId, today);
    if (wantMorning) {
      next.morningDay = today;
      const m = morningMessage(day, { now, tz, at: prefs.morningAt });
      if (m) messages.push(m);
    }
    if (wantDayEnd) {
      const latest = nowMins >= toMins(prefs.dayEndLatest);
      const m = dayEndMessage(day, { now, tz, final: latest });
      if (m) { messages.push(m); next.dayEndDay = today; }
      else if (latest) next.dayEndDay = today; // nobody came (holiday / closed): nothing to send
    }
  }

  if (prefs.punches) messages.push(...await claimPunches(db, bizId, { tz, now }));

  const { sent, removed } = await deliver(db, bizId, messages, vapid, send);
  if (Object.keys(next).length) await db.commit([{ set: P.state(bizId), data: next, merge: true }]);
  return { messages: messages.map((m) => m.title), sent, removed };
}

async function deliver(db, bizId, messages, vapid, send) {
  let sent = 0, removed = 0;
  if (!messages.length) return { sent, removed };
  const subs = await db.list(P.subs(bizId));
  for (const msg of messages) {
    for (const s of subs) {
      if (s.gone) continue;
      try {
        const r = await send(s.data, msg, vapid, { subject: SUBJECT, ttl: msg.ttl || 6 * 3600 });
        if (r.ok) sent++;
        else if (r.gone) { s.gone = true; removed++; await db.commit([{ delete: P.sub(bizId, s.id) }]); }
        else console.warn('push failed', bizId, r.status);
      } catch (e) { console.warn('push error', bizId, e.message); }
    }
  }
  return { sent, removed };
}

// ── Every punch in / out ──

/** Ping from a device that just saved a punch: send that business's new punches now */
export async function runPunchPing(env, bizId, now = new Date(), opts = {}) {
  const db = opts.db || createFirestore(env);
  const settDoc = await db.get(P.settings(bizId));
  const prefs = { ...NOTIF_DEFAULTS, ...((settDoc && settDoc.data.notif) || {}) };
  if (!prefs.punches) return { messages: [], sent: 0 };
  const messages = await claimPunches(db, bizId, { tz: env.TZ_OFFSET || '+05:30', now });
  if (!messages.length) return { messages: [], sent: 0 };
  const vapid = await ensureVapid(db, env.API_KEY);
  const { sent, removed } = await deliver(db, bizId, messages, vapid, opts.send || sendPush);
  return { messages: messages.map((m) => m.title), sent, removed };
}

const CLAIM_LOST = new Set(['FAILED_PRECONDITION', 'ALREADY_EXISTS', 'NOT_FOUND']);

/**
 * Finds today's punches not sent yet and marks them sent before returning
 * them. push_state/punches keeps, per attendance record, how many punch
 * events (ins + outs) were already handled. The write is conditional, so of
 * two runs at the same time only one gets the punches; the other re-reads.
 */
async function claimPunches(db, bizId, { tz, now }) {
  const today = todayStr(tz, now);
  for (let attempt = 0; attempt < 3; attempt++) {
    const [stDoc, recs] = await Promise.all([
      db.get(P.punchState(bizId)),
      db.list(P.recs(bizId), [['date', '==', today]]),
    ]);
    const prev = stDoc && stDoc.data.day === today ? (stDoc.data.seen || {}) : null;
    const seen = {};
    const fresh = [];
    for (const r of recs) {
      const events = punchEvents(r.data);
      seen[r.id] = events.length;
      const had = prev ? prev[r.id] : undefined;
      if (had === undefined) {
        const since = now.getTime() - PUNCH_FIRST_SEEN_MINS * 60000;
        fresh.push(...events.filter((e) => Date.parse(e.iso) >= since).map((e) => ({ ...e, recId: r.id, rec: r.data })));
      } else if (events.length > had) {
        fresh.push(...events.slice(had).map((e) => ({ ...e, recId: r.id, rec: r.data })));
      }
    }
    const same = prev && Object.keys(seen).length === Object.keys(prev).length && Object.keys(seen).every((k) => prev[k] === seen[k]);
    if (same) return [];
    const write = { set: P.punchState(bizId), data: { day: today, seen } };
    if (stDoc) write.ifUpdateTime = stDoc.updateTime; else write.ifMissing = true;
    try {
      await db.commit([write]);
    } catch (e) {
      if (e instanceof FirestoreError && CLAIM_LOST.has(e.code)) continue; // another run got there first
      throw e;
    }
    fresh.sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso));
    return punchMessages(fresh, tz);
  }
  return [];
}

/** A record's punches in order: in, out, in, out… */
function punchEvents(rec) {
  const out = [];
  const sessions = Array.isArray(rec.sessions) ? rec.sessions.filter((x) => x && x.inISO) : [];
  sessions.forEach((x, i) => {
    out.push({ kind: 'in', iso: x.inISO, i, sess: x });
    if (x.outISO) out.push({ kind: 'out', iso: x.outISO, i, sess: x });
  });
  return out;
}

export function punchMessages(events, tz) {
  if (!events.length) return [];
  const name = (e) => e.rec.staffName || 'Staff';
  const line = (e) => `${e.kind === 'in' ? '🟢' : '🔴'} ${name(e)} ${e.kind} ${t12(e.iso, tz)}`;
  if (events.length > PUNCH_GROUP_OVER) {
    return [{ title: `👥 ${events.length} punches`, body: events.map(line).join('\n'), tag: 'punches', url: './?open=today', ttl: 3600 }];
  }
  return events.map((e) => {
    const notes = [];
    if (e.kind === 'in') {
      if (e.i > 0) notes.push(`Back in (session ${e.i + 1})`);
      else if (e.rec.late) notes.push('Late');
    } else {
      const mins = e.sess.workedMins || Math.round((Date.parse(e.sess.outISO) - Date.parse(e.sess.inISO)) / 60000);
      notes.push('Worked ' + minsToHM(mins));
      const sessions = (e.rec.sessions || []).filter((x) => x && x.inISO);
      if (sessions.length > 1 && e.i === sessions.length - 1) {
        const total = sessions.reduce((a, x) => a + (x.outISO ? (x.workedMins || 0) : 0), 0);
        notes.push('today ' + minsToHM(total));
      }
    }
    if (e.sess.source === 'kiosk') notes.push('kiosk');
    if (e.sess.gpsFlag) notes.push('⚠️ away from the store');
    return {
      title: `${line(e)}`,
      body: notes.join(' · ') || (e.kind === 'in' ? 'Punched in' : 'Punched out'),
      tag: `punch-${e.recId}-${e.i}-${e.kind}`, url: './?open=today', ttl: 3600,
    };
  });
}

// ── Today's data ──

async function loadDay(db, bizId, date) {
  const [staff, cfgs, recs, marks] = await Promise.all([
    db.list(P.staff(bizId)),
    db.list(P.salaries(bizId)),
    db.list(P.recs(bizId), [['date', '==', date]]),
    db.list(P.days(bizId), [['date', '==', date]]),
  ]);
  const cfgMap = Object.fromEntries(cfgs.map((d) => [d.id, d.data]));
  const recMap = Object.fromEntries(recs.map((d) => [d.data.staffId, d.data]));
  const holiday = marks.find((d) => !d.data.staffId && d.data.type === 'holiday');
  const leave = Object.fromEntries(marks.filter((d) => d.data.staffId && d.data.type === 'leave').map((d) => [d.data.staffId, d.data]));
  const active = staff.filter((s) => s.data.active !== false && !(s.data.joiningDate && s.data.joiningDate > date))
    .map((s) => ({ id: s.id, ...s.data }));
  return { date, staff: active, cfgMap, recMap, holiday: holiday ? holiday.data : null, leave };
}

// Short names: first name, full name when two staff share it
function namer(staff) {
  const count = {};
  for (const s of staff) { const f = String(s.name || '').split(' ')[0]; count[f] = (count[f] || 0) + 1; }
  return (s) => { const f = String(s.name || '').split(' ')[0]; return count[f] > 1 ? s.name : f; };
}

function t12(iso, tz) {
  const [h, m] = localHHMM(iso, tz).split(':').map(Number);
  return (h % 12 || 12) + ':' + pad(m) + (h >= 12 ? 'pm' : 'am');
}

function dayInfo(day, s, tz) {
  const cfg = { ...defaultSalaryCfg(), ...(day.cfgMap[s.id] || {}) };
  const rec = day.recMap[s.id];
  const sessions = rec && Array.isArray(rec.sessions) ? rec.sessions.filter((x) => x.inISO) : [];
  const open = sessions.find((x) => !x.outISO);
  const first = sessions[0];
  const dow = new Date(day.date + 'T00:00:00Z').getUTCDay();
  const weeklyOff = cfg.weeklyOff >= 0 && cfg.weeklyOff === dow;
  const worked = sessions.reduce((a, x) => a + (x.outISO ? (x.workedMins || Math.round((Date.parse(x.outISO) - Date.parse(x.inISO)) / 60000)) : 0), 0);
  const std = cfg.standardHours || Math.max(1, Math.round((toMins(cfg.endTime) - toMins(cfg.startTime)) / 30) / 2);
  return {
    cfg, sessions, open, first, weeklyOff, worked, stdMins: Math.round(std * 60),
    late: first ? isLateAt(localHHMM(first.inISO, tz), cfg.startTime) : false,
    leave: day.leave[s.id] || null,
  };
}

const fmtDate = (date) => new Date(date + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// ── Messages ──

export function requestMessages(reqs) {
  if (!reqs.length) return [];
  if (reqs.length > 3) {
    const names = [...new Set(reqs.map((r) => r.staffName || 'Staff'))].join(', ');
    return [{ title: `📥 ${reqs.length} new requests`, body: names + ' — open the app to approve or reject.', tag: 'requests', url: './?open=requests' }];
  }
  return reqs.map((r) => {
    const who = r.staffName || 'Staff';
    const reason = r.reason ? `\nReason: ${r.reason}` : '';
    if (r.type === 'leave') {
      const kind = { full: 'Full day', half: 'Half day', custom: r.timeFrom ? `${r.timeFrom}–${r.timeTo}` : 'Some hours' }[r.leaveType] || 'Leave';
      const dates = r.from && r.to && r.from !== r.to ? `${fmtDate(r.from)} → ${fmtDate(r.to)}` : fmtDate(r.from || r.to || '');
      return { title: `📋 Leave request — ${who}`, body: `${dates} · ${kind}${reason}`, tag: 'req-' + r.id, url: './?open=requests' };
    }
    if (r.type === 'advance') {
      return { title: `💰 Advance request — ${who}`, body: `${inr(r.amount)}${reason}`, tag: 'req-' + r.id, url: './?open=requests' };
    }
    return { title: `📥 New request — ${who}`, body: (r.type ? r.type + reason : reason.trim()) || 'Open the app to see it.', tag: 'req-' + r.id, url: './?open=requests' };
  });
}

export function morningMessage(day, { tz, at }) {
  if (day.holiday) return null;
  const nm = namer(day.staff);
  const inStore = [], left = [], notIn = [], off = [];
  for (const s of day.staff) {
    const d = dayInfo(day, s, tz);
    if (d.open) inStore.push(`${nm(s)} ${t12(d.first.inISO, tz)}${d.late ? ' (late)' : ''}`);
    else if (d.sessions.length) left.push(`${nm(s)} (out ${t12(d.sessions[d.sessions.length - 1].outISO, tz)})`);
    else if (d.weeklyOff) off.push(`${nm(s)} (weekly off)`);
    else if (d.leave) off.push(`${nm(s)} (leave)`);
    else notIn.push(nm(s));
  }
  const expected = day.staff.length - off.length;
  if (!expected && !inStore.length) return null;
  const lines = [];
  if (inStore.length) lines.push('✅ In: ' + inStore.join(', '));
  if (notIn.length) lines.push('❌ Not in: ' + notIn.join(', '));
  if (left.length) lines.push('🚶 Came & went out: ' + left.join(', '));
  if (off.length) lines.push('🏖️ Off: ' + off.join(', '));
  const [h, m] = at.split(':').map(Number);
  const atTxt = (h % 12 || 12) + ':' + pad(m) + (h >= 12 ? ' pm' : ' am');
  return {
    title: `🏪 ${atTxt} — ${inStore.length} of ${expected} in the store`,
    body: lines.join('\n'), tag: 'morning-' + day.date, url: './?open=today',
  };
}

/** final = latest time reached: send even if someone is still punched in */
export function dayEndMessage(day, { tz, final }) {
  const nm = namer(day.staff);
  const full = [], short = [], absent = [], stillIn = [], off = [];
  let present = 0;
  for (const s of day.staff) {
    const d = dayInfo(day, s, tz);
    if (d.sessions.length) {
      present++;
      if (d.open) stillIn.push(`${nm(s)} (in since ${t12(d.open.inISO, tz)})`);
      const tag = d.weeklyOff ? ', weekly off' : '';
      if (d.worked >= d.stdMins - FULL_DAY_GRACE_MINS) full.push(`${nm(s)} ${minsToHM(d.worked)}${tag}`);
      else if (!d.open || d.worked > 0) short.push(`${nm(s)} ${minsToHM(d.worked)} of ${minsToHM(d.stdMins)}${tag}`);
    } else if (d.weeklyOff) off.push(`${nm(s)} (weekly off)`);
    else if (d.leave) off.push(`${nm(s)} (leave)`);
    else if (!day.holiday) absent.push(nm(s));
  }
  if (!present) return null;              // nobody came today
  if (stillIn.length && !final) return null; // wait until everyone has punched out
  const lines = [];
  if (full.length) lines.push('✅ Full day: ' + full.join(', '));
  if (short.length) lines.push('⏱️ Short day: ' + short.join(', '));
  if (absent.length) lines.push('❌ Absent: ' + absent.join(', '));
  if (stillIn.length) lines.push('⚠️ No punch-out: ' + stillIn.join(', '));
  if (off.length) lines.push('🏖️ Off: ' + off.join(', '));
  return {
    title: `🌙 Day end ${fmtDate(day.date)} — ${present} came${absent.length ? ', ' + absent.length + ' absent' : ''}`,
    body: lines.join('\n'), tag: 'dayend-' + day.date, url: './?open=today', ttl: 12 * 3600,
  };
}

