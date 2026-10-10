# AttendPro API (Cloudflare Worker)

A small HTTP API over the AttendPro Firestore data, for admin scripts, data
clean-up and (later) AI anomaly checks. It runs on Cloudflare Workers and
talks to Firestore with a Google service account.

> **The API key is a master key.** It can read and change every business's
> attendance, staff and advances. Keep it on servers and scripts only — never
> put it in `index.html`, a staff phone, or a chat message.

## One-time setup (no terminal needed)

You need a Firebase service account key and a free Cloudflare account. Menu
names on these sites change from time to time; if something is named slightly
differently, look for the closest match.

1. **Firebase key** — Firebase console → ⚙️ Project settings → **Service
   accounts** → **Generate new private key**. A `.json` file downloads. Keep it
   private (it gives full access to the database).
2. **API key for the agent** — make a random password of at least 32
   characters (any password manager can generate one). Save it; this is what
   your agent will use.
3. **Cloudflare** — sign in at dash.cloudflare.com → **Workers & Pages** →
   **Create** → **Import a repository** → connect GitHub and pick
   `attendpro-appcentrik`. On the "Set up your application" screen:
   - **Project name**: `attendpro-api` (must match `name` in `wrangler.toml`)
   - Leave **Build command** empty; keep **Deploy command** `npx wrangler deploy`
   - Open **Advanced settings** at the bottom and set **Path** (the root
     directory) to `worker`
   - **Enable Preview builds** can be switched off (not needed)

   Then click **Deploy**.
4. **Secrets** — open the new Worker → **Settings → Variables and Secrets** →
   **+ Add variable** (top right), twice. Set **Type** to **Secret** both
   times (plain "Text" variables are wiped by the next deploy from GitHub):
   - `API_KEY` = the password from step 2
   - `FIREBASE_SERVICE_ACCOUNT` = open the `.json` file in a text editor,
     select all and paste the whole thing, from the first `{` to the last `}`

   Saving each secret deploys the Worker by itself. Leave
   `FIREBASE_PROJECT_ID` and `TZ_OFFSET` as they are (they come from
   `wrangler.toml`).
5. **Check** — the Worker's address is shown on its **Overview** under
   **Domains and routes → workers.dev**:
   `https://attendpro-api.<your-account>.workers.dev`. Open
   `…workers.dev/health` in a browser; it should say `{"ok": true}`. (If
   workers.dev shows **Disabled**, push any change to `main` so the Worker
   redeploys with `workers_dev = true`, or turn it on under **Settings →
   Domains & Routes**.)

To change the key later, edit the `API_KEY` secret and redeploy. Every future
push to `main` redeploys the Worker automatically.

<details><summary>Same setup from a terminal</summary>

```bash
cd worker && npm install && npx wrangler login
npx wrangler secret put API_KEY
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT < service-account.json
npx wrangler deploy
```
</details>

`TZ_OFFSET` in `wrangler.toml` (default `+05:30`) is the business time zone.

For automating month end with an AI agent, see **[AGENT.md](AGENT.md)**.

## Owner notifications (push)

Once the Worker is deployed, it checks every 5 minutes (cron in
`wrangler.toml`) and sends push notifications to the owner's phones and
computers:

- **New leave / advance requests**, within about 5 minutes.
- **Who is in the store** at a set time (default 11:20): in, not in yet,
  came and went out, off (weekly off / leave).
- **Day-end summary** once everyone who came has punched out (not before
  20:00 by default): full day, short day, absent. At the latest time
  (default 23:30) it is sent anyway, listing anyone with no punch-out.

Nothing extra to set up: the Worker makes its own push (VAPID) key on the
first run and keeps it in Firestore at `push_config/vapid`, the private part
encrypted with a key derived from `API_KEY`. (Changing `API_KEY` makes a new
push key; each owner device re-registers by itself the next time the owner
panel is opened.)

In the app: **Settings → Notifications → Turn on for this device**, then
**Send test** (arrives within 5 minutes). Times and which alerts to send are
set there too. Android: Chrome. iPhone: Add to Home Screen first, then turn
it on from the home-screen app. Only owner devices get alerts.

Data: devices in `businesses/{biz}/push_subs`, what was already sent in
`businesses/{biz}/push_state/main`, settings in `settings/main.notif`. The
cron only looks at businesses with `pushEnabled: true` (set by the app when
a device is turned on). `POST /notify/run` runs one check now (API key).

## Salary day: reconcile a month

```bash
cd worker
export API_URL=https://attendpro-api.<you>.workers.dev
export API_KEY=<your key>

node scripts/report.mjs SRS 2026-09 --csv salary-2026-09.csv
```

Use the company code (or business ID) and the month. The script only reads
data. It prints:

1. **Attendance problems:** each flagged day, its sessions and a ready-to-run
   `curl` command to fix it. For a double tap, the command deletes the extra
   session; for a wrong or missing time, fill in the real `HH:MM` before
   running it.
