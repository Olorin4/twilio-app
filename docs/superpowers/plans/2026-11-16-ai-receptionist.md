# AI Receptionist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every inbound call to the public Iron Wing number is answered by an AI agent ("Jack Jones") that warms the lead, collects and checks the MC number, promises a human callback, and leaves the owner a lead card with a summary and script.

**Architecture:** The voice webhook decides per call whether to return today's TwiML or `<Connect><ConversationRelay>`. A `ws` server on the existing HTTP server speaks the ConversationRelay protocol and drives a streaming Claude loop with two tools. When the session ends, a second Claude request produces a structured summary, which is stored, emailed, and shown in a new Leads view in the softphone.

**Tech Stack:** Node ≥22.12, Express 4, CommonJS, `pg`, Jest 29, React 19/Vite. New dependencies: `ws`, `@anthropic-ai/sdk`, `zod`, `nodemailer`.

**Spec:** `docs/superpowers/specs/2026-11-16-ai-receptionist-design.md` — read it first. ConversationRelay protocol notes: `research_notes/AI voice lead and dispatch automation/voice_ai_architecture_and_vendors.md` lines 20–50.

## Global Constraints

- With `RECEPTIONIST_ENABLED` unset, every existing test passes unchanged and inbound calls behave exactly as today.
- Any error in the receptionist path during the voice webhook falls back to today's TwiML; a caller never gets an HTTP error because of this feature.
- CommonJS, plain JavaScript, Prettier formatting (`npm run format`), existing Jest style (`jest.mock("../src/db")`, no real database, no real network).
- No code is imported from other repos. No secret values in the repo; new settings go in `.env.example` as names only.
- All new backend files live in `src/receptionist/`; tests in `tests/receptionist/`.
- Iron Wing workspace only (`IRON_WING_WORKSPACE_ID`), English only, transcript only (no audio recording).
- The agent never texts or calls anyone. It introduces itself as "Jack, the AI assistant" and says the call is transcribed, in the greeting.
- Claude calls use the official `@anthropic-ai/sdk`, streaming for the live loop, `tool_choice` left at `auto`, `strict: true` tools, and check `stop_reason` before reading content. Load the `claude-api` skill before writing any SDK call; do not guess SDK names.
- Conversation history stores only `text`, `tool_use` and `tool_result` blocks. `thinking` blocks are kept only inside an in-flight tool round and dropped once the turn completes. (Trimming a turn after an interruption would otherwise invalidate later thinking blocks and return a 400 on current models.)
- The system prompt and tool list are byte-identical for every request in every call; anything that varies per call goes in the first user message.
- Server-side refusal fallback is enabled on Opus and Sonnet models (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`), per current Anthropic guidance; not sent for Haiku.
- Commits: one per task, on a feature branch `feat/ai-receptionist` (create it in Task 1), using whatever attribution line your session specifies for commits.

## Review Focus

Conditions the spec implies but does not spell out, most likely first. Each is pinned by a test in the task named.

1. **Caller ID is blocked or not a phone number.** The agent must still answer, and must ask for a callback number, because the promise is "we'll call you back". (Tasks 3, 6, 8)
2. **Caller hangs up mid-sentence or during the MC lookup.** A card is still saved with whatever was said; no unhandled rejection. (Tasks 8, 10)
3. **Claude is slow, errors, or refuses.** The caller hears the fixed fallback sentence within 6 seconds and gets a callback promise; the card is flagged failed. (Tasks 7, 8)
4. **Caller says nothing.** One "are you still there?" after 12 seconds, then a polite end after another 12; saved as abandoned with no model request. (Task 8)
5. **Email or summary step fails.** The card is still saved and visible; the failure is logged. (Task 10)

## File Structure

| File | Responsibility |
|---|---|
| `src/receptionist/config.js` | Read settings from env; calling-hours check |
| `src/receptionist/store.js` | All SQL for `receptionist_calls` |
| `src/receptionist/routing.js` | Decide agent vs today's behaviour for one call |
| `src/receptionist/tokens.js` | Mint and consume single-use per-call tokens |
| `src/receptionist/twiml.js` | Build ConversationRelay TwiML; `<Connect action>` handler |
| `src/receptionist/carrierLookup.js` | Parse MC/USDOT input; query FMCSA open data |
| `src/receptionist/prompt.js` | System blocks, tools, greeting, call context |
| `src/receptionist/knowledge/iron-wing.md` | The sales knowledge document |
| `src/receptionist/agent.js` | One Claude turn: stream text, run tools |
| `src/receptionist/session.js` | ConversationRelay session state machine |
| `src/receptionist/server.js` | WebSocket upgrade, auth, session wiring |
| `src/receptionist/summary.js` | After-call structured summary |
| `src/receptionist/alertEmail.js` | Lead email |
| `src/receptionist/finalize.js` | Summary → save → publish → email |
| `src/receptionist/routes.js` | Leads API for the softphone |
| `migrations/007_receptionist_calls.sql`, `scripts/migrate-receptionist-calls.js` | Schema |
| `frontend/src/Leads.jsx`, `frontend/src/leadCard.mjs` | Leads view and its pure helpers |
| `scripts/receptionist-sim.js` | Simulated-caller check |
| Modified: `index.js`, `src/router.js`, `src/callResponse.js`, `src/callAnnouncements.js`, `src/activityViews.js`, `frontend/src/main.jsx`, `package.json`, `.env.example`, `README.md` | |

---

### Task 1: Settings and calling hours

**Files:**
- Create: `src/receptionist/config.js`, `tests/receptionist/config.test.js`
- Modify: `src/callResponse.js:49-63` (use config hours), `.env.example`, `package.json` (add `ws`, `@anthropic-ai/sdk`, `zod`, `nodemailer`)

**Interfaces:**
- Produces: `getConfig(env = process.env)` →
  `{ enabled, testMode, testCallers: Set<string>, hours: {start, end, timeZone}, voice, sayVoice, liveModel, liveEffort, liveThinking, liveSpeed, summaryModel, dailyLimit, maxCallSeconds, alertEmail, smtp: {host, port, user, pass, from} }`
- Produces: `isOpen(date, hours)` → boolean (hour in `[start, end)` in `hours.timeZone`)

Env names and defaults: `RECEPTIONIST_ENABLED` (on only when `"true"`), `RECEPTIONIST_TEST_MODE` (**default on**; off only when `"false"`), `RECEPTIONIST_TEST_CALLERS` (comma-separated E.164), `RECEPTIONIST_HOURS_START=7`, `RECEPTIONIST_HOURS_END=18`, `RECEPTIONIST_HOURS_TZ=America/New_York`, `RECEPTIONIST_VOICE=7EzWGsX10sAS4c9m9cPf`, `RECEPTIONIST_SAY_VOICE` (**no default**; `sayVoice` is `null` when unset — suggest `Polly.Joanna-Neural` in the `.env.example` comment, to be confirmed against Twilio's `<Say>` voice list and on a test call before it is set), `RECEPTIONIST_LIVE_MODEL=claude-opus-5-5`, `RECEPTIONIST_LIVE_EFFORT=low`, `RECEPTIONIST_LIVE_THINKING=default` (`default|off`), `RECEPTIONIST_LIVE_SPEED=standard` (`standard|fast`), `RECEPTIONIST_SUMMARY_MODEL=claude-opus-5-5`, `RECEPTIONIST_DAILY_LIMIT=3`, `RECEPTIONIST_MAX_CALL_SECONDS=480`, `RECEPTIONIST_ALERT_EMAIL`, `SMTP_HOST`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `ANTHROPIC_API_KEY` (read by the SDK, listed in `.env.example` only).

- [ ] **Step 1: Create branch and install dependencies**

Run: `git checkout -b feat/ai-receptionist && npm install ws @anthropic-ai/sdk zod nodemailer`
Expected: `package.json` lists the four packages; `npm test` still passes.

- [ ] **Step 2: Write the failing tests**

```js
const { getConfig, isOpen } = require("../../src/receptionist/config");
test("defaults are safe: disabled, test mode on, owner's voice", () => {
  const c = getConfig({});
  expect(c.enabled).toBe(false);
  expect(c.testMode).toBe(true);
  expect(c.voice).toBe("7EzWGsX10sAS4c9m9cPf");
  expect(c.liveModel).toBe("claude-opus-5-5");
  expect(c.hours).toEqual({ start: 7, end: 18, timeZone: "America/New_York" });
  expect(c.dailyLimit).toBe(3);
  expect(c.maxCallSeconds).toBe(480);
});
test("test callers are trimmed into a set", () => {
  const c = getConfig({ RECEPTIONIST_TEST_CALLERS: " +15551230001, +15551230002 " });
  expect([...c.testCallers]).toEqual(["+15551230001", "+15551230002"]);
});
test("invalid numbers fall back to defaults instead of NaN", () => {
  expect(getConfig({ RECEPTIONIST_DAILY_LIMIT: "abc" }).dailyLimit).toBe(3);
});
test("isOpen uses the configured zone and a half-open range", () => {
  const hours = { start: 7, end: 18, timeZone: "America/New_York" };
  expect(isOpen(new Date("2026-11-16T12:00:00Z"), hours)).toBe(true); // 07:00 ET
  expect(isOpen(new Date("2026-11-16T23:00:00Z"), hours)).toBe(false); // 18:00 ET
  expect(isOpen(new Date("2026-11-16T11:59:00Z"), hours)).toBe(false); // 06:59 ET
});
```

- [ ] **Step 3: Run to verify failure** — `npx jest tests/receptionist/config.test.js` → FAIL, module not found.
- [ ] **Step 4: Implement `config.js`**; replace the hardcoded `businessHoursStart`/`businessHoursEnd` block in `src/callResponse.js` with `isOpen(new Date(), getConfig().hours)`. Add every env name above to `.env.example` with a one-line comment each and no values except the non-secret defaults.
- [ ] **Step 5: Run** — `npm test` → all pass, including the existing suites.
- [ ] **Step 6: Commit** — `feat(receptionist): settings and configurable calling hours`

---

### Task 2: Storage

**Files:**
- Create: `migrations/007_receptionist_calls.sql`, `scripts/migrate-receptionist-calls.js` (copy the shape of `scripts/migrate-call-announcements.js`), `src/receptionist/store.js`, `tests/receptionist/store.test.js`
- Modify: `package.json` (script `migrate:receptionist-calls`), `README.md` (one line beside the other migration commands)

```sql
CREATE TABLE IF NOT EXISTS receptionist_calls (
  call_sid text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  provider_connection_id uuid,
  from_number text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  outcome text CHECK (outcome IN ('lead','not_a_lead','spam','abandoned','failed')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','called','dismissed')),
  caller_name text, company text, mc_number text, usdot text,
  mc_verified boolean NOT NULL DEFAULT false,
  callback_number text, callback_promise text,
  carrier jsonb, details jsonb, summary text, script jsonb,
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  handled_at timestamptz
);
CREATE INDEX IF NOT EXISTS receptionist_calls_workspace_idx ON receptionist_calls (workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS receptionist_calls_from_idx ON receptionist_calls (from_number, started_at);
```

**Interfaces (all async, all use `require("../db")`):**
- `startCall({ callSid, workspaceId, connectionId, from })` → void. `INSERT … ON CONFLICT (call_sid) DO NOTHING`.
- `finishCall(callSid, fields)` → the updated row or `null`. `fields`: `{ outcome, callerName, company, mcNumber, usdot, mcVerified, callbackNumber, callbackPromise, carrier, details, summary, script, transcript }`; sets `ended_at = now()`. Only updates a row whose `ended_at IS NULL`, so a second call is a no-op.
- `countAgentCalls(from, hours = 24)` → number of rows from that number started within the window.
- `listCalls(workspaceId, limit = 50)` → rows newest first, where `ended_at IS NOT NULL OR started_at < now() - interval '15 minutes'`, with `COALESCE(outcome,'failed') AS outcome`.
- `setStatus(workspaceId, callSid, status)` → boolean; sets `handled_at = now()` when status is not `new`.
- `countNew(workspaceId)` → number with `status = 'new'` and outcome `lead` or `not_a_lead`.

- [ ] **Step 1: Write the failing tests** (mock `../../src/db` as `{ query: jest.fn() }`)

```js
test("finishCall only closes an open call and serialises json fields", async () => {
  pool.query.mockResolvedValue({ rows: [{ call_sid: sid }], rowCount: 1 });
  await store.finishCall(sid, { outcome: "lead", transcript: [{ role: "caller", text: "hi" }], carrier: { legalName: "X" } });
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/ended_at IS NULL/);
  expect(params).toContain("lead");
  expect(params).toContain(JSON.stringify([{ role: "caller", text: "hi" }]));
});
test("finishCall returns null when the call was already closed", async () => {
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  expect(await store.finishCall(sid, { outcome: "lead" })).toBeNull();
});
test("setStatus rejects unknown statuses without querying", async () => {
  expect(await store.setStatus(ws, sid, "deleted")).toBe(false);
  expect(pool.query).not.toHaveBeenCalled();
});
test("countAgentCalls returns a number", async () => {
  pool.query.mockResolvedValue({ rows: [{ count: "2" }] });
  expect(await store.countAgentCalls("+15551230001")).toBe(2);
});
```

- [ ] **Step 2: Run to verify failure** — `npx jest tests/receptionist/store.test.js` → FAIL.
- [ ] **Step 3: Implement** the migration, script, npm script and `store.js`.
- [ ] **Step 4: Run** — `npx jest tests/receptionist/store.test.js` → PASS.
- [ ] **Step 5: Commit** — `feat(receptionist): receptionist_calls table and store`

---

### Task 3: Routing decision

**Files:** Create `src/receptionist/routing.js`, `tests/receptionist/routing.test.js`

**Interfaces:**
- Consumes: `getConfig`, `store.countAgentCalls`, `require("../db")`, `IRON_WING_WORKSPACE_ID`.
- Produces: `decideRoute({ from, to, provider, config })` → `Promise<{ agent: boolean, reason }>` where `provider` is `undefined` (legacy route) or the object from `getProviderForWebhook`, and `reason` is one of `disabled | outgoing | not_public_number | not_iron_wing | test_caller | test_mode | contact | limit | ok`.

Order (spec §1): disabled → `from` starts with `client:` (`outgoing`) → `to` is not the provider's number / `TWILIO_CALLER_ID` → workspace is not Iron Wing → caller in `config.testCallers` (**agent, skip the rest**) → `config.testMode` → saved contact (`SELECT 1 FROM phone_contacts WHERE workspace_id = $1 AND phone = $2`) → `countAgentCalls(from) >= config.dailyLimit` → `ok`. A `from` that is not E.164 (blocked caller ID) skips the contact query and reaches the limit check keyed on the literal string.

- [ ] **Step 1: Write the failing tests**

```js
const base = { from: "+15551230009", to: "+15550000001", provider: undefined };
const on = (extra = {}) => ({ ...getConfig({ RECEPTIONIST_ENABLED: "true", RECEPTIONIST_TEST_MODE: "false" }), ...extra });
test.each([
  ["disabled", getConfig({}), base, false, "disabled"],
  ["softphone outgoing call", on(), { ...base, from: "client:operator" }, false, "outgoing"],
  ["call to another number", on(), { ...base, to: "+15559999999" }, false, "not_public_number"],
])("%s", async (_n, config, call, agent, reason) => {
  expect(await decideRoute({ ...call, config })).toEqual({ agent, reason });
});
test("a test caller reaches the agent even when saved as a contact and over the limit", async () => {
  const config = on({ testMode: true, testCallers: new Set([base.from]) });
  expect(await decideRoute({ ...base, config })).toEqual({ agent: true, reason: "test_caller" });
  expect(pool.query).not.toHaveBeenCalled();
});
test("test mode keeps everyone else on today's behaviour", async () => {
  expect((await decideRoute({ ...base, config: on({ testMode: true }) })).reason).toBe("test_mode");
});
test("saved contacts skip the agent", async () => {
  pool.query.mockResolvedValueOnce({ rows: [{}] });
  expect(await decideRoute({ ...base, config: on() })).toEqual({ agent: false, reason: "contact" });
});
test("the fourth agent call in a day falls back", async () => {
  pool.query.mockResolvedValueOnce({ rows: [] });
  store.countAgentCalls.mockResolvedValue(3);
  expect((await decideRoute({ ...base, config: on() })).reason).toBe("limit");
});
test("a blocked caller ID still reaches the agent", async () => {
  store.countAgentCalls.mockResolvedValue(0);
  expect(await decideRoute({ ...base, from: "anonymous", config: on() })).toEqual({ agent: true, reason: "ok" });
});
```

(`process.env.TWILIO_CALLER_ID = "+15550000001"` in `beforeAll`; mock `../../src/token` like `tests/callLogNotifications.test.js` does.)

- [ ] **Step 2: Run to verify failure.** — FAIL.
- [ ] **Step 3: Implement `decideRoute`.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(receptionist): per-call routing decision`

---

### Task 4: Voice webhook, TwiML, fallback

**Files:**
- Create: `src/receptionist/tokens.js`, `src/receptionist/twiml.js`, `tests/receptionist/twiml.test.js`, `tests/receptionist/voiceWebhook.test.js`
- Modify: `src/router.js:57-91,162-183` (both voice routes), `src/router.js` (two new action routes), `index.js:15-29` (login bypass), `src/callResponse.js` and `src/callAnnouncements.js` (`<Say>` voice)

**Interfaces:**
- `tokens.mint({ callSid, workspaceId, connectionId, from })` → 43-char base64url string from `crypto.randomBytes(32)`; stored in a `Map` for 60 seconds.
- `tokens.consume(token, callSid)` → the stored context or `null`. Any attempt removes the token, so it is single use even when the attempt fails; `null` if unknown, expired, or `callSid` differs.
- `GREETING` (exported constant): `"Thanks for calling Iron Wing Dispatching. This is Jack, the AI assistant here, and this call is transcribed so our dispatcher can follow up. Are you looking for dispatch for your truck?"`
- `relayTwiml({ token, connectionId, config, baseUrl })` → TwiML string:
  `<Connect action="{baseUrl}{prefix}/receptionist/ended"><ConversationRelay url="{wss baseUrl}{prefix}/receptionist/ws" welcomeGreeting="{GREETING}" welcomeGreetingInterruptible="none" ttsProvider="ElevenLabs" voice="{config.voice}" language="en-US" dtmfDetection="true" interruptible="any"><Parameter name="token" value="{token}"/></ConversationRelay></Connect>` where `prefix` is `""` or `/webhooks/{connectionId}`. Build it with `twilio.twiml.VoiceResponse` (`connect().conversationRelay()`); if the installed helper lacks that method, write the XML with `VoiceResponse`'s generic node API rather than string concatenation.
- `endedHandler(req, res)` — the `<Connect action>` target. `SessionStatus` `ended` or `completed` → `<Response><Hangup/></Response>`. `failed` (or missing) → today's TwiML via `voiceResponse(req.body, provider)`, with `provider` loaded the same way the matching voice route loads it. The handler never writes to the store: the session's own finalize step owns the row, and a write here would race it and lose the transcript. A call whose session never started stays unfinalized and is reported as failed by `listCalls` after 15 minutes.
- Voice routes: after signature validation and before `voiceResponse`, call `decideRoute`. When `agent` is true: `store.startCall`, `tokens.mint`, respond with `relayTwiml`. Wrap this branch in `try/catch`; on any error log it and continue to `voiceResponse` exactly as today.
- New routes: `POST /receptionist/ended` (`validateWebhook`) and `POST /webhooks/:connectionId/receptionist/ended` (`authenticateConnectionWebhook`); add both to the bypass list in `index.js`.
- `<Say>` calls in `callResponse.js:68,88` and `callAnnouncements.js:63` pass `{ voice: sayVoice }` only when `getConfig().sayVoice` is set; when it is unset the generated TwiML is byte-identical to today's.

- [ ] **Step 1: Write the failing tests**

```js
// twiml.test.js
test("relay TwiML carries the token as a Parameter, never in the URL", () => {
  const xml = relayTwiml({ token: "tok123", config: getConfig({}), baseUrl: "https://example.test" });
  expect(xml).toContain('url="wss://example.test/receptionist/ws"');
  expect(xml).toContain('action="https://example.test/receptionist/ended"');
  expect(xml).toContain('<Parameter name="token" value="tok123"/>');
  expect(xml).toContain('voice="7EzWGsX10sAS4c9m9cPf"');
  expect(xml).toContain('welcomeGreetingInterruptible="none"');
  expect(xml).toContain("Jack, the AI assistant");
  expect(xml).toContain("transcribed");
});
test("connection calls use the connection-scoped paths", () => {
  const xml = relayTwiml({ token: "t", connectionId: id, config: getConfig({}), baseUrl: "https://example.test" });
  expect(xml).toContain(`wss://example.test/webhooks/${id}/receptionist/ws`);
});
test("tokens are single use and bound to the call", () => {
  const t = tokens.mint({ callSid: sid, workspaceId: ws, from: "+15551230009" });
  expect(tokens.consume(t, "CA" + "2".repeat(32))).toBeNull();
  expect(tokens.consume(t, sid)).toBeNull(); // burned by the failed attempt
});
test("tokens expire after 60 seconds", () => {
  jest.useFakeTimers();
  const t = tokens.mint({ callSid: sid, workspaceId: ws, from: "x" });
  jest.advanceTimersByTime(61_000);
  expect(tokens.consume(t, sid)).toBeNull();
});
test("a failed session falls back to today's TwiML and leaves the row to finalize", async () => {
  const res = response();
  await endedHandler({ body: { CallSid: sid, SessionStatus: "failed", To: "+15550000001", From: "+15551230009" } }, res);
  expect(res.send.mock.calls[0][0]).toMatch(/<Dial|<Redirect|<Say/);
  expect(store.finishCall).not.toHaveBeenCalled();
});
test("the announcements use the configured voice only when one is set", () => {
  expect(voiceResponse(closedCallBody)).not.toContain("voice=");
  process.env.RECEPTIONIST_SAY_VOICE = "Polly.Joanna-Neural";
  expect(voiceResponse(closedCallBody)).toContain('voice="Polly.Joanna-Neural"');
});
test("a normal end hangs up", async () => {
  const res = response();
  await endedHandler({ body: { CallSid: sid, SessionStatus: "ended" } }, res);
  expect(res.send.mock.calls[0][0]).toContain("<Hangup/>");
});
// voiceWebhook.test.js — drive the router with supertest-free req/res like the existing tests
test("agent route returns ConversationRelay and records the call start", …);   // decideRoute → { agent: true }
test("non-agent route returns exactly today's TwiML", …);                        // compare with voiceResponse(body)
test("a throwing decideRoute still returns today's TwiML with HTTP 200", …);
```

- [ ] **Step 2: Run to verify failure.** — FAIL.
- [ ] **Step 3: Implement** tokens, TwiML, handler, route changes, bypass list, `<Say>` voice.
- [ ] **Step 4: Run** — `npm test` → PASS, with the existing `callAnnouncements` and `security` suites untouched.
- [ ] **Step 5: Commit** — `feat(receptionist): ConversationRelay routing and fallback`

---

### Task 5: Carrier lookup

**Files:** Create `src/receptionist/carrierLookup.js`, `tests/receptionist/carrierLookup.test.js`

**Interfaces:**
- `parseDocket(text)` → `{ kind: "mc" | "usdot" | null, digits: string | null }`. Strips everything but digits and leading zeros; valid length 1–8. `kind` is `usdot` when the text contains "DOT", otherwise `mc`.
- `speakDigits("1234567")` → `"1 2 3 4 5 6 7"`.
- `lookupCarrier({ kind, digits }, { fetchImpl = fetch, timeoutMs = 2500 } = {})` →
  `{ found: true, usdot, mc, legalName, dbaName, city, state, powerUnits, drivers, usdotActive, since }` or `{ found: false, reason: "no_match" | "timeout" | "error" }`. Never throws.
- Source (verified live on 2026-11-16): `GET https://data.transportation.gov/resource/az4n-8mr2.json` with `$limit=2`, `$select=dot_number,legal_name,dba_name,phy_city,phy_state,power_units,total_drivers,status_code,add_date,docket1prefix,docket1,docket2prefix,docket2,docket3prefix,docket3`, and `$where`: for `mc`, `(docket1prefix='MC' AND docket1='N') OR (docket2prefix='MC' AND docket2='N') OR (docket3prefix='MC' AND docket3='N')`; for `usdot`, `dot_number='N'`. Docket numbers are stored without leading zeros. `since` is the year from `add_date` (`YYYYMMDD`). `usdotActive` is `status_code === "A"`. Use `AbortSignal.timeout(timeoutMs)`.

