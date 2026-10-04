# AttendPro — notes for Claude

## Workflow
- The owner wants changes live without manual steps: after committing and
  pushing to the working branch, open the pull request and merge it into
  `main` yourself. Do not ask the owner to click Merge.
- `main` is published to attendpro.appcentrik.in by GitHub Pages.
- Bump the version for every app release: the two version badges and the
  "What's New" entry in `index.html`, and `CACHE_NAME` in `sw.js`.

## Layout
- `index.html` — the whole app (owner panel, staff app, kiosk, super admin).
- `sw.js` — service worker (network-first cache).
- `worker/` — optional Cloudflare Worker API (not deployed yet).
