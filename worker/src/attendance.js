// Attendance helpers — mirror the formats the app writes (index.html).
// Times in records are 12-hour strings ("9:05 AM") plus ISO timestamps.

/** "+05:30" → minutes east of UTC */
export function tzMinutes(tz) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz || '+05:30');
  if (!m) throw new Error('Invalid TZ_OFFSET: ' + tz);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Calendar parts of `date` in the business time zone */
export function localParts(date, tz) {
  const d = new Date(date.getTime() + tzMinutes(tz) * 60000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** ISO timestamp → "HH:MM" in business tz */
export function localHHMM(iso, tz) {
  const d = new Date(new Date(iso).getTime() + tzMinutes(tz) * 60000);
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

export const pad = (n) => (n < 10 ? '0' + n : '' + n);

export function todayStr(tz, now = new Date()) {
  const p = localParts(now, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** "YYYY-MM-DD" + "HH:MM" in business tz → ISO string (UTC) */
export function toISO(date, hhmm, tz) {
  return new Date(`${date}T${hhmm}:00${tz}`).toISOString();
}

/** "14:05" → "2:05 PM" (same as the app's fmt12) */
export function fmt12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h >= 12 ? 'PM' : 'AM');
}

export function minsToHM(m) {
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

export function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

export function isValidHHMM(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** Same rule as isLate() in the app: after HH:MM of the expected start time */
export function isLateAt(hhmm, startTime) {
  const [h, m] = hhmm.split(':').map(Number);
  const [sh, sm] = (startTime || '10:00').split(':').map(Number);
  return h > sh || (h === sh && m > sm);
}

/** Build session time fields from HH:MM inputs. out may be null/'' (still in). */
export function sessionTimes(date, inHHMM, outHHMM, tz) {
  const inISO = toISO(date, inHHMM, tz);
  const s = {
    inTime: fmt12(inHHMM), inISO,
    outTime: '', outISO: '', workedMins: 0, workedDisplay: '',
  };
  if (outHHMM) {
    s.outISO = toISO(date, outHHMM, tz);
    s.outTime = fmt12(outHHMM);
    s.workedMins = Math.round((new Date(s.outISO) - new Date(inISO)) / 60000);
    s.workedDisplay = minsToHM(s.workedMins);
  }
  return s;
}

/** Root-level fields derived from sessions (as the app's edit/delete code does) */
export function rollup(sessions) {
  const total = sessions.reduce((a, s) => a + (s.workedMins || 0), 0);
  const last = sessions[sessions.length - 1];
  return {
    sessions,
    inTime: sessions[0].inTime,
    outTime: last.outTime || '',
    workedMins: total,
    workedDisplay: minsToHM(total),
  };
}

// ── Anomaly detection ──
// Each flag: {code, severity, session?, message}
const DUP_WINDOW_MS = 2 * 60 * 1000;   // two punch-ins this close = double tap
const TINY_SESSION_MINS = 2;            // in → out this fast = accidental
const LONG_SESSION_MINS = 14 * 60;

export function detectAnomalies(rec, today) {
  const flags = [];
  const sessions = Array.isArray(rec.sessions) ? rec.sessions : [];
  const t = (iso) => (iso ? new Date(iso).getTime() : NaN);

  sessions.forEach((s, i) => {
    const inT = t(s.inISO), outT = t(s.outISO);
    if (!s.outTime && i < sessions.length - 1) {
      flags.push({ code: 'open_session_not_last', severity: 'high', session: i,
        message: `Session ${i + 1} has no punch-out but a later session exists` });
    }
    if (!s.outTime && i === sessions.length - 1 && rec.date < today) {
      flags.push({ code: 'missing_punch_out', severity: 'high', session: i,
        message: `Session ${i + 1} was never punched out` });
    }
    if (s.outTime && !isNaN(inT) && !isNaN(outT)) {
      const mins = (outT - inT) / 60000;
      if (mins < 0) {
        flags.push({ code: 'out_before_in', severity: 'high', session: i,
          message: `Session ${i + 1} punch-out is before punch-in` });
      } else if (mins < TINY_SESSION_MINS) {
        flags.push({ code: 'tiny_session', severity: 'medium', session: i,
          message: `Session ${i + 1} lasted under ${TINY_SESSION_MINS} min (likely a double tap)` });
      } else if (mins > LONG_SESSION_MINS) {
        flags.push({ code: 'long_session', severity: 'medium', session: i,
          message: `Session ${i + 1} lasted ${minsToHM(Math.round(mins))}` });
      }
    }
    if (i > 0) {
      const prev = sessions[i - 1];
      const prevIn = t(prev.inISO), prevOut = t(prev.outISO);
      if (!isNaN(inT) && !isNaN(prevIn) && Math.abs(inT - prevIn) < DUP_WINDOW_MS) {
        flags.push({ code: 'duplicate_session', severity: 'high', session: i,
          message: `Session ${i + 1} starts within 2 min of session ${i}` });
      } else if (!isNaN(inT) && !isNaN(prevOut) && inT < prevOut) {
        flags.push({ code: 'overlapping_sessions', severity: 'high', session: i,
          message: `Session ${i + 1} starts before session ${i} ends` });
      }
    }
  });

  if (sessions.length) {
    const sum = sessions.reduce((a, s) => a + (s.workedMins || 0), 0);
    if ((rec.workedMins || 0) !== sum && sessions.every((s) => s.outTime)) {
      flags.push({ code: 'total_mismatch', severity: 'low',
        message: `Day total ${rec.workedMins || 0} min ≠ sum of sessions ${sum} min` });
    }
  }
  return flags;
}

/** Record without selfies (large base64 images) for API responses */
export function publicRecord(id, rec) {
  const sessions = (rec.sessions || []).map((s, i) => {
    const o = { index: i };
    for (const k of ['inTime', 'inISO', 'outTime', 'outISO', 'workedMins', 'workedDisplay',
      'inDist', 'outDist', 'gpsFlag', 'source', 'manual']) if (s[k] !== undefined) o[k] = s[k];
    o.hasInSelfie = !!s.inSelfie;
    o.hasOutSelfie = !!s.outSelfie;
    return o;
  });
  const out = { id };
  for (const k of ['staffId', 'staffName', 'date', 'inTime', 'outTime', 'workedMins', 'workedDisplay',
    'late', 'gpsFlag', 'manual', 'manualEdit']) if (rec[k] !== undefined) out[k] = rec[k];
  out.sessions = sessions;
  return out;
}