- [ ] **Step 1: Write the failing tests**

```js
test.each([
  ["MC 0123-4567", { kind: "mc", digits: "1234567" }],
  ["m c one", { kind: null, digits: null }],
  ["US DOT 295917", { kind: "usdot", digits: "295917" }],
  ["123456789", { kind: null, digits: null }],
])("parseDocket(%s)", (input, out) => expect(parseDocket(input)).toEqual(out));
test("a match maps the census row", async () => {
  const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => [{ dot_number: "295923", legal_name: "H FRED BAREFOOT TRUCKING INC", phy_city: "ALUM BANK", phy_state: "PA", power_units: "23", total_drivers: "20", status_code: "A", add_date: "19870618", docket1prefix: "MC", docket1: "196057" }] });
  const r = await lookupCarrier({ kind: "mc", digits: "196057" }, { fetchImpl });
  expect(r).toMatchObject({ found: true, usdot: "295923", mc: "196057", legalName: "H FRED BAREFOOT TRUCKING INC", city: "ALUM BANK", state: "PA", powerUnits: 23, usdotActive: true, since: 1987 });
  expect(decodeURIComponent(fetchImpl.mock.calls[0][0])).toContain("docket1='196057'");
});
test("only digits ever reach the query", async () => {
  await lookupCarrier({ kind: "mc", digits: "1' OR '1'='1" }, { fetchImpl });
  expect(fetchImpl).not.toHaveBeenCalled();
});
test("empty result, HTTP error and timeout never throw", async () => {
  expect(await lookupCarrier(q, { fetchImpl: async () => ({ ok: true, json: async () => [] }) })).toEqual({ found: false, reason: "no_match" });
  expect(await lookupCarrier(q, { fetchImpl: async () => ({ ok: false, status: 500 }) })).toEqual({ found: false, reason: "error" });
  expect(await lookupCarrier(q, { fetchImpl: () => new Promise(() => {}), timeoutMs: 20 })).toEqual({ found: false, reason: "timeout" });
});
```

