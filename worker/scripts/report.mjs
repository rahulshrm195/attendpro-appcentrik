#!/usr/bin/env node
// Month-end report: attendance problems to fix + everyone's salary.
//
//   export API_URL=https://attendpro-api.<you>.workers.dev
//   export API_KEY=<your key>
//   node scripts/report.mjs <companyCode | bizId> <YYYY-MM> [--csv salary.csv]
//
// Read-only: it never changes data. Each problem comes with the command that fixes it.
// Sessions are numbered from 1 here; the API's {index} in the fix commands starts at 0.

import { writeFileSync } from 'node:fs';

const [who, month, ...rest] = process.argv.slice(2);
const csvPath = rest[0] === '--csv' ? rest[1] : null;
const { API_URL, API_KEY } = process.env;

if (!who || !/^\d{4}-\d{2}$/.test(month || '') || !API_URL || !API_KEY) {
  console.error('Usage: API_URL=... API_KEY=... node scripts/report.mjs <companyCode|bizId> <YYYY-MM> [--csv file.csv]');
  process.exit(1);
}

async function api(path) {
  const res = await fetch(API_URL.replace(/\/+$/, '') + path, { headers: { Authorization: 'Bearer ' + API_KEY } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${body.error ? body.error.message : ''}`);
  return body;
}

const rupees = (n) => '₹' + Number(n).toLocaleString('en-IN');
const hm = (m) => `${Math.floor(m / 60)}h ${m % 60}m`;
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const { businesses } = await api('/biz/list');
const biz = businesses.find((b) => b.id === who) ||
  businesses.find((b) => String(b.companyCode || '').toUpperCase() === who.toUpperCase());
if (!biz) {
  console.error(`No business "${who}". Known: ` + businesses.map((b) => `${b.name} (${b.companyCode || b.id})`).join(', '));
  process.exit(1);
}

const [att, pay] = await Promise.all([
  api(`/biz/${biz.id}/attendance/${month}?flagged=1`),
  api(`/biz/${biz.id}/payroll/${month}`),
]);

console.log(`\n${biz.name} — ${month}`);
console.log('='.repeat(60));

// ── Problems ──
console.log(`\nATTENDANCE PROBLEMS: ${att.summary.flagged} of ${att.summary.records} records\n`);
if (!att.records.length) console.log('  None 🎉');
const base = `"$API_URL/biz/${biz.id}/attendance`;
for (const r of att.records) {
  console.log(`● ${r.staffName} — ${r.date}`);
  r.sessions.forEach((s) => {
    console.log(`    Session ${s.index + 1}: ${s.inTime || '—'} → ${s.outTime || '(no punch-out)'}` +
      (s.workedMins != null && s.outTime ? `  (${hm(s.workedMins)})` : ''));
  });
  for (const f of r.flags) {
    console.log(`    ⚠ ${f.message}`);
    const url = `${base}/${r.date}/${r.staffId}`;
    if (f.code === 'duplicate_session' || f.code === 'tiny_session') {
      console.log(`      fix (remove Session ${f.session + 1}):`);
      console.log(`      curl -X DELETE -H "Authorization: Bearer $API_KEY" ${url}/session/${f.session}"`);
    } else if (f.session != null && f.code !== 'long_session') {
      console.log(`      fix (set Session ${f.session + 1}'s real times, 24-hour HH:MM):`);
      console.log(`      curl -X PATCH -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" ` +
        `-d '{"session":${f.session},"in":"HH:MM","out":"HH:MM"}' ${url}"`);
    }
  }
  console.log('');
}

// ── Salary ──
console.log(`SALARY (${pay.staff.length} staff) — app defaults: no incentive, recovers this month's advances\n`);
const head = pad('Name', 18) + padL('Pres', 5) + padL('Abs', 5) + padL('Late', 5) + padL('Leave', 6) +
  padL('OT', 9) + padL('Gross', 11) + padL('Advance', 10) + padL('Net', 11);
console.log(head);
console.log('-'.repeat(head.length));
for (const s of pay.staff) {
  const a = s.attendance, p = s.pay;
  console.log(pad(s.staffName.slice(0, 17), 18) + padL(a.present, 5) + padL(a.absent, 5) + padL(a.late, 5) +
    padL(a.paidLeaveDays, 6) + padL(hm(a.otMins), 9) + padL(rupees(p.gross), 11) +
    padL(p.advanceRecovered ? '−' + rupees(p.advanceRecovered) : '—', 10) + padL(rupees(p.net), 11) +
    (s.salaryConfigured ? '' : '   ⚠ salary not set') +
    (s.advances.carryForwardAfter > 0 ? `   (${rupees(s.advances.carryForwardAfter)} advance carries forward)` : ''));
}
console.log('-'.repeat(head.length));
console.log(pad('TOTAL', 18) + ' '.repeat(30) + padL(rupees(pay.total.gross), 11) +
  padL('−' + rupees(pay.total.advanceRecovered), 10) + padL(rupees(pay.total.net), 11));
console.log('\nFor one person with incentive / a different advance amount:');
console.log(`  curl -H "Authorization: Bearer $API_KEY" "$API_URL/biz/${biz.id}/payroll/${month}/<staffId>?incentive=500&advanceRecover=1000"`);
console.log('Staff IDs: ' + pay.staff.map((s) => `${s.staffName}=${s.staffId}`).join(', ') + '\n');

if (csvPath) {
  const cols = ['Name', 'Staff ID', 'Present', 'Absent', 'Late', 'Paid leave', 'Short days', 'OT mins',
    'Base', 'OT pay', 'Weekly off bonus', 'Weekly off pay', 'Paid leave pay', 'Late deduction',
    'Gross', 'Advance recovered', 'Net', 'Advance carried forward', 'Salary configured'];
  const rows = pay.staff.map((s) => [s.staffName, s.staffId, s.attendance.present, s.attendance.absent,
    s.attendance.late, s.attendance.paidLeaveDays, s.attendance.shortDays, s.attendance.otMins,
    s.pay.basePay, s.pay.otPay, s.pay.weeklyOffBonus, s.pay.weeklyOffPay, s.pay.paidLeave, s.pay.lateDeduction,
    s.pay.gross, s.pay.advanceRecovered, s.pay.net, s.advances.carryForwardAfter, s.salaryConfigured ? 'yes' : 'NO']);
  const esc = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  writeFileSync(csvPath, [cols, ...rows].map((r) => r.map(esc).join(',')).join('\n') + '\n');
  console.log(`Salary sheet saved to ${csvPath} (opens in Excel / Google Sheets)\n`);
}
