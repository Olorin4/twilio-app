# Phase 2c: Contact Timeline and Incoming-Call Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 2b sign-in limiter safe behind the proxy, then give every caller one timeline per workspace, filtered by what the viewer may see, and show the caller's latest entry on the incoming-call screen.

**Architecture:**
- **Login limiter.** `TRUST_PROXY` turns on the real client address. Limits are keyed by client, never by username alone. Without it the limiter is off, and only the existing cap on concurrent password checks applies.
- **Call attribution.** Visibility now credits a softphone call to the line it actually used, taken from its child leg, closing the deferred 2b gap.
- **Timeline.** One read-only module, `src/timeline.js`, merges calls, texts, AI agent calls and Live Assist sessions through the 2b visibility helpers into one keyset-paged list. One route serves both the timeline view and the incoming-call screen pop.

**Tech Stack:** Node 22, Express, PostgreSQL (`pg`), React (Vite), Jest.

**Spec:** `docs/superpowers/specs/2026-11-24-agent-profiles-and-number-handlers-design.md`. This plan covers section **2c**, plus two follow-ups left open by the 2b final review: the limiter, and client-call attribution. Task 1 carries the limiter, and Task 2 the attribution.

## Global Constraints

- **Node 22 for every command.** Prefix with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. The baseline on `master` is 868 passed and 44 skipped.
- **Never touch production.** Never connect to the `DB_URL` in `.env`.
  - Postgres tests use the scratch DB, with `DB_SSL=false` and both `DB_URL` and `TEST_DB_URL` set to `postgresql://postgres:test@localhost:55433/twilio_app_test`.
  - Turn on all `*_PG_TEST` flags, and run with `--runInBand`. The README documents the exact command.
- **Deployment hold.** Nothing is deployed until this phase lands and the owner gives the go-ahead.
- **Visibility.** Every timeline row passes the 2b helpers:
  - `lineCondition(scope, lineExpr, fromExpr, firstParam)` for calls, texts and Live Assist sessions
  - `leadCondition(scope, firstParam)` for AI agent calls
  - `lineScope(user, workspaceId)`, called once per request
- **Hidden rows are absent.** A hidden row is never counted, summarised or hinted at. This phase adds no new tables and no migrations.
- **Phone input.** It must match `^\+[1-9]\d{7,14}$`. Otherwise 400 `{ error: "Enter a phone number with its country code." }`.
- **Paging.**
  - Order is newest first: `at DESC, kind ASC, id DESC`.
  - Default limit 20, maximum 50.
  - The cursor is opaque: base64url of `{ at, kind, id }`.
  - A bad cursor gives 400 `{ error: "Invalid cursor." }`.
- **Entry kinds:** `call`, `text`, `agent_call`, `assist`.
- **Transcripts** are linked, never inlined.
- **The screen pop** never delays ringing or answering. It is fetched after the call is shown, with a 3 s timeout, and failures are silent.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Callers who aren't a phone number.**
   - An anonymous or blocked caller, a `client:` caller, or a number with spaces must never make a 500 or a stray request.
   - The route answers 400. The screen pop doesn't fetch for anything that isn't a valid phone number.
   - Pinned in Tasks 3 and 5.
2. **A member's timeline for a caller who also rang the owner's personal line** shows nothing from that line: no rows, no counts, nothing in another entry's summary.
   - Pinned in Task 3, with the real Postgres data in the pg test.
3. **A call in a workspace that isn't selected** gets its screen pop from that call's workspace, not the selected one. Pinned in Task 5.
4. **A late screen pop** that arrives after the call was rejected, ended or replaced by another call is dropped, never shown on the wrong call. Pinned in Task 5.
5. **Entries of different kinds at the same timestamp** are neither duplicated nor skipped across pages. Pinned in Task 3.

---

### Task 1: Sign-in limiter safe behind the proxy