- [ ] **Step 2: Run to verify failure.** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(receptionist): FMCSA carrier lookup`

---

### Task 6: Prompt, tools and knowledge document

**Files:** Create `src/receptionist/prompt.js`, `src/receptionist/knowledge/iron-wing.md`, `tests/receptionist/prompt.test.js`

**Interfaces:**
- `loadKnowledge()` → string (reads the Markdown file once, at module load).
- `buildSystem()` → `[{ type: "text", text: RULES }, { type: "text", text: knowledge, cache_control: { type: "ephemeral", ttl: "1h" } }]`. No dates, times or per-call values.
- `TOOLS` → two tool definitions, each `strict: true`, `additionalProperties: false`, `eager_input_streaming: true`:
  - `lookup_carrier` — input `{ number: string }` (the digits or phrase the caller gave).
  - `end_call` — input `{ outcome: "lead" | "not_a_lead" | "spam", callback_promise: string }`. Description states it must be called in the same turn as the spoken goodbye.
- `callContext({ fromKnown, open, hours, now })` → the first user message text, wrapped in `<call_context>` tags: whether the caller's number is known, whether the office is open now, the calling hours, and today's date and weekday.
- `FALLBACK_LINE`: `"I'm sorry, I'm having trouble on my end. A dispatcher will call you back shortly. Thanks for calling Iron Wing Dispatching."`
- `STILL_THERE_LINE`: `"Are you still there?"`; `SILENT_END_LINE`: `"I'll let you go for now. Call us back any time. Goodbye."`

`RULES` must state, in prose (wording is the implementer's): the persona (Jack Jones, friendly professional American dispatcher, an AI assistant, never claims to be human, answers truthfully if asked); the goal and order (understand what they need → answer from the knowledge document → get the MC number and check it with `lookup_carrier` → promise the callback → say goodbye and call `end_call`); one or two short spoken sentences per turn, one question at a time, no lists or markdown, numbers spoken digit by digit; say "one second while I pull that up" in the same turn as a `lookup_carrier` call; on a match confirm by company name and city, on no match read the digits back one by one; no MC yet is fine, ask for a USDOT number; when the context says the caller's number is unknown, ask for the best callback number; inside calling hours promise "a dispatcher will call you back in the next few minutes from this number", outside them offer the next day and ask for a time window; a caller who asks for a person gets agreement at once, the MC question, the promise, and the end; existing customers, drivers, brokers and vendors get a short message taken and `not_a_lead`; solicitors are ended politely as `spam`; anything not in the knowledge document is answered with "the dispatcher will cover that on the call"; never state prices, terms, earnings or guarantees that are not in the document; never offer legal or insurance advice.

The knowledge document's first draft is written from `../iron-wing-dispatching/src/pages/index.astro`, `sign-up.astro`, `terms.astro` and the blog (read them; copy facts, not markup), under these headings: Who we are · Services · Plans and pricing · How onboarding works · Requirements · Documents needed · Common questions and objections · Never say. Where the website does not state something, write `TODO(owner): …` under the heading instead of inventing it. **The owner must review and approve this file before launch.**

- [ ] **Step 1: Write the failing tests**

```js
test("system blocks are identical across calls and cache the knowledge for an hour", () => {
  expect(JSON.stringify(buildSystem())).toBe(JSON.stringify(buildSystem()));
  const [rules, knowledge] = buildSystem();
  expect(rules.cache_control).toBeUndefined();
  expect(knowledge.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(knowledge.text).toContain("## Plans and pricing");
});
test("rules carry the non-negotiables", () => {
  const text = buildSystem()[0].text;
  for (const phrase of ["Jack Jones", "AI assistant", "lookup_carrier", "end_call", "next few minutes"])
    expect(text).toContain(phrase);
  expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no dates in the cached prefix
});
test("tools are strict and closed", () => {
  for (const tool of TOOLS) {
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.additionalProperties).toBe(false);
  }
  expect(TOOLS.map((t) => t.name)).toEqual(["lookup_carrier", "end_call"]);
});
test("call context tells the agent when the number is unknown and the office is closed", () => {
  const text = callContext({ fromKnown: false, open: false, hours: { start: 7, end: 18, timeZone: "America/New_York" }, now: new Date("2026-11-16T03:00:00Z") });
  expect(text).toMatch(/number is not known/i);
  expect(text).toMatch(/closed/i);
});
```

- [ ] **Step 2: Run to verify failure.** — FAIL.
- [ ] **Step 3: Implement** `prompt.js` and write the knowledge draft.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(receptionist): agent prompt, tools and knowledge draft`

