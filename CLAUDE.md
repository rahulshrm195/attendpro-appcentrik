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
- `sw.js` — service worker (network-first cache).
- `worker/` — optional Cloudflare Worker API (not deployed yet).

## Pending requests (do in the next update, then remove from here)
- Tab bar runs off the right edge on phones (Payroll/Staff/Settings hidden
  until swiped): two rows, or a fade + arrow hint. Owner to choose. (QR tab
  was moved into Settings in v1.22.4, so it is one tab shorter.)
- Security fix (high priority): Firestore rules are fully open and owner
  passwords / PINs are stored in plain text and readable by anyone. Plan:
  logins via the API, hashed passwords/PINs, then lock the rules.
- Easier AM/PM reading in time lists (e.g. "9:13 pm" vs "9:13 am").
- Optional: advances report per staff per month.
- SR Shoes sent a second email about an issue — owner will forward it.

## Postponed (owner said later — don't start without asking)
- PC-only screens (shared logic, phone layout untouched): 1) Payroll salary
  sheet — all staff in one table, incentive inline, Apply, mark paid per row;
  2) Reports monthly grid staff × days; 3) Fix as a table; 4) Inbox
  list + detail side by side; 5) Today as a live board. Start with 1, then 2.
