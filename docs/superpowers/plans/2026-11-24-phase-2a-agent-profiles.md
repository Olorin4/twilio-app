# Phase 2a: Agent Profiles and Number Handlers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each phone number choose who answers (the softphone or a named AI agent), and make AI agents editable per-workspace data instead of Iron Wing code, with Jack's behaviour unchanged.

**Architecture:** A new `agent_profiles` table holds each agent's persona, greeting, instructions, knowledge and limits, with a full-copy revision table. A small `kinds` module maps each agent kind to its tools, outcomes and emails. The prompt becomes a fixed safety preamble plus the profile's text. `connection_numbers` gains a handler, a profile, a label and an hours switch. The inbound path resolves the dialed number's profile once, inside the existing 2 second deadline, and carries its id through the relay token into the session, summary and email. Any failure still falls back to today's softphone TwiML.

**Tech Stack:** Node 22, Express, PostgreSQL (`pg`), Twilio ConversationRelay, `@anthropic-ai/sdk` with zod output formats, React (Vite), Jest.

**Spec:** `docs/superpowers/specs/2026-11-24-agent-profiles-and-number-handlers-design.md` (sections *Intent* to *Settings UI*, plus the 2a items in *Decided by me*). Sections 2b and 2c are out of scope here.

## Global Constraints

- Run every test and script with Node 22 (`.nvmrc`): prefix commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. Under Node 26 the `twilio` package fails to load and 11 suites fail for reasons unrelated to this work.
- Never run a test, migration or seed against the `DB_URL` in `.env`: it is the shared production `iwd_database`. Postgres tests use the scratch database from Task 1, and are gated so they only run when the database name ends in `_test`.
- Migrations are additive and rerunnable (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, guarded constraint swaps). `iwd-backend` (`/home/olorin4/web-dev/iwd-backend`) does not reference `connection_numbers` or `receptionist_calls` (checked with grep on 2026-11-24).
- Kinds: `receptionist | dispatcher | support`. Outcomes: receptionist `lead | not_a_lead | spam`; dispatcher `message | urgent | spam`; support `support_request | not_support | spam`. Stored outcomes also include `abandoned | failed`.
- Emailed outcomes: `lead`, `not_a_lead`, `message`, `urgent`, `support_request`. `spam` and `not_support` send nothing. An `urgent` email subject starts with `URGENT`.
- Profile field caps: greeting 500, instructions 20,000, knowledge 60,000 characters; name, persona name and company name 1–120; voice up to 64; `daily_limit` 1–1000, default `RECEPTIONIST_DAILY_LIMIT` (3) for receptionists and 20 for other kinds.
- Number handler: `softphone | ai_agent`. `ai_agent` requires a profile from the same workspace as the number's connection. `label` is up to 60 characters. `observe_hours` defaults to true and only has an effect on Iron Wing numbers.
- The "saved contact goes to the softphone" gate applies to `receptionist` profiles only. `RECEPTIONIST_ENABLED`, test mode and test callers apply to every profile. The workspace `jack_enabled` switch gates only that workspace's default profile.
- The legacy `/voice` route (no connection number) is answered by Iron Wing's default profile, gated by `jack_enabled`, exactly as Jack is today. With no default profile it takes the softphone path.
- Nothing changes Twilio's routing. No live call or SMS is placed by any test.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **An empty knowledge field** (a new KelevoTMS profile before its text is written) must still produce a valid request: no empty text block carrying `cache_control`. Pinned in Task 2.
2. **The profile is disabled, missing, or in another workspace when a call arrives** (it was edited, or the number was moved): the caller gets today's softphone path, never silence or an error. Pinned in Task 5.
3. **No Iron Wing branding on another business's call**: fixed lines, the ended-session fallback, the summary prompt and the email all use the profile's company and persona. Pinned in Tasks 2, 6 and 7.
4. **A profile edited while a call is in progress** must not change that call. The session uses the profile read at call start. Pinned in Task 6.
5. **Restoring a revision** never loses the current text: restore saves a new revision. Pinned in Task 3.

---

### Task 1: Scratch database and migration 013

**Files:**
- Create: `migrations/013_agent_profiles.sql`, `scripts/migrate-agent-profiles.js`, `tests/agentProfiles.pg.test.js`
- Modify: `package.json` (script `migrate:agent-profiles`)

