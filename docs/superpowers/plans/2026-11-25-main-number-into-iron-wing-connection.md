# Main number into the Iron Wing connection — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the main number, +18178653016, join Iron Wing's saved connection. Once it has, the legacy setup steps aside for it everywhere except the rollback paths.

**Architecture:**
- One helper decides whether a legacy number is "moved", meaning it is a `connection_numbers` row of an Iron Wing connection.
- Five legacy special cases consult that helper: the guard, the sync, visibility, the fallbacks, and the config route.
- Adding the number to the connection is the switch, and releasing it is the rollback. No new setting, no migration.

**Tech stack:** Node/Express, `pg`, Jest. Run `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx jest`. For Postgres tests, see the README "Postgres testing" section; the scratch database is on `:55433`.

**Spec:** `docs/superpowers/specs/2026-11-25-main-number-into-iron-wing-connection-design.md`

## Global constraints

- Never run tests or scripts against the production `DB_URL`.
- The legacy routes (`/voice`, `/sms`, `/call-status`, `/sms-status`), the legacy identities and tokens, and the legacy entry in `listVoiceTargets` stay as they are. They are the rollback path.
- `TWILIO_CALLER_ID` stays required. `token.js` keeps throwing without it.
- No schema change.
- Error copy, verbatim:
  - `selectLegacy` refusal: "The main number now belongs to the Iron Wing connection."
  - Unchanged guard error for any other workspace or account: "The current Iron Wing number is already assigned to the environment connection."

## Review focus

1. **Calls between adding the number and switching the webhooks** still arrive on `/voice`. The `/voice` webhook logs them with a NULL connection, and the connection's 15-minute sync must not re-attribute them. Pinned in Task 2.
2. **Releasing the number** restores every legacy behaviour at once: the sync owns it again, members see it again, and `selectLegacy` works again. Pinned in Tasks 2, 3 and 4.
3. **A number in `TWILIO_PREVIOUS_NUMBERS` that isn't moved** keeps its legacy behaviour even when `TWILIO_CALLER_ID` is moved. Pinned in Task 1.
4. **An owner with no active line after the move** gets "No phone number is selected for this workspace." instead of silently dialing from the legacy number. Pinned in Task 4.
5. **Another workspace's connection** still can't take the legacy number. Pinned in Task 1.

---

### Task 1: The "moved" helper, and the relaxed add-number guard

**Files:**
- Create: `src/legacyLine.js`
- Modify: `src/workspaceConnections.js`, the guard in `addConnectionNumbers` (around lines 586-595)
- Test: `tests/legacyLine.test.js`, `tests/workspaceConnections.test.js` (near the existing guard test at line 81)

**Interfaces:**
- Produces: `movedLegacyNumbers(db = pool): Promise<string[]>`. It returns the entries of `conversations.numbers()` that are `connection_numbers.phone_number` of a connection whose `workspace_id = IRON_WING_WORKSPACE_ID`. One query: `SELECT DISTINCT n.phone_number … WHERE c.workspace_id = $1 AND n.phone_number = ANY($2)`. It returns `[]` without querying when `numbers()` is empty.
- Produces: `legacyMoved(db = pool): Promise<boolean>`. True when `TWILIO_CALLER_ID` is in `movedLegacyNumbers`.

- [ ] **Step 1: Write the failing tests** in `tests/legacyLine.test.js`, mocking `src/db`:
  - `"a legacy number in an Iron Wing connection is moved"`: the mock returns `[{phone_number: "+18178653016"}]`. Expect `movedLegacyNumbers()` to equal `["+18178653016"]` and `legacyMoved()` to be `true`. The query's params are `[IRON_WING_WORKSPACE_ID, ["+18178653016", "+15550001111"]]`, with `TWILIO_PREVIOUS_NUMBERS="+15550001111"`.
  - `"a previous number not in a connection is not moved"`: the mock returns only the main number. `"+15550001111"` is not in the result.
  - `"nothing is moved when no legacy number is configured"`: with `TWILIO_CALLER_ID` and `TWILIO_PREVIOUS_NUMBERS` unset, expect `[]` and no query.
