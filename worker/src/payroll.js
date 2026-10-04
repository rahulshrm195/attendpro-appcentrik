// Payroll — a faithful port of the owner app's payroll calculation
// (index.html, "Payroll calculations"). Keep the two in sync: if the rules
// change in the app, change them here too.

import { pad } from './attendance.js';

export function defaultSalaryCfg() {
  return { base: 0, weeklyOff: -1, startTime: '10:00', endTime: '21:00', standardHours: 0, minHours: 1,
    otRateMode: 'none', otRate: 0, lateRule: 'fixed', lateAmount: 50, lateHalfAfter: 3, showWoPay: false };
}

function calcAutoStdHoursFromCfg(cfg) {
  const s = (cfg.startTime || '10:00').split(':').map(Number);
  const e = (cfg.endTime || '21:00').split(':').map(Number);
  const mins = (e[0] * 60 + e[1]) - (s[0] * 60 + s[1]);
  return Math.max(1, Math.round(mins / 60 * 2) / 2);
}

function parseTime12(t) {
  if (!t) return [0, 0];
  const p2 = t.match(/(\d+):(\d+)\s*(AM|PM)/i); if (!p2) return [0, 0];
  let h = parseInt(p2[1]), m = parseInt(p2[2]);
  if (p2[3].toUpperCase() === 'PM' && h !== 12) h += 12;
  if (p2[3].toUpperCase() === 'AM' && h === 12) h = 0;
  return [h, m];
}

/**
 * @param {object} a
 * @param {object} a.cfg        salary_config doc (or default)
 * @param {object} a.staff      staff doc ({joiningDate})
 * @param {string} a.sid
 * @param {number} a.year       e.g. 2026
 * @param {number} a.month      1-12
 * @param {{y,m,d}} a.today     today's date in the business time zone
 * @param {object} a.recs       {"<sid>_<date>": attendance record}
 * @param {object} a.marks      {"<date>" | "<date>_<sid>": day mark}
 * @param {number} a.ledgerBalance  advance ledger balance
 * @param {Array}  a.advances   this staff's advance docs
 * @param {number} a.incentive
 * @param {number|null} a.advanceRecover  null = app default (this month's advances, else all outstanding)
 */