**Interfaces:**
- Produces: tables `agent_profiles`, `agent_profile_revisions`; columns `connection_numbers.handler | agent_profile_id | label | observe_hours`, `receptionist_calls.agent_profile_id`; widened `receptionist_calls` outcome check.

- [ ] **Step 1: Start the scratch Postgres** (once per machine; it is throwaway):

```bash
docker run -d --name twilio-app-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=twilio_app_test -p 55432:5432 postgres:18
export TEST_DB_URL=postgresql://postgres:test@localhost:55432/twilio_app_test
```

- [ ] **Step 2: Write the failing test `tests/agentProfiles.pg.test.js`.** It is gated like `tests/callAssist.pg.test.js`: it runs only when `AGENT_PROFILES_PG_TEST=1` and `TEST_DB_URL`'s path ends in `_test`, and it uses its own `pg.Pool` on `TEST_DB_URL`. `beforeAll` drops and recreates minimal prerequisites (`workspaces(id uuid pk, name text)`, `provider_connections(id uuid pk, workspace_id uuid)`, `connection_numbers(id uuid pk, connection_id uuid, phone_number text)`), runs `migrations/007_receptionist_calls.sql`, then runs `013` **twice** (rerunnable). Tests:
  - `connection numbers default to the softphone with hours observed`: insert a number; `handler = 'softphone'`, `observe_hours = true`, `label IS NULL`.
  - `ai_agent without a profile is rejected`: update a number to `handler = 'ai_agent'` with a null profile and expect error code `23514`.
  - `one default profile per workspace`: a second `is_default = true` profile in the same workspace fails with `23505`; another workspace succeeds.
  - `new outcomes are accepted and unknown ones are not`: insert `receptionist_calls` rows with each of `message, urgent, support_request, not_support` (ok) and `bogus` (`23514`).
  - `profile fields are capped`: a 501-character greeting fails with `23514`.

- [ ] **Step 3: Run it and see it fail.** Run: `AGENT_PROFILES_PG_TEST=1 TEST_DB_URL=$TEST_DB_URL npx jest tests/agentProfiles.pg.test.js`. Expected: FAIL (file `013_agent_profiles.sql` not found).

- [ ] **Step 4: Write `migrations/013_agent_profiles.sql`** in one `BEGIN … COMMIT`:
  - `agent_profiles`: `id uuid PRIMARY KEY`, `workspace_id uuid NOT NULL REFERENCES workspaces(id)`, `kind text NOT NULL CHECK (kind IN ('receptionist','dispatcher','support'))`, `name`, `persona_name`, `company_name` (`text NOT NULL`, length 1–120 checks), `greeting text NOT NULL` (≤500), `instructions text NOT NULL DEFAULT ''` (≤20000), `knowledge text NOT NULL DEFAULT ''` (≤60000), `voice text` (≤64), `alert_email text`, `daily_limit integer NOT NULL CHECK (daily_limit BETWEEN 1 AND 1000)`, `enabled boolean NOT NULL DEFAULT true`, `is_default boolean NOT NULL DEFAULT false`, `created_at`, `updated_at timestamptz NOT NULL DEFAULT now()`. Unique index `agent_profiles_one_default` on `(workspace_id) WHERE is_default`.
  - `agent_profile_revisions`: `id bigserial PRIMARY KEY`, `profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE`, `fields jsonb NOT NULL`, `saved_by text NOT NULL`, `saved_at timestamptz NOT NULL DEFAULT now()`; index on `(profile_id, saved_at DESC)`.
  - `connection_numbers`: `ADD COLUMN IF NOT EXISTS handler text NOT NULL DEFAULT 'softphone'`, `agent_profile_id uuid REFERENCES agent_profiles(id)`, `label text`, `observe_hours boolean NOT NULL DEFAULT true`. Add the checks `connection_numbers_handler_check` (`handler IN ('softphone','ai_agent')`), `connection_numbers_agent_check` (`handler <> 'ai_agent' OR agent_profile_id IS NOT NULL`) and `connection_numbers_label_check` (`label IS NULL OR length(label) BETWEEN 1 AND 60`), each inside a `DO` block that skips it when `pg_constraint` already has the name. Same-workspace is enforced in application code (Task 4); it can't be a column check.
  - `receptionist_calls`: `ADD COLUMN IF NOT EXISTS agent_profile_id uuid REFERENCES agent_profiles(id) ON DELETE SET NULL`. Replace `receptionist_calls_outcome_check` with the list `lead, not_a_lead, spam, abandoned, failed, message, urgent, support_request, not_support` (drop if exists, then add).

