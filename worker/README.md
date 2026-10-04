# AttendPro API (Cloudflare Worker)

A small HTTP API over the AttendPro Firestore data, for admin scripts, data
clean-up and (later) AI anomaly checks. It runs on Cloudflare Workers and
talks to Firestore with a Google service account.

> **The API key is a master key.** It can read and change every business's
> attendance, staff and advances. Keep it on servers and scripts only — never
> put it in `index.html`, a staff phone, or a chat message.

## One-time setup

1. **Firebase service account key**
   Firebase console → Project settings → Service accounts → *Generate new
   private key*. A JSON file downloads. Keep it private; don't commit it.

2. **Cloudflare**
   ```bash
   cd worker
   npm install
   npx wrangler login
   ```

3. **Secrets**
   ```bash
   # 1) A strong random API key (save it in your password manager)
   openssl rand -hex 32
   npx wrangler secret put API_KEY                    # paste the key

   # 2) The service account JSON from step 1
   npx wrangler secret put FIREBASE_SERVICE_ACCOUNT < path/to/service-account.json
   ```

4. **Deploy**
   ```bash
   npx wrangler deploy
   ```
   Wrangler prints the URL, e.g. `https://attendpro-api.<you>.workers.dev`.

5. **Check it**
   ```bash
   curl https://attendpro-api.<you>.workers.dev/health
   curl -H "Authorization: Bearer $API_KEY" https://attendpro-api.<you>.workers.dev/biz/list
   ```

To rotate the key: run `wrangler secret put API_KEY` again with a new value.

`TZ_OFFSET` in `wrangler.toml` (default `+05:30`) is the business time zone used
for "today", late checks and times you send to the API.

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
| GET | `/biz/{bizId}/payroll/{YYYY-MM}/{staffId}` | Payroll calculation |
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
