# Month-end agent guide

How an AI agent (ChatGPT, Claude or any tool that can make web requests) runs
AttendPro's month end: fix clear punching mistakes, list what needs a person,
calculate everyone's salary and send the owner the slips.

## What the agent needs

- **Base URL** — your Worker, e.g. `https://attendpro-api.<you>.workers.dev`
- **API key** — sent on every request as `Authorization: Bearer <API_KEY>`
- **Business ID** — from `GET /biz/list` (match by name or `companyCode`)

Treat the key like a password: it can read and change all attendance and
salary data. Store it in the agent's secrets, never in a chat message.

## The month-end call

```
POST /biz/{bizId}/monthend/{YYYY-MM}
Content-Type: application/json

{"apply": true}
```

It does, in order:

1. **Auto-fix** — removes clear double taps only (same rules as the app's
   ⚡ Auto-fix): a same-minute duplicate is removed when exactly one of the
   duplicates has a punch-out, or when none has one at the end of the day.
   Every removed session is logged on the record (`removedDuplicates`).
2. **Needs review** — every day that still needs a person: missing punch-out,
   overlapping sessions, two different punch-outs, very short day, first
   punch-in 3+ hours late. The agent must **not** guess times for these.
3. **Payroll** — for every staff member, using the app's pay rules.

Use `{"apply": false}` first if you want a preview that changes nothing.

### Response (shortened)

```json
{
  "business": "SR Shoes", "month": "2026-09", "applied": true,
  "autofix": { "summary": { "daysFixed": 10, "sessionsRemoved": 21, "failed": 0, "needsReview": 3 } },
  "needsReview": [
    { "staffName": "Kashish Sharma", "date": "2026-09-26",
      "flags": [{ "code": "short_day", "message": "Only 0h 22m worked (standard 11h 0m) — missed punch-in or punch-out?" }] }
  ],
  "payroll": {
    "total": { "gross": 61200, "net": 52400, "advanceRecovered": 8800 },
    "notConfigured": [],
    "staff": [
      { "staffName": "Mukesh Varma", "present": 26, "absent": 1, "late": 4,
        "gross": 15700, "advanceRecovered": 2000, "net": 13700, "advanceCarryForward": 3000,
        "slipUrl": "https://…/biz/B1/payroll/2026-09/M1/slip" }
    ]
  },
  "allSlipsUrl": "https://…/biz/B1/payroll/2026-09/slips"
}
```

Slip URLs return an HTML page (also needs the `Authorization` header). The
agent can attach it, or print it to PDF.

## Rules for the agent

- Run month end on the **1st–3rd** for the previous month.
- Only the month-end / auto-fix calls change data. Never call PATCH or DELETE
  to "fix" a needs-review day unless the owner tells you the exact time.
- Advance recovery uses the app's default (this month's advances, else the
  outstanding balance). The owner decides final amounts in the app and marks
  salaries paid there.
- If `notConfigured` is not empty, tell the owner those staff have no salary
  set up.

## Ready-to-use instruction

Paste this into your agent (fill in the three values; keep the key in the
agent's secret settings if it has them):

> You run month-end payroll for my shop using the AttendPro API.
> Base URL: `<BASE_URL>`. Business ID: `<BIZ_ID>`. Authenticate every request
> with the header `Authorization: Bearer <API_KEY>`.
>
> On the 2nd of every month, for the previous month (YYYY-MM):
> 1. `POST <BASE_URL>/biz/<BIZ_ID>/monthend/<YYYY-MM>` with body `{"apply": true}`.
> 2. Download `allSlipsUrl` (with the same header) and save it as a PDF.
> 3. Email me one message with: the totals (gross, advance recovered, net);
>    a table of each staff member's present, absent, late, net and advance
>    carried forward; how many double taps were fixed; and the full
>    "needsReview" list in plain words (name, date, problem) so I can correct
>    those in the app. Attach the slips PDF.
> 4. If any request fails, email me the error instead. Never change
>    attendance or salary data in any other way.