**Files:**
- Modify: `src/security.js` (`limitKeys` and the limiter wiring), `src/loginLimiter.js` (a limit per key prefix), `src/users.js` (cache-hit expiry), `index.js` (trust proxy), `src/providerContext.js` (startup warning), `README.md`
- Test: `tests/loginThrottle.test.js`, `tests/security.test.js`, `tests/users.test.js`

**Interfaces:**
- `TRUST_PROXY` env:
  - Unset or empty: trust proxy stays off, and the limiter is **off**.
  - A whole number such as `1` is passed to `app.set("trust proxy", Number(value))`.
  - Any other value is passed through as a string, for example `loopback, 172.16.0.0/12`.
- Produces `limitKeys(req, username): string[]`:
  - With trust proxy off: `[]`.
  - With it on: `[`ip:${req.ip}`, `ipuser:${req.ip}|${username.trim().toLowerCase()}`]`.
- `createLoginLimiter({ limits: { ip: 30, ipuser: 10 }, windowMs: 60000, maxKeys: 10000 })` takes each key's limit from its prefix, before the `:`.
- A cache hit in `authenticate` that passes its row re-check moves its expiry to now plus 5 minutes.

- [ ] **Step 1: Write the failing tests.**
  - `the limiter is off without TRUST_PROXY`: 50 bad logins in a row never return 429.
  - `with TRUST_PROXY, one address is limited after 30 bad logins and others are not`.
  - `a stranger cannot lock out a username`: 10 failures for `nick` from address A, then a correct login for `nick` from address B, passes.
  - `the same address and username is limited after 10`.
  - `an active session survives a limit`: a cache hit 4 minutes after the last successful check, then again 4 minutes later, is still a hit with no scrypt run. The query-count assertion proves it.
  - A startup check test: `TRUST_PROXY` unset logs `Sign-in rate limiting is off: set TRUST_PROXY to the number of proxies in front of the app.`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - `index.js` applies `TRUST_PROXY` before any middleware.
  - Remove the bare `user:` key, and update the comment in `security.js` to match.
  - Add the warning to the startup checks next to `checkUsersSchema`.
- [ ] **Step 4: README.**
  - Production sets `TRUST_PROXY=1`, but only after confirming that the edge nginx sets `X-Forwarded-For`, either with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` or with `$remote_addr`.
  - Explain why: with too many proxies trusted, clients can forge their address.
  - Add `TRUST_PROXY` to the settings table.
- [ ] **Step 5: Run the suite, then commit**: `fix: sign-in limits per client behind the proxy`.

---

### Task 2: Credit softphone calls to the line they used

**Files:**
- Modify: `src/visibility.js` (`lineCondition` gains an optional client-line expression), `src/logManager.js` (`getCallLogs` passes it)
- Test: `tests/visibility.test.js`, `tests/historyVisibility.test.js`, `tests/users.pg.test.js`

**Interfaces:**
- `lineCondition(scope, lineExpr, fromExpr, firstParam, clientLineExpr = null): { sql, params }`. It still uses exactly 2 params, so callers' numbering doesn't change.
- When `clientLineExpr` is given, a `client:` row is judged like this:
  - The member's own call (`clientPrefix`) is always visible.
  - Otherwise, if its client line is known, the normal line rule applies to that number: owners `NOT hidden`, members `visible`.
  - Otherwise the current rule applies: `hiddenClients` for owners, nothing for members.
- `getCallLogs` passes the SQL expression it already builds for `local_number` (the child leg's E.164 `from_number`).

- [ ] **Step 1: Write the failing tests:**
  - `owner B sees owner A's softphone call placed from a shared line`, even when A's only assignment on that connection is a personal line hidden from B.
  - `owner B does not see owner A's softphone call placed from A's personal line`.
  - `an Iron Wing member sees the owner's softphone call on the legacy line`.
  - `a member does not see an owner's softphone call from a line hidden from them`.
  - `callers without clientLineExpr behave exactly as before`: SQL and params are unchanged for the other endpoints.
  - A pg test runs the call-history query on real rows covering the four cases.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suite and the pg suites, then commit**: `fix: judge softphone calls by the line they used`.

---

### Task 3: Timeline API