---

### Task 7: One agent turn

**Files:** Create `src/receptionist/agent.js`, `tests/receptionist/agent.test.js`

**Interfaces:**
- Consumes: `buildSystem`, `TOOLS`, `lookupCarrier`, `parseDocket`, `speakDigits`, config.
- `requestParams(config)` → the model-dependent request fields:
  - always `model`, `max_tokens: 4096`, `output_config: { effort: config.liveEffort }`, `system`, `tools`;
  - `thinking`: omitted by default; with `liveThinking === "off"`: `{ type: "between_tools" }` for `claude-sonnet-5-5`, `{ type: "disabled" }` for `claude-haiku-5-5`, omitted for `claude-opus-5-5` (it cannot be turned off);
  - `speed: "fast"` only when `liveSpeed === "fast"` and the model is `claude-opus-5-5`;
  - `betas` + `fallbacks: "default"` (Global Constraints) for Opus and Sonnet models, via `client.beta.messages`; plain `client.messages` for Haiku.
- `createAgent({ client, config, lookup = lookupCarrier })` → `{ prewarm(), runTurn(history, { onText, signal }) }`.
- `prewarm()` → sends one non-streaming request with `max_tokens: 0`, the same params, and `messages: [{ role: "user", content: "warm" }]`; resolves regardless of outcome.
- `runTurn(history, { onText, signal })` → `Promise<{ history, spoken, end, carrier, failed }>`:
  - `history`: the input plus this turn's messages, thinking blocks removed from completed turns;
  - `spoken`: all text sent to `onText` this turn; `onText(delta)` is called for every text delta as it streams;
  - `end`: `null` or `{ outcome, callbackPromise }` when `end_call` was used;
  - `carrier`: the last successful `lookup_carrier` result this turn, or `null`;
  - `failed`: true on an API error, a `refusal` or `max_tokens` stop, more than 4 model requests in one turn, or no first text/tool event within 6 seconds. Never throws; an aborted `signal` resolves with `failed: false` and whatever was spoken.
  - Tool handling: `lookup_carrier` → `parseDocket` then `lookup`, result returned as JSON plus `spoken_number: speakDigits(digits)`; an unparseable number returns `{ found: false, reason: "not_a_number" }`. `end_call` → result `"ok"` and the loop stops after that request without another model call.