2. **Salary table:** for every staff member, with the totals. Staff whose
   salary isn't set up in the app are marked `⚠ salary not set`.

Fix the problems, run the report again until it shows none, then pay from the
salary table (or the CSV). For an incentive or a different advance amount for
one person, use the single-staff payroll call shown at the end of the report.

## Endpoints

Every request except `/health` needs `Authorization: Bearer <API_KEY>`.
Errors come back as `{"error": {"code", "message"}}`. Responses never include
passwords, PINs or selfie images.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/health` | Liveness check (no key needed) |
| GET | `/biz/list` | All businesses (super admin) |
| GET | `/biz/{bizId}/staff` | List staff |
| POST | `/biz/{bizId}/staff` | Add staff |
| GET | `/biz/{bizId}/attendance/{YYYY-MM}` | Month's attendance with anomaly flags |
| GET | `/biz/{bizId}/attendance/{YYYY-MM-DD}/{staffId}` | One day's record |
| PATCH | `/biz/{bizId}/attendance/{YYYY-MM-DD}/{staffId}` | Edit or add a session |
| DELETE | `/biz/{bizId}/attendance/{YYYY-MM-DD}/{staffId}/session/{index}` | Remove a session |
| POST | `/biz/{bizId}/attendance/{YYYY-MM}/autofix` | Remove clear double taps (`{"dryRun":true}` to preview) |
| GET | `/biz/{bizId}/payroll/{YYYY-MM}` | Payroll for all staff |
| GET | `/biz/{bizId}/payroll/{YYYY-MM}/{staffId}` | Payroll for one person |
| GET | `/biz/{bizId}/payroll/{YYYY-MM}/{staffId}/slip` | Salary slip (HTML page) |
| GET | `/biz/{bizId}/payroll/{YYYY-MM}/slips` | All salary slips in one printable page |
| POST | `/biz/{bizId}/monthend/{YYYY-MM}` | Month end in one call: auto-fix + needs-review list + payroll + slip links |
| POST | `/biz/{bizId}/advance` | Give an advance |

### Add staff
```json
POST /biz/B1/staff
{ "name": "Neha", "username": "neha", "pin": "4321", "joiningDate": "2026-10-01" }
```
`pin` is a 4-digit string. `joiningDate` defaults to today. Duplicate usernames → `409`.

### Attendance for a month
`GET /biz/B1/attendance/2026-09` — optional `?flagged=1` (only records with
problems) and `?staffId=S1`.

Each record has `flags`:

| code | meaning |
| --- | --- |
| `duplicate_session` | Two punch-ins within 2 minutes (double tap) |
| `tiny_session` | In → out in under 2 minutes |
| `overlapping_sessions` | A session starts before the previous one ends |
| `open_session_not_last` | A session without punch-out, followed by another session |
| `missing_punch_out` | Last session of a past day never punched out |
| `out_before_in` | Punch-out earlier than punch-in |
| `long_session` | A session longer than 14 hours |
| `total_mismatch` | Day total ≠ sum of sessions |

### Edit or add a session
```json
PATCH /biz/B1/attendance/2026-09-12/S1
{ "session": 0, "in": "10:00", "out": "18:30" }
```
- `session`: the session `index` from the GET response, or `"new"` to add one
  (also creates the day's record if there is none).
- `in` / `out`: 24-hour `HH:MM` in the business time zone. `out` may be `null`
  (still in).
- Selfies, GPS and other session fields are kept. Sessions are kept in time
  order, and totals and `late` are recalculated.
- A change that would create an overlap, a duplicate or an open session in the
  middle is refused with `422`.
- If someone punches at the same moment, you get `409` — just retry.

### Remove a session
`DELETE /biz/B1/attendance/2026-09-12/S1/session/1`

Totals are recalculated. The API refuses to delete the only session of a day
(`409`); fix it with PATCH instead.

### Payroll
`GET /biz/B1/payroll/2026-09/S1?incentive=500&advanceRecover=2000`

Same rules as the Payroll tab in the app. `advanceRecover` defaults to what the
app pre-fills (this month's advances, or the full outstanding balance).
Read-only: it does not record a payment.

### Give an advance
```json
POST /biz/B1/advance
{ "staffId": "S1", "amount": 500, "date": "2026-09-15", "note": "festival" }
```
The advance, the ledger balance and the ledger log entry are saved together
(all or nothing).

## Development

```bash
npm test     # starts the Firestore emulator and runs test/api.test.mjs (needs Java)
npm run dev  # local Worker; put API_KEY, FIRESTORE_EMULATOR_HOST etc. in .dev.vars
```

The payroll logic in `src/payroll.js` is a port of the app's Payroll tab
(`index.html`). If the pay rules change in the app, change them here too —
the payroll test pins the expected numbers.
