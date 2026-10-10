# AttendPro — notes for Claude

## Workflow
- The owner wants changes live without manual steps: after committing and
  pushing to the working branch, open the pull request and merge it into
  `main` yourself. Do not ask the owner to click Merge.
- `main` is published to attendpro.appcentrik.in by GitHub Pages.
- Bump the version for every app release: `APP_VERSION`, the two version
  badges and the "What's New" entry in `index.html`, and `CACHE_NAME` in `sw.js`.

## Layout
- `index.html` — the whole app (owner panel, staff app, kiosk, super admin).
  - Owner panel has two layouts: the classic panel (phones, and "Use classic
    view") and the computer layout `#desk` (1100px+, code under "COMPUTER
    LAYOUT"). Both use the same functions: salary = `computePayroll()`,
    payment = `recordPayment()`, edits/approvals = the classic functions.
    Never add payroll math to the desk; change `computePayroll()` instead.
  - Classic render functions call `deskPing()` so the desk refreshes.
- `sw.js` — service worker (network-first cache).
- `worker/` — Cloudflare Worker API (not deployed yet — owner does the
  one-time setup in worker/README.md). Its cron (every 5 min) sends the
  owner's push notifications: `worker/src/notify.js` (requests, morning
  "who's in", day-end summary), `worker/src/webpush.js` (VAPID + encryption).
  App side: Settings → Notifications (`renderOwnerPush`, `enableOwnerPush`).
  Tests: `cd worker && npm test` (Firestore emulator).

## Pending requests (do in the next update, then remove from here)
- Tab bar runs off the right edge on phones (Payroll/Staff/Settings hidden
  until swiped): two rows, or a fade + arrow hint. Owner to choose. (QR tab
  was moved into Settings in v1.22.4, so it is one tab shorter.)
- Security fix (high priority): Firestore rules are fully open and owner
  passwords / PINs are stored in plain text and readable by anyone. Staff
  bank details (`staff_bank`, owner-only in the app) and emails are exposed too. Plan:
  logins via the API, hashed passwords/PINs, then lock the rules.
- Easier AM/PM reading in time lists (e.g. "9:13 pm" vs "9:13 am").
- Optional: advances report per staff per month.
- SR Shoes sent a second email about an issue — owner will forward it.