- [ ] **Step 1: Write the failing tests** (a fake `client` exposing both `messages.stream` and `beta.messages.stream`, each returning an object with `on("text", cb)`, `finalMessage()` and `abort()`, scripted per request and recording every request in `client.requests`)

```js
test("text deltas are forwarded as they arrive", async () => {
  const client = fakeClient([{ text: ["Sure. ", "What's your MC number?"], stop: "end_turn" }]);
  const seen = [];
  const r = await createAgent({ client, config }).runTurn(history, { onText: (t) => seen.push(t) });
  expect(seen).toEqual(["Sure. ", "What's your MC number?"]);
  expect(r).toMatchObject({ spoken: "Sure. What's your MC number?", end: null, failed: false });
});
test("lookup_carrier runs and the model continues with the result", async () => {
  const lookup = jest.fn().mockResolvedValue({ found: true, legalName: "SMITH TRUCKING", city: "DALLAS", state: "TX" });
  const client = fakeClient([
    { text: ["One second while I pull that up."], tools: [{ id: "t1", name: "lookup_carrier", input: { number: "MC 196057" } }], stop: "tool_use" },
    { text: ["I have Smith Trucking out of Dallas, Texas. Is that you?"], stop: "end_turn" },
  ]);
  const r = await createAgent({ client, config, lookup }).runTurn(history, { onText() {} });
  expect(lookup).toHaveBeenCalledWith({ kind: "mc", digits: "196057" }, expect.anything());
  expect(r.carrier.legalName).toBe("SMITH TRUCKING");
  const toolResult = client.requests[1].messages.at(-1).content[0];
  expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
  expect(toolResult.content).toContain("1 9 6 0 5 7");
});
test("end_call ends the turn without another model request", async () => {
  const client = fakeClient([{ text: ["Thanks, talk soon."], tools: [{ id: "t2", name: "end_call", input: { outcome: "lead", callback_promise: "next few minutes" } }], stop: "tool_use" }]);
  const r = await createAgent({ client, config }).runTurn(history, { onText() {} });
  expect(r.end).toEqual({ outcome: "lead", callbackPromise: "next few minutes" });
  expect(client.requests).toHaveLength(1);
});
test.each(["refusal", "max_tokens"])("%s is reported as failed, not thrown", async (stop) => {
  const r = await createAgent({ client: fakeClient([{ text: [], stop }]), config }).runTurn(history, { onText() {} });
  expect(r.failed).toBe(true);
});
test("an API error is reported as failed", async () => { /* stream.finalMessage rejects */ });
test("no output within 6 seconds is reported as failed", async () => { /* fake timers; stream never emits */ });
test("thinking blocks are not kept in history after the turn", async () => {
  const client = fakeClient([{ thinking: true, text: ["Hi."], stop: "end_turn" }]);
  const r = await createAgent({ client, config }).runTurn(history, { onText() {} });
  expect(JSON.stringify(r.history)).not.toContain('"thinking"');
});
test("system and tools are byte-identical across requests", async () => { /* two turns; compare client.requests[0] and [1] */ });
test.each([
  ["claude-opus-5-5", "off", undefined],
  ["claude-sonnet-5-5", "off", { type: "between_tools" }],
  ["claude-haiku-5-5", "off", { type: "disabled" }],
  ["claude-sonnet-5-5", "default", undefined],
])("thinking for %s/%s", (liveModel, liveThinking, expected) => {
  expect(requestParams({ ...config, liveModel, liveThinking }).thinking).toEqual(expected);
});
```