- [ ] **Step 2:** Add tests in `tests/workspaceConnections.test.js`, next to the existing "already assigned to the environment connection" test:
  - `"Iron Wing's own connection on the legacy account may take the legacy number"`: `addConnectionNumbers(IRON_WING_WORKSPACE_ID, …)` for a connection whose `account_sid` equals `TWILIO_ACCOUNT_SID`, with the legacy number selected. Expect it to resolve to `{ added: 1 }`.
  - The existing guard test, changed to use another workspace, still expects the unchanged error.
  - A new case: Iron Wing on a different `account_sid` still expects the unchanged error.
- [ ] **Step 3:** Run both test files and confirm they fail.
- [ ] **Step 4: Implement `src/legacyLine.js`.** In `addConnectionNumbers`, skip the legacy-number refusal only when `workspaceId === IRON_WING_WORKSPACE_ID && row.account_sid === process.env.TWILIO_ACCOUNT_SID`. `row` comes from `readConnectionCredentials`; select `account_sid` if it isn't already selected. Leave the guard in `createConnection` unchanged.
- [ ] **Step 5:** Run both test files and confirm they pass.
- [ ] **Step 6:** Commit with `feat: Iron Wing's connection can take the legacy number`.

### Task 2: The legacy sync skips moved numbers

**Files:**
- Modify: `src/reconciliation.js`, `reconcileOne` (around lines 192-203)
- Test: `tests/reconciliation.test.js`

**Interfaces:**
- Consumes: `movedLegacyNumbers()` from Task 1.

- [ ] **Step 1: Write the failing tests:**
  - `"the legacy sync does not own a moved number"`: with `movedLegacyNumbers` mocked to `["+18178653016"]`, a legacy reconcile over an inbound root call to `+18178653016` saves nothing.
  - `"after release the legacy sync owns it again"`: with the mock returning `[]`, the same call is saved with a NULL connection.
  - `"the connection sync does not re-attribute a call the /voice webhook logged"`: use the existing `saveCall` upsert with `owner = {workspaceId: IRON, id: "64d9…"}` against a row with a NULL connection. The update's `WHERE` clause, which compares `provider_connection_id`, leaves the row unchanged. Assert on the query text and params the mock receives, as the file's existing tests do.
- [ ] **Step 2:** Run them and confirm the first test fails.
- [ ] **Step 3: Implement it.** For the legacy owner, `ownedNumbers = numbers()` minus `await movedLegacyNumbers()`.
- [ ] **Step 4:** Run `tests/reconciliation.test.js` and `tests/syncOwnership.test.js`, and confirm they pass.
- [ ] **Step 5:** Commit with `fix: legacy sync leaves a moved number to its connection`.

### Task 3: A moved number follows its line's visibility rules

**Files:**
- Modify: `src/visibility.js`, `lineScope` (the `legacy` constant)
- Test: `tests/visibility.test.js`, `tests/users.pg.test.js`

**Interfaces:**
- `lineScope` already loads the workspace's `connection_numbers` rows, so it needs no helper call. `legacy = legacyNumbers(workspaceId).filter((n) => !rows.some((r) => r.phone_number === n))`.

- [ ] **Step 1: Write the failing tests:**
  - In `tests/visibility.test.js`: `"a member does not see a moved legacy number on a softphone line they aren't assigned to"`. Scope rows include `+18178653016` with `handler: "softphone"` and no assignees, so `visible` excludes it.
  - The same file: with `handler: "ai_agent"`, `visible` includes it.
  - The existing "members see the legacy number" tests, where no row has the number, stay unchanged and pass.
  - In `tests/users.pg.test.js`, with `W` set to `IRON_WING_WORKSPACE_ID`, or a new small describe using it: a NULL-connection call to the moved number is in an assigned member's history and not in an unassigned member's.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement the filter.
- [ ] **Step 4:** Run `tests/visibility.test.js`, `tests/historyVisibility.test.js`, and `tests/users.pg.test.js` with `USERS_PG_TEST=1`. Confirm they pass.
- [ ] **Step 5:** Commit with `fix: a moved main number follows its line's visibility`.