- [ ] **Step 5: Add `scripts/migrate-agent-profiles.js`**, a copy of `scripts/migrate-workspace-archive.js` pointing at `013_agent_profiles.sql` ("Agent profiles schema is ready."). Add the `package.json` script `"migrate:agent-profiles": "node scripts/migrate-agent-profiles.js"`.

- [ ] **Step 6: Run the test and see it pass** (same command as Step 3). Expected: 5 passed. Then run the whole suite without the env var. Expected: the new file is skipped and everything else passes.

- [ ] **Step 7: Commit**: `git add migrations/013_agent_profiles.sql scripts/migrate-agent-profiles.js tests/agentProfiles.pg.test.js package.json && git commit -m "feat: agent profiles schema (migration 013)"`

---

### Task 2: Kinds and the profile-driven prompt

**Files:**
- Create: `src/receptionist/kinds.js`, `src/receptionist/seed/jack.js`, `tests/receptionist/fixtures/legacy-rules.txt`, `tests/receptionist/kinds.test.js`
- Modify: `src/receptionist/prompt.js`, `tests/receptionist/prompt.test.js`

**Interfaces:**
- Produces:
  - `kinds.js`:
    - `KINDS: string[]`
    - `outcomesFor(kind): string[]` (the agent's `end_call` outcomes)
    - `toolsFor(kind): object[]` (`receptionist` and `dispatcher` get `lookup_carrier` and `end_call`, `support` gets `end_call` only; the `end_call` `outcome` enum and description match the kind)
    - `EMAILED_OUTCOMES: string[]`
    - `defaultDailyLimit(kind, config): number`
  - `prompt.js`:
    - `buildSystem(profile): object[]`
    - `fixedLines(profile): { fallback, stillThere, silentEnd, wrapUp }`
    - `callContext` (unchanged)
    - Removes `TOOLS`, `loadKnowledge`, `FALLBACK_LINE`, `STILL_THERE_LINE`, `SILENT_END_LINE` and `WRAP_UP_LINE`.
  - `seed/jack.js` exports `JACK` = `{ kind: 'receptionist', name: 'Jack (customer line)', personaName: 'Jack', companyName: 'Iron Wing Dispatching', greeting, instructions, knowledge }`, with `greeting` equal to today's `GREETING` and `knowledge` read from `knowledge/iron-wing.md`.
- A profile object everywhere in this plan is the camelCase row: `{ id, workspaceId, kind, name, personaName, companyName, greeting, instructions, knowledge, voice, alertEmail, dailyLimit, enabled, isDefault }`.

- [ ] **Step 1: Freeze today's rules.** Copy the current `RULES` string from `src/receptionist/prompt.js` verbatim into `tests/receptionist/fixtures/legacy-rules.txt`, before changing anything.

- [ ] **Step 2: Write the failing tests.**
  - `tests/receptionist/kinds.test.js`:
    - `each kind has its outcomes`: assert the exact three lists from Global Constraints.
    - `support has no carrier lookup`: `toolsFor('support').map(t => t.name)` equals `['end_call']`.
    - `end_call only offers the kind's outcomes`: for each kind, the `end_call` schema enum equals `outcomesFor(kind)`.
  - `tests/receptionist/prompt.test.js`:
    - `Jack's assembled prompt holds today's rules`: split the fixture and the first system block of `buildSystem(JACK)` into sentences. Every fixture sentence appears exactly once, and the assembled text contains no sentence outside the fixture.
    - `knowledge is the cached second block`: assert that block's text equals `JACK.knowledge` and that it carries `cache_control: { type: 'ephemeral', ttl: '1h' }`.
    - `the prompt is byte-identical across calls`: `JSON.stringify(buildSystem(p))` is equal for two calls.
    - `an empty knowledge field adds no empty block` (Review Focus 1): with `knowledge: ''`, no block has empty text, and the last block carries `cache_control`.
    - `support agents get no fraud rules`: a support profile's system text lacks the fraud-rules sentence "do not accept or confirm any change to bank details", which a dispatcher profile has.
    - `fixed lines name the profile's company` (Review Focus 3): `fixedLines({companyName:'KelevoTMS', …}).fallback` contains `KelevoTMS` and not `Iron Wing`. For `JACK`, `fallback` and `wrapUp` equal today's `FALLBACK_LINE` and `WRAP_UP_LINE` exactly.

- [ ] **Step 3: Run them and see them fail.** Run: `npx jest tests/receptionist/kinds.test.js tests/receptionist/prompt.test.js`. Expected: FAIL (`kinds.js` and `seed/jack.js` don't exist).

- [ ] **Step 4: Implement.**
  - Split `RULES` into a common safety preamble, an Iron-Wing-free fraud-rules part, and Jack's `instructions` in `seed/jack.js`. The common preamble covers AI disclosure, the transcription statement, spoken-text formatting, staying on subject and prompt-injection refusals. The fraud-rules part covers the "Some things do not bend" bullet.
  - Write the preamble with `${personaName}` and `${companyName}` substituted from the profile. Choose the split boundary so the equivalence test passes.
  - `buildSystem(profile)` returns two blocks: `[preamble (+ fraud rules unless support) + instructions]` and `[knowledge with cache_control]`. When knowledge is empty, it returns a single block that carries the `cache_control`.
  - Move the `TOOLS` definitions into `kinds.js`.

- [ ] **Step 5: Run the tests and see them pass** (same command). Then run `npx jest tests/receptionist`. Expected: failures only in callers of the removed exports (agent, session, summary). Tasks 6 and 7 fix those, so note the list.

- [ ] **Step 6: Commit**: `git commit -m "feat: per-kind tools and a profile-driven receptionist prompt"` (stage the files above).

---

### Task 3: Profile store, revisions and Jack's import

**Files:**
- Create: `src/agentProfiles.js`, `scripts/seed-agent-profiles.js`, `tests/agentProfiles.test.js`
- Modify: `package.json` (script `seed:agent-profiles`), `tests/agentProfiles.pg.test.js` (one round-trip test)

**Interfaces:**
- Consumes: `kinds.KINDS`, `kinds.defaultDailyLimit`, `seed/jack.JACK`.
- Produces (all async, all throwing plain `Error`s whose messages start with the prefixes listed in Task 9):
  - `listProfiles(workspaceId): Profile[]`
  - `getProfile(id): Profile | null`
  - `getDefaultProfile(workspaceId): Profile | null`
  - `createProfile(workspaceId, fields, savedBy): Profile`
  - `updateProfile(workspaceId, id, fields, savedBy): Profile`
  - `setDefault(workspaceId, id): Profile`
  - `listRevisions(workspaceId, id): {id, savedBy, savedAt, fields}[]`
  - `restoreRevision(workspaceId, id, revisionId, savedBy): Profile`
  - `validateFields(fields): object` (normalised; a sync function)
  - `seedJack(): { created: boolean }`

- [ ] **Step 1: Write the failing tests** in `tests/agentProfiles.test.js`, mocking `../src/db` like `tests/workspaceConnections.test.js`:
  - `validation enforces the caps`: a 501-character greeting, 20,001-character instructions, 60,001-character knowledge, an unknown kind, `daily_limit: 0` and an `alert_email` of `"no-at-sign"` each throw an error starting `Enter valid agent settings`.
  - `create defaults the daily limit by kind`: a receptionist with no `dailyLimit` stores 3 (`RECEPTIONIST_DAILY_LIMIT` unset); a dispatcher stores 20.
  - `every save writes a revision in the same transaction`: `updateProfile` issues `BEGIN`, `UPDATE agent_profiles`, `INSERT INTO agent_profile_revisions` with the full editable fields, then `COMMIT`.
  - `restore saves a new revision and keeps the old ones` (Review Focus 5): `restoreRevision` updates the profile from the revision's `fields` and inserts a new revision. It never issues `DELETE`.
  - `profiles from another workspace are not found`: `updateProfile(otherWorkspace, id, …)` with zero rows updated throws `Agent does not exist.`.
  - `setDefault clears the old default first`: within one transaction, `UPDATE … SET is_default = false WHERE workspace_id = $1 AND is_default` runs before setting the new one.
  - `seedJack is insert-only`: when Iron Wing already has a default profile, `seedJack()` returns `{created:false}` and inserts nothing. Otherwise it inserts `JACK` as the default receptionist, plus its first revision with `saved_by = 'import'`.

- [ ] **Step 2: Run them and see them fail.** Run: `npx jest tests/agentProfiles.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/agentProfiles.js`.** Write the SQL with snake_case columns and map rows to camelCase `Profile`s. Reuse the `inTransaction` pattern from `src/workspaceConnections.js` (or export it from there).

- [ ] **Step 4: Add `scripts/seed-agent-profiles.js`.** It refuses to run unless `DB_URL` is set, calls `seedJack()` and prints `Jack profile created.` or `Jack profile already exists; nothing changed.`. Add the `package.json` script `"seed:agent-profiles": "node scripts/seed-agent-profiles.js"`.

- [ ] **Step 5: Extend the pg test** with `seedJack creates one default profile and is rerunnable`: run it twice against the scratch database and expect exactly one Iron Wing profile and one revision.

- [ ] **Step 6: Run the unit and pg tests and see them pass.**

- [ ] **Step 7: Commit**: `git commit -m "feat: agent profile store with revisions and an insert-only Jack import"`.

---

### Task 4: Number settings and provider fields

**Files:**
- Modify: `src/workspaceConnections.js` (`listConnections`, `moveNumber`, new `updateNumberSettings`), `src/providerContext.js` (`getProvider`), `tests/workspaceConnections.test.js`, `tests/providerContext.test.js`

**Interfaces:**
- Produces:
  - `updateNumberSettings(workspaceId, numberId, { handler, agentProfileId, label, observeHours }): { id, handler, agent_profile_id, label, observe_hours }`
  - `listConnections` number rows gain `handler`, `agent_profile_id`, `label`, `observe_hours`.
  - `getProvider(...)` (including through `getProviderForWebhook`) returns these extra fields:
    - `numberLabel: string | null`
    - `handler: 'softphone' | 'ai_agent'`
    - `agentProfileId: string | null`
    - `observeHours: boolean`
  - The legacy provider returns `handler: 'legacy'`, `agentProfileId: null`, `numberLabel: null`, `observeHours: true`.

- [ ] **Step 1: Write the failing tests:**
  - `ai_agent needs an agent from the number's workspace`: when the profile lookup (`agent_profiles` joined to the number's connection workspace) returns no row, throw `Choose an agent from this workspace.` and run no update.
  - `softphone clears the agent`: `{handler:'softphone', agentProfileId: X}` stores a null profile.
  - `labels are trimmed and capped`: a 61-character label throws `Enter a line label of up to 60 characters.`; `"  Manager "` is stored as `"Manager"`; `""` stores null.
  - `moving a number resets its handler and keeps its label`: the `UPDATE connection_numbers` in `moveNumber` sets `connection_id`, `handler = 'softphone'` and `agent_profile_id = NULL`, and leaves `label` untouched.
  - In `tests/providerContext.test.js`, `providers carry the number's handler`: a mocked row with `handler: 'ai_agent'` yields `provider.handler === 'ai_agent'` and `agentProfileId`.

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement**, inside `inTransaction`, with the number row locked `FOR UPDATE`.
- [ ] **Step 4: Run them and see them pass**, then run the whole suite.
- [ ] **Step 5: Commit**: `git commit -m "feat: per-number handler, agent, label and hours settings"`.

---

### Task 5: Inbound routing by profile

**Files:**
- Modify: `src/receptionist/routing.js`, `src/receptionist/twiml.js`, `src/receptionist/store.js` (`startCall`, `countAgentCalls`), `tests/receptionist/routing.test.js`, `tests/receptionist/twiml.test.js`, `tests/receptionist/store.test.js`

**Interfaces:**
- Consumes: `provider.handler | agentProfileId` (Task 4), `getProfile`, `getDefaultProfile` (Task 3), `getAssistantSettings`.
- Produces:
  - `resolveProfile(provider): Profile | null`, where a legacy or undefined provider means Iron Wing's default profile, and a connection provider resolves only when `handler === 'ai_agent'` and the profile's workspace equals `provider.workspaceId`.
  - `decideRoute({ from, to, provider, config, profile }): { agent, reason }`
  - `store.startCall({ callSid, workspaceId, connectionId, from, agentProfileId })`
  - `store.countAgentCalls(from, agentProfileId, hours = 24)`
  - The relay token context becomes `{ callSid, workspaceId, connectionId, from, agentProfileId }`.

- [ ] **Step 1: Write the failing tests.** In `routing.test.js`, replace the Iron Wing-only assertions:
  - `no profile means no agent`: `profile: null` gives `{agent:false, reason:'no_agent'}`.
  - `a disabled profile falls back` (Review Focus 2): gives reason `profile_disabled`.
  - `a profile from another workspace falls back` (Review Focus 2): `resolveProfile` returns null when the profile's `workspaceId` differs from `provider.workspaceId`.
  - `jack_enabled gates only the default profile`: with `jack:false`, the default profile is refused (`workspace_disabled`) and a non-default dispatcher profile is allowed.
  - `saved contacts skip only receptionists`: a contact hit gives `contact` for a receptionist and `ok` for a dispatcher.
  - `the daily limit is per profile`: `countAgentCalls` is called with `(caller, profile.id)`, and the limit compared is `profile.dailyLimit`.
  - `test mode still limits every profile to test callers`.
  - `the legacy number still requires To to be the public number` (today's `not_public_number`).

  In `twiml.test.js`:
  - `the relay uses the profile's greeting and voice`: the `welcomeGreeting` equals `profile.greeting`, and `voice` falls back to `config.voice` when `profile.voice` is null.
  - `a failed profile lookup falls back within the deadline`: a lookup rejecting, or slower than `DECISION_DEADLINE_MS`, makes `agentTwiml` return null.
  - `the token context carries the profile and its workspace`: `agentProfileId` is the profile's id and `workspaceId` is the profile's workspace (not `IRON_WING_WORKSPACE_ID` for a KelevoTMS profile).

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** `agentTwiml` calls `resolveProfile` inside its existing `decide` promise, so the deadline covers it. `relayTwiml` takes `{ token, connectionId, config, baseUrl, profile }`.
- [ ] **Step 4: Run** `npx jest tests/receptionist` **and see the routing, twiml and store tests pass.**
- [ ] **Step 5: Commit**: `git commit -m "feat: route inbound calls to the dialed number's agent profile"`.

---

### Task 6: The live session runs on the profile

**Files:**
- Modify: `src/receptionist/server.js`, `src/receptionist/agent.js` (`createAgent`, `requestParams`), `src/receptionist/session.js`, `src/receptionist/twiml.js` (`endedHandler`), their tests

**Interfaces:**
- Consumes: `buildSystem`, `fixedLines` (Task 2); `toolsFor`, `outcomesFor`; `getProfile`.
- Produces:
  - `createAgent({ client, config, profile, lookup })`
  - `requestParams(config, profile)`
  - `createSession({ …, profile })`
  - `server.js` loads the profile once with `getProfile(context.agentProfileId)` when the setup message arrives. When it is missing it uses `failingAgent`, so the existing fallback line plays.

- [ ] **Step 1: Write the failing tests:**
  - `agent.test.js`:
    - `requests use the profile's system and tools`: `requestParams(config, support).tools` names only `end_call`.
    - `end_call rejects another kind's outcome`: a dispatcher's `end_call` with `lead` returns the outcome error listing `message, urgent, spam`.
  - `session.test.js`:
    - `the greeting comes from the profile`: the first transcript turn equals `profile.greeting`.
    - `fixed lines come from the profile`: the fallback is spoken with `fixedLines(profile).fallback`.
    - `an edit during the call does not change it` (Review Focus 4): mutating the profile object after `createSession` does not change the greeting or the prompt already sent.
  - `server.test.js`, `a missing profile gives the failing agent`: `getProfile` resolves null and the fallback line is sent.
  - `twiml.test.js`, `the ended fallback names no other business` (Review Focus 3): when the softphone fallback itself throws for a non-Iron Wing provider, the spoken line is `Thank you for calling. Someone will call you back soon.`; Iron Wing keeps today's line.

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Thread `profile` through. `createSession` copies the fields it uses at creation. Remove the remaining uses of the old prompt exports.
- [ ] **Step 4: Run** `npx jest tests/receptionist` **and see it pass**, except for the summary, finalize and email tests that Task 7 fixes.
- [ ] **Step 5: Commit**: `git commit -m "feat: live receptionist session uses the call's agent profile"`.

---

### Task 7: Summaries, emails and stored outcomes per kind

**Files:**
- Modify: `src/receptionist/summary.js`, `src/receptionist/finalize.js`, `src/receptionist/alertEmail.js`, `src/receptionist/store.js` (`OUTCOMES`, `listCalls`), their tests

**Interfaces:**
- Consumes: `kinds.outcomesFor`, `kinds.EMAILED_OUTCOMES`, `getProfile`.
- Produces:
  - `summarize({ client, config, transcript, carrier, context, profile, onUsage })`
  - `sendCallEmail(row, config, profile, { transport })`, which replaces `sendLeadEmail`
  - `store.OUTCOMES` gains the four new values
  - `listCalls` rows gain `agent_kind` and `agent_persona_name` (left join `agent_profiles`, null for old rows)
  - `finalize` loads the profile from `context.agentProfileId`

- [ ] **Step 1: Write the failing tests:**
  - `summary.test.js`:
    - `the summary schema takes the kind's outcomes`: a dispatcher's output format enum is `message, urgent, spam`.
    - `the summary prompt uses the profile` (Review Focus 3): the system text contains the profile's persona name and company and its knowledge, and not `Iron Wing` or `Jack` for a KelevoTMS support profile.
    - `Jack's summary instructions are unchanged`: for `JACK` the text equals today's `INSTRUCTIONS`.
  - `finalize.test.js`:
    - `emails go out for the five emailed outcomes`: `message`, `urgent` and `support_request` send. `not_support` and `spam` don't.
  - `alertEmail.test.js`:
    - `urgent subjects start with URGENT`.
    - `the recipient is the profile's alert email, else the global one`.
    - `transcript lines use the persona name`: `Ava: …`, not `Jack: …`.
    - `lead emails keep today's layout for receptionists`: snapshot of the existing body.
  - `store.test.js`:
    - `new outcomes are accepted`.
    - `listCalls returns the agent's persona`.

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Keep the `LeadSummary` field shape for every kind; only the `outcome` enum and the instruction text vary. For receptionists, the instruction text is today's `INSTRUCTIONS` with persona and company substituted. Dispatcher and support use a message-card variant: who called, what they need, references, urgency, and a short to-do instead of a sales script.
- [ ] **Step 4: Run the full suite and see it pass** (Node 22).
- [ ] **Step 5: Commit**: `git commit -m "feat: per-kind summaries, outcomes and alert emails"`.

---

### Task 8: Softphone line label and the hours switch

**Files:**
- Modify: `src/callResponse.js` (`voiceResponse`), `frontend/src/useVoice.js` (`watchCall`), `frontend/src/main.jsx` (incoming-call header near line 1584), `tests/callAnnouncements.test.js` or a new `tests/callResponse.test.js`

**Interfaces:**
- Consumes: `provider.numberLabel`, `provider.observeHours` (Task 4).
- Produces: a `<Client>` `<Parameter name="CalledLabel">` when the number has a label, and a `call.lineLabel` in `useVoice`.

- [ ] **Step 1: Write the failing tests:**
  - `labelled lines pass CalledLabel`: the TwiML for a provider with `numberLabel: 'Manager'` contains `<Parameter name="CalledLabel" value="Manager"/>`.
  - `observe_hours off skips the closed message`: an Iron Wing provider with `observeHours: false`, outside hours, dials the client instead of redirecting to `/closed`.
  - `other workspaces never get the closed message`: unchanged behaviour, pinned.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** In `useVoice`, read `instance.customParameters?.get?.("CalledLabel")` into `lineLabel`. `main.jsx` renders `workspaceName · lineLabel · localNumber`, skipping empty parts.
- [ ] **Step 4: Run the suite and `npm run build`. Both pass.**
- [ ] **Step 5: Commit**: `git commit -m "feat: show the dialed line's label and honour its hours switch"`.

---

### Task 9: Settings API and UI for agents and numbers; Leads labels

**Files:**
- Create: `frontend/src/AgentProfiles.jsx`
- Modify: `src/workspaceSettings.js` (routes, `publicError` prefixes), `frontend/src/WorkspaceSettings.jsx` (number rows; renders `<AgentProfiles>`), `frontend/src/Leads.jsx`, `frontend/src/leadCard.mjs`, `tests/workspaceSettings.test.js`, `tests/leadCard.test.js`

**Interfaces:**
- Consumes: Task 3 store functions, `updateNumberSettings`.
- Produces routes. Writes go through `requireSettingsWrite`, and `savedBy` is `'operator'` until 2b adds users.
  - `GET /settings/workspaces/:workspaceId/agents`
  - `POST /settings/workspaces/:workspaceId/agents`
  - `PUT /settings/workspaces/:workspaceId/agents/:agentId`
  - `POST …/agents/:agentId/default`
  - `GET …/agents/:agentId/revisions`
  - `POST …/agents/:agentId/revisions/:revisionId/restore`
  - `PATCH /settings/workspaces/:workspaceId/numbers/:numberId`
- `publicError` 400 prefixes: `Enter valid agent settings`, `Agent does not exist.`, `Choose an agent from this workspace.`, `Enter a line label`.

- [ ] **Step 1: Write the failing tests:**
  - `workspaceSettings.test.js`, `agent and number routes map validation errors to 400`: call each new route handler with the store mocked to throw each prefix, and expect 400 with the message. An unknown error gives 500 with the generic text.
  - `leadCard.test.js`:
    - `new outcomes have labels`: `URGENT`, `MESSAGE` for `message`, `SUPPORT` for `support_request`, `NOT SUPPORT`.
    - `urgent is owed a callback`: `OWED` includes `message`, `urgent` and `support_request`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - **API:** the routes as listed.
  - **`AgentProfiles.jsx`:**
    - List the profiles. Edit with a form for name, kind, persona name, company, greeting, instructions, knowledge, voice, alert email, daily limit and enabled, with character counters at the caps.
    - Add "Make default" and a revisions list with Restore.
    - Kind is fixed after creation.
  - **Number rows:**
    - A label input, a handler select ("Softphone", or "AI agent" with an agent select of this workspace's profiles), and an "Observe business hours" checkbox shown only in Iron Wing.
    - A Save button through `withPhonePaused`.
  - **`Leads.jsx`:**
    - Speaker label `lead.agentPersonaName || "Jack"`.
    - Script placeholder text only for `lead`.
    - Subtitle "Calls your AI agents answered, newest first.".
- [ ] **Step 4: Run the suite, `npm run build` and `npx eslint src tests`. All pass.**
- [ ] **Step 5: Commit**: `git commit -m "feat: agent profile editor and per-number handler controls"`.

---

### Task 10: Simulator, docs and final verification

**Files:**
- Modify: `scripts/receptionist-sim.js`, `README.md` (receptionist section: profiles, migrate and seed order), `docs/superpowers/specs/2026-11-24-agent-profiles-and-number-handlers-design.md` (status line: "2a implemented")

**Interfaces:**
- Consumes: `getProfile`, `getDefaultProfile`, `JACK`.

- [ ] **Step 1: Point the simulator at profiles.**
  - Add `--profile <id>`. Without it, use Iron Wing's default profile.
  - With `--seed`, use `JACK` from `seed/jack.js` and skip the database (so `tests/receptionist/sim.test.js` keeps running offline).
  - The greeting comes from the profile.
  - Update `sim.test.js` to use `--seed` behaviour.
- [ ] **Step 2: Run the full verification:** `npm test` (Node 22), `AGENT_PROFILES_PG_TEST=1 TEST_DB_URL=$TEST_DB_URL npx jest tests/agentProfiles.pg.test.js`, `npm run build`, `npx eslint src tests frontend/src`. Expected: all pass, with no new lint errors.
- [ ] **Step 3: Write the deploy order into the README.** Don't run it; production steps need the owner's go-ahead:
  1. `npm run migrate:agent-profiles`
  2. `npm run seed:agent-profiles`
  3. Deploy the code.
  4. Check that a test-caller call to the legacy number still reaches Jack.
- [ ] **Step 4: Commit**: `git commit -m "docs: agent profiles in the simulator and README"`.