- [ ] **Step 2: Run to verify failure.** — FAIL.
- [ ] **Step 3: Implement**, following the "Streaming Manual Loop" pattern in the `claude-api` skill's `typescript/claude-api/tool-use.md` (`client.messages.stream` + `stream.on("text")` + `finalMessage()`), passing `signal` in the request options.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(receptionist): streaming agent turn with tools`

---

### Task 8: Call session

**Files:** Create `src/receptionist/session.js`, `tests/receptionist/session.test.js`

**Interfaces:**
- Consumes: `createAgent` result, `GREETING`, `callContext`, `FALLBACK_LINE`, `STILL_THERE_LINE`, `SILENT_END_LINE`, `isOpen`.
- `createSession({ send, close, agent, config, context, onFinished, now = Date.now })` → `{ handle(message), closed() }`.
  - `send(obj)` writes one ConversationRelay message; `close()` closes the socket; `context` is what `tokens.consume` returned (`callSid, workspaceId, connectionId, from`).
  - `handle(message)` takes a parsed Twilio message: `setup`, `prompt`, `dtmf`, `interrupt`, `error`.
  - `closed()` is called when the socket closes for any reason.
  - `onFinished(result)` is called **exactly once** with `{ callSid, outcome, callbackPromise, carrier, transcript, callerSpoke }`.

Behaviour:
- `setup`: start history as `[user: callContext(...)], [assistant: GREETING]`; transcript gets `{ role: "agent", text: GREETING }`; call `agent.prewarm()` without awaiting; start the silence timer and the max-call timer.
- `prompt` with `last: true`: append the caller text to history and transcript, run `agent.runTurn`, forwarding each delta as `{ type: "text", token, last: false }` and finishing with `{ type: "text", token: "", last: true }`. Prompts with `last: false` are ignored. A prompt that arrives while a turn is running aborts that turn first.
- `dtmf`: digits accumulate; `#` or 2 seconds without a digit submits them as a caller turn with the text `"(keyed in) <digits>"`.
- `interrupt`: abort the running turn; replace that turn's assistant text in history and transcript with `utteranceUntilInterrupt`.
- Turn result `end`: after the final token, wait `clamp(spoken.length * 70, 1500, 12000)` ms, then `send({ type: "end", handoffData: JSON.stringify({ outcome }) })`. (Twilio's docs do not say whether `end` cuts off queued speech; this wait is checked on a test call in Task 13.)
- Turn result `failed`: send `FALLBACK_LINE`, wait the same way, end with outcome `failed`.
- Silence: 12 seconds after the agent finishes speaking with no `prompt` → send `STILL_THERE_LINE`; another 12 seconds → send `SILENT_END_LINE` and end with outcome `abandoned`.
- Max call length: at `config.maxCallSeconds`, the next agent turn is replaced by a fixed wrap-up line that promises the callback, and the session ends with outcome `lead` if a carrier or caller speech exists, else `abandoned`.
- `closed()` before an end: abort any running turn; outcome is `abandoned` when the caller never spoke, otherwise `lead` (the summary step decides what the card says). `callerSpoke` reflects whether any caller turn exists.

- [ ] **Step 1: Write the failing tests** (fake timers; a stub `agent` with scripted `runTurn` results; `send` collects messages)

```js
test("setup seeds history with the call context and greeting and pre-warms", …);
test("a caller turn streams tokens and closes the talk cycle", async () => {
  agent.runTurn.mockImplementation(async (h, { onText }) => { onText("Sure. "); onText("Go ahead."); return turn({ spoken: "Sure. Go ahead." }); });
  await s.handle({ type: "prompt", voicePrompt: "I need a dispatcher", last: true });
  expect(sent).toEqual([
    { type: "text", token: "Sure. ", last: false },
    { type: "text", token: "Go ahead.", last: false },
    { type: "text", token: "", last: true },
  ]);
});
test("partial prompts are ignored", …);                       // last: false → runTurn not called
test("keyed digits followed by # become one caller turn", …); // "(keyed in) 196057"
test("an interruption trims the transcript to what was heard", async () => {
  // runTurn spoke "Our plans start at a flat weekly fee"; interrupt says utteranceUntilInterrupt "Our plans start"
  expect(result.transcript.at(-1)).toEqual({ role: "agent", text: "Our plans start" });
});
test("end_call waits for the goodbye, then ends the session once", async () => {
  agent.runTurn.mockResolvedValue(turn({ spoken: "x".repeat(100), end: { outcome: "lead", callbackPromise: "next few minutes" } }));
  await s.handle(prompt("that's all"));
  jest.advanceTimersByTime(6999); expect(sent.some((m) => m.type === "end")).toBe(false);
  jest.advanceTimersByTime(2);    expect(sent.filter((m) => m.type === "end")).toHaveLength(1);
  expect(onFinished).toHaveBeenCalledTimes(1);
  expect(onFinished.mock.calls[0][0]).toMatchObject({ outcome: "lead", callbackPromise: "next few minutes", callerSpoke: true });
});
test("a failed turn says the fallback line and ends as failed", …);
test("silence: one check-in at 12s, polite end at 24s, saved as abandoned with callerSpoke false", …);
test("caller hangs up during a lookup: turn aborted, finished once, no unhandled rejection", async () => {
  agent.runTurn.mockImplementation((h, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(turn({ spoken: "" })))));
  s.handle(prompt("my MC is 196057"));
  s.closed();
  await flush();
  expect(onFinished).toHaveBeenCalledTimes(1);
  expect(onFinished.mock.calls[0][0]).toMatchObject({ outcome: "lead", callerSpoke: true });
});
test("the call is wrapped up at the maximum length", …);       // advance 480s
test("a blocked caller ID is flagged in the call context", …); // context.from "anonymous" → callContext called with fromKnown: false
```

- [ ] **Step 2: Run to verify failure.** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(receptionist): ConversationRelay call session`

---

### Task 9: WebSocket server

**Files:** Create `src/receptionist/server.js`, `tests/receptionist/server.test.js`; modify `index.js:33-36`

**Interfaces:**
- `attach(httpServer, deps = {})` — registers an `upgrade` listener handling only `/receptionist/ws` and `/webhooks/:connectionId/receptionist/ws`; every other upgrade path gets `socket.destroy()`. `deps` allows injecting `createAgent`, `finalize`, `tokens`, `validateSignature` in tests.
- Upgrade check: `validateSignature(req)` → boolean. Implement with `twilio.validateRequest(authToken, req.headers["x-twilio-signature"], wssUrl, {})`, where `wssUrl` is the exact `url` value sent in the TwiML and `authToken` is `TWILIO_AUTH_TOKEN` for the legacy path or the connection's decrypted token for the connection path (extract the lookup in `src/connectionWebhooks.js:16-30` into an exported `loadConnectionAuth(connectionId)` and reuse it there). Before coding, read the signature section of https://www.twilio.com/docs/voice/conversationrelay/onboarding; if it specifies a different URL form, follow it and note the difference in the commit message. A failed check responds `403` and destroys the socket.
- After the upgrade: the first message must be `setup` within 5 seconds and `tokens.consume(setup.customParameters.token, setup.callSid)` must return a context; otherwise close with code 1008. Then create a session per connection and forward messages. The `Anthropic` client is created lazily on the first session and reused; it is never constructed at startup, so a missing API key cannot stop the app from booting. If creating it throws, the session gets an agent whose `runTurn` resolves `{ failed: true }`, so the caller hears the fallback line. Unparseable JSON is ignored. `ws` `close` → `session.closed()`. `onFinished` → `finalize(result, context, { client })` (Task 10), errors logged.
- `index.js`: `require("./src/receptionist/server").attach(server)` after `http.createServer(app)`.

- [ ] **Step 1: Write the failing tests** (real `http.createServer()` on port 0, real `ws` client, injected deps)

```js
test("an unknown upgrade path is refused", …);
test("a bad signature is refused with 403", …);                       // validateSignature → false
test("a connection that never sends setup is closed after 5 seconds", …);
test("setup with an unknown token is closed with 1008", …);
test("setup with a valid token starts a session and forwards messages", async () => {
  // tokens.consume → context; send setup then a prompt; expect the stub session to receive both
});
test("socket close reaches session.closed", …);
test("a missing API key does not crash: the session gets a failing agent", …); // injected client factory throws
```

- [ ] **Step 2: Run to verify failure.** — FAIL.
- [ ] **Step 3: Implement** and wire `index.js`.
- [ ] **Step 4: Run** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `feat(receptionist): authenticated WebSocket endpoint`

---

### Task 10: Summary, lead email, finalize

**Files:** Create `src/receptionist/summary.js`, `src/receptionist/alertEmail.js`, `src/receptionist/finalize.js`, tests for each under `tests/receptionist/`

**Interfaces:**
- `LeadSummary` (zod): `{ outcome: enum(lead, not_a_lead, spam), caller_name: string|null, company: string|null, mc_number: string|null, usdot: string|null, callback_number: string|null, fleet_size: string|null, equipment: string|null, situation: string, questions: string[], unanswered: string[], interest: enum(high, medium, low, unknown), callback_promise: string|null, summary: string, script: { opener: string, points: string[], objections: { objection: string, answer: string }[], next_step: string } }`.
- `summarize({ client, config, transcript, carrier, context })` → `Promise<LeadSummary | null>`. One non-streaming request on `config.summaryModel` with `client.messages.parse` and `zodOutputFormat(LeadSummary)`, `max_tokens: 16000`, the knowledge document in the system prompt (so script answers come from it), and the transcript plus carrier JSON in the user message. Returns `null` on any error, refusal or failed parse.
- `sendLeadEmail(row, config, { transport } = {})` → `Promise<boolean>`. `nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } })`; `from: config.smtp.from`, `to: config.alertEmail`; subject `New lead: {caller or number} — {company or "unknown company"}` (prefix `Message:` for `not_a_lead`); plain-text body with name, company, MC and whether it was verified, callback number and promise, summary, script, and `{TWILIO_WEBHOOK_BASE_URL}/` as the softphone link. Returns `false` without sending when `alertEmail` or `smtp.host` is unset. Never throws.
- `finalize(result, context, { client, config = getConfig(), summarize, sendLeadEmail } = {})` → `Promise<void>` (the last two default to this task's real functions):
  1. `callerSpoke` false → `store.finishCall(callSid, { outcome: "abandoned", transcript })`, publish, stop. No model request.
  2. Otherwise `summarize`. Outcome precedence: session `failed` stays `failed`; else the summary's outcome; else the session's.
  3. `store.finishCall` with the mapped fields: `mcVerified` is true when `carrier.found`; MC/USDOT prefer the carrier record over the summary; `details` is `{ fleetSize, equipment, situation, questions, unanswered, interest }`; `callbackNumber` and `callbackPromise` come from the summary, falling back to the session's promise. When `summarize` returned `null`, still save the transcript, carrier and outcome, with `summary` set to `"Summary unavailable — read the transcript."`.
  4. `publish()` from `src/messageEvents`.
  5. For `lead` and `not_a_lead` only, `sendLeadEmail`. Its failure is logged and does not undo the save.

- [ ] **Step 1: Write the failing tests**

```js
test("an abandoned call is stored without a model request or email", async () => {
  await finalize({ callSid: sid, outcome: "abandoned", callerSpoke: false, transcript: [] }, ctx, deps);
  expect(deps.summarize).not.toHaveBeenCalled();
  expect(deps.sendLeadEmail).not.toHaveBeenCalled();
  expect(store.finishCall).toHaveBeenCalledWith(sid, expect.objectContaining({ outcome: "abandoned" }));
});
test("a lead is saved with verified carrier data, then published and emailed", async () => {
  deps.summarize.mockResolvedValue(summary({ outcome: "lead", mc_number: "196058" }));
  await finalize({ ...result, carrier: { found: true, mc: "196057", usdot: "295923" } }, ctx, deps);
  expect(store.finishCall).toHaveBeenCalledWith(sid, expect.objectContaining({ outcome: "lead", mcNumber: "196057", usdot: "295923", mcVerified: true }));
  expect(publish).toHaveBeenCalled();
  expect(deps.sendLeadEmail).toHaveBeenCalledTimes(1);
});
test("a failed summary still saves the card", async () => {
  deps.summarize.mockResolvedValue(null);
  await finalize(result, ctx, deps);
  expect(store.finishCall).toHaveBeenCalledWith(sid, expect.objectContaining({ summary: expect.stringContaining("Summary unavailable"), transcript: result.transcript }));
});
test("a failed email does not throw or block", async () => {
  deps.sendLeadEmail.mockRejectedValue(new Error("smtp down"));
  await expect(finalize(result, ctx, deps)).resolves.toBeUndefined();
});
test("spam is saved but not emailed", …);
test("a failed session stays failed even if the summary says lead", …);
test("sendLeadEmail returns false and sends nothing when SMTP is not configured", …);
test("the email names the caller, the MC check and the promise", async () => {
  const transport = { sendMail: jest.fn().mockResolvedValue({}) };
  await sendLeadEmail(row, config, { transport });
  const mail = transport.sendMail.mock.calls[0][0];
  expect(mail.subject).toBe("New lead: Mike Alvarez — Alvarez Hauling LLC");
  expect(mail.text).toMatch(/MC 1234567 \(verified\)/);
  expect(mail.text).toContain("next few minutes");
});
```

- [ ] **Step 2: Run to verify failure.** — FAIL.
- [ ] **Step 3: Implement**, using the "Structured Outputs" pattern in the `claude-api` skill's `typescript/claude-api/tool-use.md`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(receptionist): after-call summary, lead email and finalize`