**Files:**
- Create: `src/timeline.js`, `tests/timeline.test.js`
- Modify: `src/contacts.js` (route), `tests/users.pg.test.js` (real-data case)

**Interfaces:**
- Consumes: `lineScope`, `lineCondition` (with `clientLineExpr`, from Task 2), `leadCondition` from `src/receptionist/store.js`.
- Produces:
  - `contactTimeline({ scope, workspaceId, phone, cursor, limit }): Promise<{ contact: { name, company } | null, entries: Entry[], next: string | null }>`
  - `Entry = { kind, id, at, direction: 'inbound'|'outbound'|null, line: string|null, summary: string, link: { view: 'leads'|'call', callSid } | null }`.
- Each kind's source and fields:

| kind | source | matches the caller when | summary |
|---|---|---|---|
| `call` | `call_logs` root rows (no parent) | inbound `from_number = phone`, or outbound `to_number = phone` | `Missed call`, `Answered · <m> min`, `Outgoing call`, or `Outgoing call · <m> min` |
| `text` | `message_logs` | `from_number = phone` or `to_number = phone` | body, collapsed to one line and cut to 140 characters with `…` |
| `agent_call` | `receptionist_calls` | `from_number = phone` or `callback_number = phone` | `<outcome label>: <first line of summary>` |
| `assist` | `phone_call_sessions` | `destination = phone` | first line of summary, else of notes, else `Live Assist call` |

  - Outcome labels: lead → `New lead`, not_a_lead → `Message`, message → `Message`, urgent → `Urgent`, support_request → `Support request`, not_support → `Not support`, spam → `Spam`, abandoned → `Hung up`, failed → `Agent failed`.
  - The `call` summary uses the same missed and answered rules as `getCallLogs`.
  - `line` is the workspace number involved.
  - `link`: `agent_call` → `{ view: 'leads', callSid }`; `assist` → `{ view: 'call', callSid }` when bound; otherwise null.
  - `contact` comes from `phone_contacts` in the workspace.
- Route: `GET /contacts/:phone/timeline?cursor=&limit=`, behind `resolveWorkspace`.

- [ ] **Step 1: Write the failing tests** (`timeline.test.js`, with the DB mocked where needed):
  - `rejects anything that is not a phone number`: `anonymous`, `client:u1_c2`, `+1 555 0100`, `5550100` and `''` give 400 with the exact message, and no query runs.
  - `each kind's summary text`: table-driven over the table above, including the 140-character cut and the outcome labels.
  - `every source query carries the visibility condition`: inspect the SQL and params for a member scope.
  - `limit defaults to 20 and is capped at 50`.
  - `a bad cursor is a 400`.
  - `next is null on the last page`.
  - In `users.pg.test.js`, on real rows (Review Focus 2 and 5):
    - `a member sees nothing of the owner's personal line`: the same caller rang the member's line and the owner's personal line. The member's timeline has only the member-line rows.
    - `entries at the same instant page without gaps or repeats`: three kinds at one timestamp, `limit=1`, three pages, each entry exactly once.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Use one `UNION ALL` query, with each branch filtered by its own condition (renumber parameters per branch), ordered and limited once, fetching `limit + 1` to decide `next`.
- [ ] **Step 4: Run the suite and the pg suites, then commit**: `feat: contact timeline API`.

---

### Task 4: Timeline view

**Files:**
- Create: `frontend/src/Timeline.jsx`
- Modify: `frontend/src/Contacts.jsx`, `frontend/src/ActivityTable.jsx`, `frontend/src/Conversations.jsx`, `frontend/src/Leads.jsx`, `frontend/src/main.jsx` (open, close and link handling), `frontend/src/styles.css`

**Interfaces:**
- Consumes: `GET /contacts/:phone/timeline` (Task 3).
- Produces `<Timeline phone workspaceId onClose onOpenLink />`.
  - It renders the contact name, or the number.
  - Each entry shows a kind icon, a relative time with the exact time as a tooltip, the line, and the summary.
  - A "Load more" button appears while `next` is not null.
  - It has an empty state ("No history with this number yet.") and an error state.