export function computePayroll(a) {
  const cfg = Object.assign(defaultSalaryCfg(), a.cfg || {});
  const { sid, year, month, today, recs, marks } = a;
  const joiningDate = (a.staff && a.staff.joiningDate) || null;
  const prefix = year + '-' + pad(month);
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const isCur = year === today.y && month === today.m;
  const isFuture = year > today.y || (year === today.y && month > today.m);
  const upto = isFuture ? 0 : isCur ? today.d : dim;

  const stdHours = cfg.standardHours || calcAutoStdHoursFromCfg(cfg);
  const stdMins = Math.round(stdHours * 60);
  const minMins = Math.round((cfg.minHours || 1) * 60);
  let otRatePerHour = 0;
  if (cfg.otRateMode === 'auto') otRatePerHour = stdMins > 0 ? Math.round(cfg.base / 30 / stdHours) : 0;
  else otRatePerHour = cfg.otRate || 0;

  let workDays = 0, present = 0, absent = 0, late = 0, offDays = 0;
  let totalWorkedMins = 0, shortMins = 0, shortDays = 0, otMins = 0;
  let weeklyOffWorkedMins = 0, weeklyOffWorked = 0, weeklyOffPaidDays = 0, paidLeaveDays = 0;

  for (let i = 1; i <= upto; i++) {
    const ds = prefix + '-' + pad(i);
    if (joiningDate && ds < joiningDate) continue;
    const dow = new Date(Date.UTC(year, month - 1, i)).getUTCDay();
    const mark = marks[ds] || marks[ds + '_' + sid];
    const rec = recs[sid + '_' + ds];
    // eslint-disable-next-line eqeqeq
    if (cfg.weeklyOff >= 0 && dow == cfg.weeklyOff) {
      offDays++;
      weeklyOffPaidDays++;
      if (rec && rec.inTime) {
        weeklyOffWorked++;
        let wMins = rec.workedMins || 0;
        if (!wMins && rec.outTime) {
          const [wo, wom] = parseTime12(rec.outTime); const [wi, wim] = parseTime12(rec.inTime);
          wMins = Math.max(0, (wo * 60 + wom) - (wi * 60 + wim));
        }
        weeklyOffWorkedMins += wMins;
      }
      continue;
    }
    if (mark && (mark.type === 'holiday' || mark.type === 'leave')) {
      // Half-day / custom-hours leave on a day they also worked: hours still count
      const partLeave = mark.type === 'leave' && (mark.leaveType === 'half' || mark.leaveType === 'custom');
      if (!(partLeave && rec && rec.inTime)) {
        offDays++;
        if (mark.type === 'leave' && mark.paidLeave) paidLeaveDays++;
        continue;
      }
      if (mark.paidLeave && mark.leaveType === 'half') paidLeaveDays += 0.5;
    }
    workDays++;
    if (rec && rec.inTime) {
      let dayMins = rec.workedMins || 0;
      if (!dayMins) {
        if (rec.sessions && rec.sessions.length) {
          dayMins = rec.sessions.reduce((s, ss) => s + (ss.workedMins || 0), 0);
        } else if (rec.outTime) {
          const [oh, om] = parseTime12(rec.outTime); const [ih, im] = parseTime12(rec.inTime);
          dayMins = Math.max(0, (oh * 60 + om) - (ih * 60 + im));
        }
      }
      if (dayMins < minMins) {
        absent++;
      } else {
        present++;
        if (rec.late) late++;
        totalWorkedMins += Math.min(dayMins, stdMins);
        if (dayMins < stdMins) { shortDays++; shortMins += (stdMins - dayMins); }
        if (dayMins > stdMins) otMins += (dayMins - stdMins);
      }
    } else {
      absent++;
    }
  }

  const perDay = Math.round(cfg.base / 30);
  let eligibleDays = upto;
  if (joiningDate && joiningDate.startsWith(prefix)) {
    const joinDay = parseInt(joiningDate.split('-')[2]) || 1;
    eligibleDays = upto - joinDay + 1;
  }
  let basePay = stdMins > 0 ? Math.round((totalWorkedMins / stdMins) * perDay) : 0;
  const maxPay = eligibleDays < upto ? perDay * eligibleDays : cfg.base;
  basePay = Math.min(basePay, maxPay);

  const otPay = Math.round((otMins / 60) * otRatePerHour);
  const weeklyOffBonus = stdMins > 0 ? Math.round((weeklyOffWorkedMins / stdMins) * perDay) : 0;
  const woPay = cfg.showWoPay ? weeklyOffPaidDays * perDay : 0;
  let lateD = 0;
  if (cfg.lateRule === 'fixed') lateD = late * (cfg.lateAmount || 0);
  else if (cfg.lateRule === 'halfday') lateD = Math.floor(late / (cfg.lateHalfAfter || 3)) * Math.round(perDay / 2);
  const incentive = a.incentive || 0;

  const totalOutstanding = a.ledgerBalance > 0 ? a.ledgerBalance : 0;
  const thisMonthAdvs = (a.advances || []).filter((x) => x.date && x.date.startsWith(prefix));
  const thisMonthTotal = thisMonthAdvs.reduce((s, x) => s + (x.amount || 0), 0);
  const carryForwardIn = Math.max(0, totalOutstanding - thisMonthTotal);
  const defaultRecover = totalOutstanding > 0 ? (thisMonthTotal > 0 ? thisMonthTotal : totalOutstanding) : 0;
  const advRecover = Math.min(a.advanceRecover != null ? a.advanceRecover : defaultRecover, totalOutstanding);

  const paidLeaveAmt = Math.round(paidLeaveDays * perDay);
  const gross = Math.max(0, basePay + otPay + incentive + weeklyOffBonus + woPay + paidLeaveAmt - lateD);
  const advActual = Math.min(advRecover, gross);
  const net = Math.max(0, gross - advActual);

  return {
    month: prefix,
    daysCounted: upto,
    attendance: { workDays, present, absent, late, offDays, weeklyOffDays: weeklyOffPaidDays,
      weeklyOffWorked, paidLeaveDays, shortDays, shortMins, otMins, baseWorkedMins: totalWorkedMins },
    rates: { base: cfg.base, perDay, standardHours: stdHours, otRatePerHour },
    pay: { basePay, otPay, incentive, weeklyOffBonus, weeklyOffPay: woPay, paidLeave: paidLeaveAmt,
      lateDeduction: lateD, gross, advanceRecovered: advActual, net },
    advances: { outstanding: totalOutstanding, thisMonth: thisMonthTotal, carriedIn: carryForwardIn,
      carryForwardAfter: totalOutstanding - advActual },
  };
}