### Task 4: Fallbacks and pickers hide a moved number

**Files:**
- Modify:
  - `src/providerContext.js`, the `getProvider` legacy fallback (around lines 53-56)
  - `src/workspaceConnections.js`, `selectLegacy` (around lines 417-427) and the `listWorkspaces` `active_phone` fallback (around line 26)
  - `src/ringing.js`, the legacy line in `usableLines` (around lines 159-170)
  - `src/workspaceSettings.js`, `GET /config` (around lines 60-68)
- Test: `tests/providerContext.test.js`, `tests/workspaceConnections.test.js`, `tests/ringing.test.js`, `tests/workspaceSettings.test.js`

**Interfaces:**
- Consumes: `legacyMoved()` from Task 1.
- Produces: `GET /settings/config` returns `{ webhookBaseUrl, legacyPhoneNumber, legacyAccountSid, legacyMoved: boolean }`, with `legacyPhoneNumber: ""` when moved. The frontend's `callerLines` and the Settings "Existing Iron Wing connection" card already hide the legacy entry when the number is empty. No frontend change is needed beyond the copy in Task 5.

- [ ] **Step 1: Write the failing tests.** In each case, `legacyMoved` is mocked to `true`:
  - `getProvider(IRON_WING_WORKSPACE_ID)` with no active row rejects with "No phone number is selected for this workspace."
  - `selectLegacy(IRON_WING_WORKSPACE_ID)` rejects with "The main number now belongs to the Iron Wing connection." It does not delete the active row.
  - `listWorkspaces` passes `null` as the legacy `$2` param.
  - `usableLines(owner, IRON)` has no `legacy: true` entry.
  - `GET /settings/config` returns `legacyPhoneNumber: ""` and `legacyMoved: true`.
  - For each case, add a counterpart with `legacyMoved` mocked to `false` showing today's behaviour. Most already exist.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3:** Implement the five checks.
  - `listVoiceTargets` stays unchanged, because the legacy Device must stay registered for rollback. Add a one-line comment saying so.
- [ ] **Step 4:** Run the full `npx jest` suite and confirm it passes.
- [ ] **Step 5:** Commit with `feat: hide the legacy fallbacks once the main number is moved`.

### Task 5: Copy, runbook and gate

**Files:**
- Modify: `frontend/src/AgentProfiles.jsx` (the "answers the customer line" copy, around lines 156-164), `README.md` (the deploy and operations section), `src/deployCheck.js`
- Test: `tests/deployCheck.test.js`

- [ ] **Step 1: Write the failing test** in `tests/deployCheck.test.js`: `"a moved main number with no active Iron Wing line is reported"`. With `legacyMoved` set to true and no `workspace_active_numbers` row for Iron Wing, `problems` contains "The main number is in a connection but no Iron Wing line is selected for calling." Otherwise there is no problem.
- [ ] **Step 2:** Implement the check in `checkDeployReadiness`.
- [ ] **Step 3: Update the agent copy.** The default agent "answers the main number while it uses the server's legacy setup; numbers in a connection choose their agent under Settings → Twilio connections".
- [ ] **Step 4:** Add a README "Moving the main number" section with the spec's cutover and rollback steps, verbatim in substance.
- [ ] **Step 5:** Run `npx jest` and `npm run build`, and confirm both pass.
- [ ] **Step 6:** Commit with `docs: main number cutover and rollback; deploy gate`.

### Task 6: Cutover (operational, after deploy; owner present)

Not code. Follow the spec's "Cutover" section, steps 1 to 6.

- The owner does steps 1 to 3 in the app.
- I do step 4 through the Twilio API, with the local `.env` credentials, and print the before and after URLs.
- The owner places the test calls in step 5.
- I verify step 6 read-only, with a query showing that the new `call_logs` rows for `+18178653016` have the connection's id and that no SID appears twice.
- If anything is wrong, follow the spec's "Rollback" section.