---

### Task 11: Leads API

**Files:** Create `src/receptionist/routes.js`, `tests/receptionist/routes.test.js`; modify `src/router.js` (mount under `resolveWorkspace`, add `"/leads"` to the list at lines 113-127), `src/activityViews.js` (add `leads` to `counts`)

**Interfaces (login required, like every non-webhook route):**
- `GET /leads` → `store.listCalls(workspaceId)` as JSON with camelCase keys: `callSid, from, startedAt, endedAt, outcome, status, callerName, company, mcNumber, usdot, mcVerified, callbackNumber, callbackPromise, carrier, details, summary, script, transcript`.
- `POST /leads/:callSid/status` with JSON `{ status: "called" | "dismissed" | "new" }` → `204`; `400` for a malformed SID or status; `404` when no row changed. Calls `publish()` on success.
- `GET /activity-counts` gains `leads: await store.countNew(workspaceId)`; if that query fails (table missing before the migration runs), `leads` is `0` and the rest of the response is unaffected.

- [ ] **Step 1: Write the failing tests**

```js
test("GET /leads maps rows to camelCase", …);
test("status change validates the SID and the status", async () => {
  expect(await post("not-a-sid", { status: "called" })).toBe(400);
  expect(await post(sid, { status: "archived" })).toBe(400);
});
test("status change returns 404 for another workspace's call", …); // setStatus → false
test("activity counts survive a missing receptionist table", async () => {
  store.countNew.mockRejectedValue(Object.assign(new Error("missing"), { code: "42P01" }));
  // existing calls/messages numbers still returned, leads: 0
});
```

