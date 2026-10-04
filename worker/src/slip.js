// Salary slips as a printable HTML document (one page per staff member).
// Lines match the app's slip: earnings, late deduction, gross, advance, net.

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(n || 0).toLocaleString('en-IN');
const hm = (m) => `${Math.floor((m || 0) / 60)}h ${(m || 0) % 60}m`;
const MODE = { cash: 'Cash', upi: 'UPI', bank: 'Bank Transfer' };

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function slipHtml(biz, month, s, staff) {
  const a = s.attendance, p = s.pay, r = s.rates;
  const rows = [];
  const add = (label, amount, cls) => rows.push(`<tr><td>${esc(label)}</td><td class="r ${cls}">${amount}</td></tr>`);
  add(`Base Salary (${hm(a.baseWorkedMins)} worked)`, inr(p.basePay), 'g');
  if (p.otPay) add(`Overtime (${hm(a.otMins)} × ${inr(r.otRatePerHour)}/hr)`, '+' + inr(p.otPay), 'g');
  if (p.incentive) add('Sales Incentive', '+' + inr(p.incentive), 'g');
  if (p.weeklyOffBonus) add('Weekly Off Worked', '+' + inr(p.weeklyOffBonus), 'g');
  if (p.weeklyOffPay) add(`Weekly Off Pay (${a.weeklyOffDays} day${a.weeklyOffDays !== 1 ? 's' : ''})`, '+' + inr(p.weeklyOffPay), 'g');
  if (p.holidayPay) add(`Holiday Pay (${a.holidays} day${a.holidays !== 1 ? 's' : ''})`, '+' + inr(p.holidayPay), 'g');
  if (p.paidLeave) add(`Paid Leave (${a.paidLeaveDays} day${a.paidLeaveDays !== 1 ? 's' : ''})`, '+' + inr(p.paidLeave), 'g');
  add(`Late (${a.late} day${a.late !== 1 ? 's' : ''})`, '−' + inr(p.lateDeduction), 're');
  rows.push(`<tr class="tot"><td>Gross Salary</td><td class="r g">${inr(p.gross)}</td></tr>`);
  add('Advance Recovered', '−' + inr(p.advanceRecovered), 're');
  const info = [`Present ${a.present} · Absent ${a.absent} · Late ${a.late}`];
  if (a.shortDays) info.push(`Short hours: ${a.shortDays} day${a.shortDays !== 1 ? 's' : ''} · ${hm(a.shortMins)} less than standard`);
  const pay = s.payment && s.payment.paid
    ? `<div class="meta">Paid: ${esc(MODE[s.payment.mode] || s.payment.mode || '')} · ${esc(s.payment.date)}${s.payment.note ? ' · ' + esc(s.payment.note) : ''}</div>` : '';
  const carry = s.advances.carryForwardAfter > 0
    ? `<div class="carry">Advance carried forward: ${inr(s.advances.carryForwardAfter)}</div>` : '';
  return `<section class="slip">
  <div class="hdr"><div><div class="bname">${esc(biz.name || '')}</div><div class="bsub">${esc(biz.location || '')}</div></div>
    <div class="ttl"><div class="k">Salary Slip</div><div class="m">${esc(monthLabel(month))}</div></div></div>
  <div class="srow"><div><div class="sname">${esc(s.staffName)}</div><div class="ssub">${staff && staff.username ? '@' + esc(staff.username) + ' · ' : ''}${esc(monthLabel(month))}</div></div>
    ${s.payment && s.payment.paid ? '<div class="paid">PAID</div>' : '<div class="unpaid">UNPAID</div>'}</div>
  ${s.salaryConfigured ? '' : '<div class="warn">⚠ Salary is not set up for this staff member in the app.</div>'}
  <table><tr><th>Description</th><th class="r">Amount</th></tr>${rows.join('')}</table>
  <div class="net"><div class="nl">Net Payable</div><div class="nv">${inr(p.net)}</div></div>
  ${carry}${pay}
  <div class="info">${info.map(esc).join('<br>')}</div>
  <div class="foot">AttendPro · generated ${esc(new Date().toLocaleDateString('en-IN'))}</div>
</section>`;
}

export function slipsDocument(biz, month, list, staffMap) {
  const css = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;color:#111;background:#fff}
.slip{max-width:520px;margin:0 auto;padding:32px 28px;page-break-after:always}.slip:last-child{page-break-after:auto}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;padding-bottom:12px;border-bottom:2px solid #f5a623}
.bname{font-size:18px;font-weight:800}.bsub{font-size:11px;color:#777;margin-top:2px}.ttl{text-align:right}
.k{font-size:11px;font-weight:700;color:#f5a623;text-transform:uppercase;letter-spacing:1px}.m{font-size:11px;color:#777;margin-top:3px}
.srow{background:#f8f8f8;border-radius:10px;padding:12px 16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center}
.sname{font-size:15px;font-weight:700}.ssub{font-size:11px;color:#666;margin-top:2px}
.paid,.unpaid{padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700}.paid{border:2px solid #22c55e;color:#22c55e}.unpaid{border:2px solid #aaa;color:#888}
.warn{font-size:12px;color:#b45309;background:#fff7ed;border-radius:8px;padding:8px 10px;margin-bottom:10px}
table{width:100%;border-collapse:collapse;margin-bottom:12px}th{font-size:10px;text-transform:uppercase;color:#999;padding:7px 0;text-align:left;border-bottom:1px solid #eee}
td{padding:8px 0;font-size:13px;border-bottom:1px solid #f5f5f5}.r{text-align:right;font-weight:700}.g{color:#16a34a}.re{color:#dc2626}
tr.tot td{font-weight:700;border-top:2px solid #eee;padding-top:10px}
.net{background:linear-gradient(135deg,#f5a623,#e8522a);border-radius:10px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;margin:12px 0}
.nl{color:rgba(255,255,255,.9);font-size:12px}.nv{color:#fff;font-size:22px;font-weight:800}
.carry{font-size:12px;color:#d97706;font-weight:600;margin-bottom:6px}.meta{font-size:11px;color:#777;margin-bottom:6px}
.info{font-size:11px;color:#888;margin-top:8px;line-height:1.6}.foot{text-align:center;font-size:10px;color:#bbb;margin-top:18px;padding-top:10px;border-top:1px solid #eee}
@media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Salary slips · ${esc(biz.name || '')} · ${esc(monthLabel(month))}</title><style>${css}</style></head><body>
${list.length ? list.map((s) => slipHtml(biz, month, s, staffMap[s.staffId])).join('\n') : '<p style="padding:40px;text-align:center;color:#888">No staff for this month.</p>'}
</body></html>`;
}