- [ ] **Step 1: Build `Timeline.jsx`.**
  - Fetch with the `X-Workspace-Id` of the workspace that opened it.
  - Entries with a link show "Open". `leads` opens the Leads view with that lead expanded. `call` opens the existing call detail or Live Assist history for that call SID; check `main.jsx` for how those views open today.
- [ ] **Step 2: Add a "History" action in four places.**
  - On each contact row.
  - On each call row: the other party's number.
  - In the conversation thread header.
  - On each lead card: the caller, or the callback number when the caller is anonymous.
  - Each one opens the Timeline for that phone in the current workspace. The action is hidden when the number isn't a valid phone number.
- [ ] **Step 3: Run `npm run build` and `npx eslint frontend/src`.** Expected: no new errors.
- [ ] **Step 4: Commit**: `feat: timeline view from contacts, calls, conversations and leads`.

---

### Task 5: Screen pop on incoming calls

**Files:**
- Modify: `frontend/src/useVoice.js` (incoming call info), `frontend/src/main.jsx` (incoming-call header)
- Create: `frontend/src/screenPop.mjs`, `tests/screenPop.test.js` (pure logic; the repo already tests `.mjs` helpers, see `tests/leadCard.test.js`)

**Interfaces:**
- Produces in `screenPop.mjs`:
  - `shouldFetch(number): boolean`, true only for the phone pattern.
  - `popLine(response): string | null`. It gives `"<name> · Last: <summary> · <relative>"`, or `"Last: <summary> · <relative>"` with no contact. With no entries it gives `"<name>"`, or null with no contact.
  - `isCurrent(token, current): boolean` drops late results.
- `useVoice`'s call state gains `callerContext: string | null`, filled after the call is shown.

- [ ] **Step 1: Write the failing tests** in `screenPop.test.js`:
  - `shouldFetch` is false for `anonymous`, `client:…`, `''` and `+1 555`, and true for `+15550100123`.
  - `popLine` covers all four shapes.
  - `a result for an earlier call is dropped` (Review Focus 4): call A rings, call B replaces it, and A's response arrives; `isCurrent` is false.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - In `watchCall`, for incoming calls only, fetch `/contacts/<number>/timeline?limit=1` with `X-Workspace-Id: target.workspace_id`, the call's own workspace (Review Focus 3).
  - Abort after 3 s. Set `callerContext` only if the same call is still current and not ended.
  - The header shows `callerContext` as a second line under the number when it is present.
  - Ringing, accept and reject never wait on this fetch.
- [ ] **Step 4: Run the suite and `npm run build`, then commit**: `feat: show the caller's latest history when a call rings`.

---

### Task 6: Docs and final verification

**Files:**
- Modify: `README.md`. Do not edit `docs/superpowers/specs/*`, which holds the owner's uncommitted edits.

- [ ] **Step 1: README.**
  - Document the timeline: where it opens, what it shows, and that it follows the same visibility as history.
  - Document the screen pop.
  - Add `TRUST_PROXY` to the deploy checklist: confirm nginx sets `X-Forwarded-For`, then set `TRUST_PROXY=1`.
  - Restate the full deploy order for 2a+2b+2c:
    1. Migration 013.
    2. The 013 seed, with production's `RECEPTIONIST_DAILY_LIMIT`.
    3. Migration 014.
    4. Set `TRUST_PROXY` and confirm `TWILIO_IDENTITY`.
    5. Deploy the code.
    6. The owner cutover.
    7. A test call.
  - Note that production steps need the owner's go-ahead.
- [ ] **Step 2: Run the full verification.**
  - Run `npm test`.
  - Run the README's all-pg-suites command with `--runInBand`.
  - Run `npm run build`.
  - Run `npx eslint src tests frontend/src scripts`.
  - Expected: all pass, and no new lint errors versus base.
- [ ] **Step 3: Commit**: `docs: timeline, screen pop and the full Phase 2 deploy order`.