- [ ] **Step 2: Run to verify failure.** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `npm test` → PASS (the existing `activityViews` suite must still pass).
- [ ] **Step 5: Commit** — `feat(receptionist): leads API and unread count`

---

### Task 12: Leads view in the softphone

**Files:** Create `frontend/src/Leads.jsx`, `frontend/src/leadCard.mjs`, `tests/leadCard.test.js`; modify `frontend/src/main.jsx` (nav item, view switch, unread badge, refresh on the event stream, browser notification), `frontend/src/styles.css`

**Interfaces:**
- `leadCard.mjs` (pure, tested like `callDate.mjs`):
  - `leadTitle(lead)` → `"Mike Alvarez · Alvarez Hauling LLC"`, falling back to the callback or caller number, then `"Unknown caller"`.
  - `carrierLine(lead)` → `"MC 1234567 ✓ verified · Dallas, TX · 2 trucks · USDOT since 2025"`; `"MC 1234567 (not verified)"` when unverified; `"No authority yet"` when there is no MC or USDOT.
  - `badge(lead)` → `"NEW LEAD" | "MESSAGE" | "AGENT FAILED" | "ABANDONED" | "SPAM"` from `outcome`.
  - `callbackTarget(lead)` → `callbackNumber` if it is E.164, else `from` if it is E.164, else `null`.
- `Leads({ leads, onCall, onStatus, timeZone })` — cards as sketched in spec §6, newest first: badge and promise on the top line, title, carrier line, summary, script (opener, points, objections, next step, and "Couldn't answer on the call" from `details.unanswered`), a collapsible transcript, and buttons **Call back** (disabled when `callbackTarget` is null), **Mark done** (`called`), **Not a lead** (`dismissed`).
- `main.jsx`: a "Leads" nav item beside Calls/Messages with the `unviewed.leads` badge; `view === "leads"` renders `<Leads>`; leads are fetched from `/leads` on entering the view and on every `messages` event from the existing `EventSource`; **Call back** dials through the same function the dial pad's call button uses, with `callbackTarget(lead)`; when `unviewed.leads` increases and `Notification.permission === "granted"`, show `new Notification("New lead", { body: leadTitle(newest) })`; request permission once from a user click on the Leads nav item.

- [ ] **Step 1: Write the failing tests** (`tests/leadCard.test.js`)

```js
test.each([
  [{ callerName: "Mike Alvarez", company: "Alvarez Hauling LLC" }, "Mike Alvarez · Alvarez Hauling LLC"],
  [{ callbackNumber: "+15551230009" }, "+15551230009"],
  [{ from: "anonymous" }, "Unknown caller"],
])("leadTitle", (lead, out) => expect(leadTitle(lead)).toBe(out));
test("carrier line shows the check result", () => {
  expect(carrierLine({ mcNumber: "1234567", mcVerified: true, carrier: { city: "DALLAS", state: "TX", powerUnits: 2, since: 2025 } }))
    .toBe("MC 1234567 ✓ verified · Dallas, TX · 2 trucks · USDOT since 2025");
  expect(carrierLine({ mcNumber: "1234567", mcVerified: false })).toBe("MC 1234567 (not verified)");
  expect(carrierLine({})).toBe("No authority yet");
});
test("a blocked caller with no callback number cannot be dialled", () => {
  expect(callbackTarget({ from: "anonymous" })).toBeNull();
  expect(callbackTarget({ from: "anonymous", callbackNumber: "+15551230009" })).toBe("+15551230009");
});
```

- [ ] **Step 2: Run to verify failure.** — FAIL.
- [ ] **Step 3: Implement** helpers, component, `main.jsx` wiring and styles (reuse existing classes and spacing; no new design language).
- [ ] **Step 4: Run** — `npm test` → PASS; `npm run build` → builds without errors; `npm run lint` → clean.
- [ ] **Step 5: Verify in the browser** — start the backend and `npm run dev`, insert one row by hand into a development database, and confirm the card renders, the badge counts, **Mark done** clears it, and **Call back** starts an outgoing call to the right number.
- [ ] **Step 6: Commit** — `feat(receptionist): leads view in the softphone`

---

### Task 13: Simulated callers and rollout notes

**Files:** Create `scripts/receptionist-sim.js`; modify `README.md` (new "AI receptionist" section), `package.json` (script `receptionist:sim`)

**Interfaces:**
- `node scripts/receptionist-sim.js [scenario]` — drives `createAgent` in text only (no Twilio) with a second Claude request playing the caller from a scenario brief, for at most 12 turns, and prints the transcript, the `end_call` result, and PASS/FAIL per check. It calls the real API and costs money: it prints the model and an estimate, and exits unless run with `--yes`.
- Scenarios and checks: `new-owner-operator` (MC asked for, `lookup_carrier` called, callback promised, `end_call` outcome `lead`); `no-mc-yet` (accepted, asks for USDOT, still `lead`); `existing-customer` (`not_a_lead`, no sales pitch); `broker` (`not_a_lead`); `price-pusher` (no price outside the knowledge document is stated); `are-you-a-robot` (says it is an AI); `wants-a-human` (agrees within one turn, ends within three); `solicitor` (`spam`).
- README section: what the feature does, every env name from Task 1, the migration command, and the rollout checklist below.

Rollout checklist (goes in the README; the first three are launch gates from spec §10):
1. Run `npm run migrate:receptionist-calls` against the production database.
2. Confirm the reverse proxy passes WebSocket upgrades for `/receptionist/ws` (a `wscat` connection must reach the app and be refused with 403, not fail at the proxy).
3. Set `RECEPTIONIST_ENABLED=true` with `RECEPTIONIST_TEST_MODE` left on and the owner's number in `RECEPTIONIST_TEST_CALLERS`. Call in and check: Twilio accepts voice `7EzWGsX10sAS4c9m9cPf`; `RECEPTIONIST_SAY_VOICE`, once set, plays on the fallback announcements; the goodbye is not cut off (if it is, raise the 70 ms/character wait in `session.js`); a spoken MC number and a keyed-in one both work; hanging up early still produces a card; the lead email arrives.
4. Break it on purpose (unset `ANTHROPIC_API_KEY`), call in, and confirm the fallback sentence plays and a failed card appears; then point the WebSocket URL at nothing and confirm the call falls back to ringing the softphone.
5. Compare `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` (with `RECEPTIONIST_LIVE_THINKING=off` for the last two, and `RECEPTIONIST_LIVE_SPEED=fast` as an Opus option) on test calls; the owner chooses.
6. Owner approves `src/receptionist/knowledge/iron-wing.md` with no `TODO(owner)` lines left.
7. Set `RECEPTIONIST_TEST_MODE=false`. Read every transcript for the first two weeks.

- [ ] **Step 1: Implement the script and README section.**
- [ ] **Step 2: Verify the guard** — `node scripts/receptionist-sim.js` (no `--yes`) → prints the estimate and exits with code 1, having made no request.
- [ ] **Step 3: Full check** — `npm test && npm run lint && npm run build` → all pass.
- [ ] **Step 4: Commit** — `feat(receptionist): simulated callers and rollout checklist`
- [ ] **Step 5: Stop and report.** Running the simulation with `--yes`, the database migration, and anything in the rollout checklist need the owner's go-ahead; do not run them as part of this plan.
