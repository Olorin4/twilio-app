# Phase 2b: Users, Visibility and Per-Person Ringing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each person their own login and softphone identity, ring only the people assigned to a line, and limit what each person can see and do, so a human dispatcher can join without seeing or ringing the owner's lines.

**Architecture:**
- **Users and login.** Users, workspace memberships and line assignments live in new tables (migration 014). HTTP Basic login is checked against `app_users`, with scrypt hashing and a short in-memory cache. The legacy `operator` login survives only until the first owner exists. Every request gets a `req.user`.
- **Softphone identities.** One `identity` module owns the format `u<userId>_c<connectionId>` (or `u<userId>_legacy`) and the checks that a `client:` caller belongs to a connection. Tokens, ringing, outgoing-call checks, Live Assist binding and Twilio sync all use it.
- **Visibility.** One `visibility` module turns `(user, workspace)` into a line filter, and every history endpoint applies it.

**Tech Stack:** Node 22, Express, PostgreSQL (`pg`), Node `crypto.scrypt`, Twilio Voice SDK and TwiML, React (Vite), Jest.

**Spec:** `docs/superpowers/specs/2026-11-24-agent-profiles-and-number-handlers-design.md`. This plan covers section **2b**, plus the 2b items in *Decided by me*: visibility rules, HTTP Basic, the legacy Iron Wing line, live visibility, unread counts shared per workspace, and `iwd-backend`. Sections 2a (shipped, merge `7fb1b78`) and 2c are out of scope, except the 2a follow-up in Task 1.

## Global Constraints

- **Node 22 for every command.** Prefix with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. The baseline on `master` is 641 passed and 21 skipped.
- **Never touch production.** Never connect to the `DB_URL` in `.env`, which is the shared production `iwd_database`.
  - Postgres tests use the scratch container `twilio-app-test-pg` (`TEST_DB_URL=postgresql://postgres:test@localhost:55433/twilio_app_test`).
  - They are gated by an env flag and a database name ending in `_test`, following `tests/agentProfiles.pg.test.js`.
- **Deployment hold.** Nothing is deployed and no production migration runs until 2a, 2b and 2c have all landed (owner's decision). Tasks only document deploy steps.
- **Migrations** are additive and rerunnable, with `SET LOCAL lock_timeout = '5s'` after `BEGIN` (pattern: `migrations/013_agent_profiles.sql`).
- **Roles** are `owner | member`.
  - Owners can open every workspace without a membership row.
  - Members open only workspaces listed in `workspace_members`.
- **Login** stays HTTP Basic (`username:password`), checked against `app_users`.
  - Usernames are lowercase `[a-z0-9._-]`, 3–40 characters.
  - Passwords are 12–200 characters.
  - The legacy `operator:APP_PASSWORD` login is accepted only while no enabled owner exists. It then acts as a bootstrap owner with `req.user = { id: null, username: 'operator', role: 'owner', bootstrap: true }`.
- **Passwords** are hashed with `crypto.scrypt` using N=16384, r=8, p=1, a 16-byte salt and a 64-byte key. They are stored as `scrypt$16384$8$1$<salt b64>$<hash b64>`.
  - A successful login is cached in memory for 5 minutes, keyed by `sha256(username + ":" + password)`.
  - Changing a password, disabling a user or changing a role clears the whole cache.
- **Softphone identity.**
  - A user's identity is `u<userIdNoDashes>_c<connectionIdNoDashes>`, or `u<userIdNoDashes>_legacy` on the legacy number.
  - The bootstrap login keeps today's identities: `connection_<idNoDashes>`, and `getIdentity()` for legacy.
- **Ringing.**
  - A `softphone` line dials one `<Client>` per enabled assignee, up to the first 10 by assignment time.
  - A line with no assignees rings every enabled owner.
  - With no owner accounts yet, it rings today's identity.
  - The legacy number rings every enabled owner.
- **Visibility.** A call or message belongs to a line by its number: `to_number` when inbound, `from_number` when outbound. A user sees a line's history when any of these holds:
  - they are an assignee of the line;
  - the line is not personal and they are an owner;
  - the line is not personal, its handler is `ai_agent`, and they are a member of the line's workspace.
- **Other visibility rules.**
  - The legacy Iron Wing number counts as a shared `ai_agent` line, visible to Iron Wing members.
  - History on a number with no current row in the workspace is visible to owners only.
  - Outbound softphone calls with a `client:` caller are visible to the user in the identity and to owners. Bootstrap identities are visible to owners only.
  - Visibility follows the line's current settings, not its settings when the call happened.
  - Contacts are shared within a workspace.
  - Unread state stays shared per workspace, but counts only what the user can see.
- **Owner-only actions.** Every `/settings` request except `GET /settings/workspaces`, `GET /settings/voice-targets` and `GET /settings/assist` returns 403 to members. A personal line can't use the `ai_agent` handler; the error is `A personal line can't be answered by an AI agent.`
- **Placing calls and texts.**
  - A member places calls and sends texts only from a line assigned to them.
  - An owner may use any line in the workspace.
  - The workspace's active number stays the owner's default.
  - The legacy number is owners only.
- **Live update events** (`/message-events`) stay content-free signals.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The owner locks themselves out at cutover**: they create the first owner and then mistype or forget the password. A command-line recovery must exist that needs no login. This is pinned in Task 2, with `scripts/user-admin.js`.
2. **A dispatcher's browser, still registered under the owner's old identity or under another user's, must not ring for lines it isn't assigned to.** Tokens are minted only for `req.user`'s own identity. Pinned in Task 4.
3. **A line set to ring someone who is later disabled** still rings someone, and never silently rings nobody. The dial list skips disabled users and falls back to owners when it is empty. Pinned in Task 5.
4. **A member sees nothing of the owner's personal lines through any endpoint:**
   - call history, conversations and threads
   - unread counts
   - Live Assist sessions
   - search
   - a thread URL typed by hand with the personal line as `local`

   Pinned in Task 7 by one test per endpoint.
5. **A member forges a request**, for example a `FromNumber` that isn't theirs, a `localNumber` on another line, or an `X-Workspace-Id` for a workspace they aren't in. The request is refused, never treated as the owner's default. Pinned in Tasks 3 and 6.

---

### Task 1: 2a follow-up — discard the open receptionist row on the 1011 paths

**Files:**
- Modify: `src/receptionist/server.js`
- Test: `tests/receptionist/server.test.js`

**Interfaces:**
- Consumes: `store.discardCall(callSid)` (exists).

- [ ] **Step 1: Write the failing tests** in `server.test.js`:
  - `a profile that cannot load discards the open call row`: for each of missing, unreadable and other-workspace, `store.discardCall` is called once with the context's `callSid`, and the socket still closes with 1011.
  - `a session that fails to start discards the open call row`: same assertion on the `startSession`-throws 1011 path.
  - `discard errors never block the close`: `discardCall` rejecting still closes with 1011, and nothing throws.
- [ ] **Step 2: Run them and see them fail.** Run: `npx jest tests/receptionist/server.test.js`. Expected: FAIL (`discardCall` is not called).
- [ ] **Step 3: Implement.** Call `store.discardCall(context.callSid).catch(() => {})` on both 1011 paths before closing.
- [ ] **Step 4: Run them and see them pass**, then run the whole suite.
- [ ] **Step 5: Commit**: `fix: discard the agent call row when the session cannot start`.

---

### Task 2: Users schema, password hashing and admin script

**Files:**
- Create: `migrations/014_users.sql`, `scripts/migrate-users.js`, `src/users.js`, `scripts/user-admin.js`, `tests/users.test.js`, `tests/users.pg.test.js`
- Modify: `package.json` (scripts `migrate:users` and `users`)

**Interfaces:**
- Produces:
  - Tables:
    - `app_users(id uuid pk, username text unique, display_name text, password_hash text, role text check in ('owner','member'), enabled boolean default true, created_at, last_login_at)`
    - `workspace_members(workspace_id uuid fk, user_id uuid fk on delete cascade, primary key(workspace_id, user_id))`
    - `number_assignees(number_id uuid fk connection_numbers on delete cascade, user_id uuid fk app_users on delete cascade, created_at, primary key(number_id, user_id))`
    - `connection_numbers.personal boolean not null default false`
  - `src/users.js`. A `User` is `{ id, username, displayName, role, enabled, workspaceIds: string[] }`, never including `passwordHash`.
    - `hashPassword(plain): Promise<string>`
    - `verifyPassword(plain, stored): Promise<boolean>` (constant time)
    - `authenticate(username, password): Promise<User | null>` (cached; updates `last_login_at` at most once per cache fill)
    - `hasEnabledOwner(): Promise<boolean>`
    - `listUsers(): User[]`
    - `getUser(id): User | null`
    - `createUser({ username, displayName, password, role, workspaceIds }): User`
    - `updateUser(id, { displayName, role, enabled, workspaceIds }): User`
    - `setPassword(id, password): void`
    - `clearAuthCache(): void`
  - Errors start with `Enter a username`, `Enter a password of 12 to 200 characters.`, `That username is taken.`, `User does not exist.`, `Keep at least one enabled owner.`
  - `scripts/user-admin.js` supports `create-owner <username>` and `reset-password <username>`. The password is read from env `USER_PASSWORD`, never from argv. The script refuses unless `DB_URL` is set, and prints no secrets.

- [ ] **Step 1: Write the failing tests.**
  - `users.test.js`, with `../src/db` mocked:
    - `hashes verify and wrong passwords do not`. The hash matches `/^scrypt\$16384\$8\$1\$/`.
    - `usernames are lowercased and validated`: `"Ab"` is rejected, and `" Nick.K "` gives `"nick.k"`.
    - `passwords outside 12–200 characters are rejected`.
    - `authenticate caches success for 5 minutes and clearAuthCache drops it`: use fake timers and count the DB calls.
    - `a disabled user cannot authenticate`.
    - `the last enabled owner cannot be demoted or disabled`: the error is `Keep at least one enabled owner.`
    - `listUsers never returns password hashes`.
  - `users.pg.test.js`, gated by `USERS_PG_TEST=1` and a `_test` database:
    - Run migration 014 twice.
    - Create an owner and a member with a membership row.
    - Check the duplicate username error (`23505`), mapped to `That username is taken.`.
    - Check that deleting a number cascades its assignees.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Write the migration, following 013's guards and `lock_timeout`. Write `users.js` with `crypto.scrypt` promisified, `crypto.timingSafeEqual` and `inTransaction` from `src/workspaceConnections.js`. Write the admin script, plus `migrate-users.js` and the package scripts.
- [ ] **Step 4: Run** `npx jest tests/users.test.js` and `USERS_PG_TEST=1 TEST_DB_URL=… npx jest tests/users.pg.test.js`, then the whole suite.
- [ ] **Step 5: Commit**: `feat: user accounts schema, password hashing and admin script`.

---

### Task 3: Login, workspace access and owner-only settings

**Files:**
- Modify: `src/security.js` (`requireLogin`), `src/workspaceContext.js` (`resolveWorkspace`), `src/workspaceSettings.js`, `src/workspaceConnections.js` (`listWorkspaces`, `listVoiceTargets` take a user), `src/router.js` (`GET /me`), `index.js`
- Test: `tests/security.test.js`, `tests/workspaceContext.test.js`, `tests/workspaceSettings.test.js`, `tests/workspaceConnections.test.js`

**Interfaces:**
- Consumes: `authenticate`, `hasEnabledOwner` (Task 2).
- Produces:
  - `requireLogin` is async and sets `req.user` (a `User` or the bootstrap user).
  - `requireOwner(req, res, next)`, exported from `src/security.js`, returns 403 `{ error: "Only an owner can change settings." }`.
  - `canOpenWorkspace(user, workspaceId): boolean`, exported from `src/workspaceContext.js`.
  - `resolveWorkspace` returns 404 `Workspace not found.` for a workspace the user can't open, the same as an unknown one.
  - `listWorkspaces(user)` and `listVoiceTargets(user)` return only workspaces the user can open.
  - `GET /me` returns `{ id, username, displayName, role, bootstrap }`.

- [ ] **Step 1: Write the failing tests:**
  - `operator login works only while no owner exists`: with `hasEnabledOwner` false, `operator:APP_PASSWORD` passes and `req.user.bootstrap === true`. With it true, the same login gets 401.
  - `a user login sets req.user`: a disabled user, an unknown user and a wrong password each get 401 with the existing `WWW-Authenticate` header.
  - `webhook paths still skip login`: unchanged.
  - `members cannot open other workspaces` (Review Focus 5): `resolveWorkspace` with a member and a forged `X-Workspace-Id` gets 404. An owner passes.
  - `members get 403 on settings except the three reads`: table-driven over the router stack in `workspaceSettings.js`. Owner-only applies to every route except `GET /workspaces`, `GET /voice-targets` and `GET /assist`.
  - `workspace lists are filtered for members`: `listWorkspaces(member)` SQL joins `workspace_members` on the user id.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** In `index.js`, the login middleware must await `requireLogin` and pass errors on as 503 `App login is unavailable.`, never as `next()`.
- [ ] **Step 4: Run them and see them pass**, then the whole suite.
- [ ] **Step 5: Commit**: `feat: per-user login, workspace access and owner-only settings`.

---

### Task 4: Softphone identities and tokens

**Files:**
- Create: `src/identity.js`, `tests/identity.test.js`
- Modify: `src/token.js` (`tokenForProvider` → `tokenFor(user, provider)`), `src/router.js` (`GET /token`), `src/callAssist/store.js` (`bindIntent`), `src/syncOwnership.js` (`ownsRootCall`), `src/reconciliation.js`, their tests

**Interfaces:**
- Produces in `src/identity.js`:
  - `identityFor(user, provider): string`, per Global Constraints
  - `parseIdentity(identity): { userId: string|null, connectionId: string|null, legacy: boolean, bootstrap: boolean } | null`
  - `isClientOf(from, provider): boolean`. True when `from` is `client:` plus any identity for that connection: any user's identity or the bootstrap one. For the legacy provider, any `u…_legacy` identity or `getIdentity()`.
- `tokenFor(user, provider): { identity, token }`
- `ownsRootCall(call, numbers, provider)` now takes the provider and uses `isClientOf`.
- `bindIntent` uses `isClientOf(body.From, provider)`.

- [ ] **Step 1: Write the failing tests:**
  - `identityFor` formats for a user on a connection, a user on legacy, and the bootstrap user on each. The test also asserts that each identity is at most 121 characters.
  - `parseIdentity` round-trips each format and returns null for `client:alice` and malformed ids.
  - `isClientOf` is true for two different users on the same connection and false for the same user on another connection.
  - `a token is only ever for the requesting user` (Review Focus 2): `GET /token` for member A gives an identity with A's id, whatever headers are sent.
  - Twilio sync still saves a root call placed by a user identity (`syncOwnership.test.js`).
  - Live Assist binds an intent from a user identity (callAssist store test).
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** The legacy token keeps `tokenGenerator()`'s credentials and only changes the identity for real users.
- [ ] **Step 4: Run them and see them pass**, then the whole suite.
- [ ] **Step 5: Commit**: `feat: per-user softphone identities`.

---

### Task 5: Per-person ringing

**Files:**
- Create: `src/ringing.js`, `tests/ringing.test.js`
- Modify: `src/callResponse.js` (`voiceResponse(requestBody, provider, ringIdentities)`), `src/router.js` (both voice routes), `src/receptionist/twiml.js` (`endedHandler`), `src/workspaceConnections.js` (`setNumberAssignees`, `listConnections` adds `assignees`, `updateNumberSettings` takes `personal`), `tests/callResponse.test.js`, `tests/workspaceConnections.test.js`

**Interfaces:**
- Consumes: `identityFor` (Task 4).
- Produces:
  - `ringIdentities(provider): Promise<string[]>`. It never throws; on a DB error it returns the bootstrap identity for that provider.
  - `setNumberAssignees(workspaceId, numberId, userIds): { numberId, userIds }`. Every user must be enabled and an owner or a member of the workspace. Otherwise it throws `Choose people who can open this workspace.`
  - `updateNumberSettings` accepts `personal`. `personal: true` with `handler: 'ai_agent'` throws `A personal line can't be answered by an AI agent.`
  - `voiceResponse` dials one `<Client>` per identity. Each one carries the existing status callback and the `CalledNumber` and `CalledLabel` parameters.

- [ ] **Step 1: Write the failing tests:**
  - `ringIdentities` cases:
    - `assignees ring and nobody else`
    - `disabled assignees are skipped and an empty list rings the owners` (Review Focus 3)
    - `no users at all rings today's identity`
    - `the legacy line rings every owner`
    - `at most 10 identities, earliest assignments first`
    - `a database error returns the bootstrap identity`
  - `callResponse.test.js`:
    - `one Client per identity, each with the parameters`
    - `legacy dial with one bootstrap identity is byte-identical to today` (snapshot from `master`)
  - `workspaceConnections.test.js`:
    - `assignees must be able to open the workspace`
    - `personal and ai_agent cannot combine`
    - `moving a number clears its assignees` (extends Phase 1 `moveNumber`)
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - The router voice routes and `endedHandler` await `ringIdentities(provider)` before calling `voiceResponse`. An agent call still goes to the agent first, as today.
  - `moveNumber` deletes the number's `number_assignees` rows in its transaction and sets `personal = false`.
- [ ] **Step 4: Run them and see them pass**, then the whole suite.
- [ ] **Step 5: Commit**: `feat: ring only the people assigned to a line`.

---

### Task 6: Which line a person may call and text from

**Files:**
- Modify: `src/router.js` (outgoing branch of `/webhooks/:connectionId/voice` and `/voice`), `src/sendSms.js`, `src/router.js` (`GET /me/lines`), `frontend/src/useVoice.js`, `frontend/src/main.jsx` (caller-ID default), their tests

**Interfaces:**
- Consumes: `parseIdentity` (Task 4), `number_assignees`.
- Produces:
  - `mayUseLine(user, provider): Promise<boolean>`, exported from `src/ringing.js`:
    - Owners and the bootstrap user may use any connection line, or the legacy line.
    - Members may use only connection lines assigned to them, and never the legacy line.
  - `GET /me/lines?workspace=<id>` returns `[{ numberId, phoneNumber, label, legacy }]`, the lines the user may use in that workspace.

- [ ] **Step 1: Write the failing tests:**
  - `voiceWebhook.test.js`:
    - `a member calls out only from an assigned line` (Review Focus 5): a forged `FromNumber` of another line gets 403.
    - `owners keep today's active-number rule`.
    - `members cannot place calls on the legacy number`.
    - The user is taken from `parseIdentity(req.body.From)`. A `From` that doesn't parse as a user of this connection gets 403.
  - `sendSms.test.js`:
    - `a member's localNumber must be assigned to them`. Otherwise 403 `You can't send from this line.`
    - `a member without localNumber uses their first assigned line`.
    - `owners unchanged`.
  - A route test for `GET /me/lines`, checking owner and member results.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - **Frontend:** members default `phoneNumberRef` to their first line from `/me/lines`, and see a caller-ID select when they have more than one line. Owners see no change.
  - **Server:** when the outgoing webhook refuses, it uses today's 409 or 403 responses.
- [ ] **Step 4: Run the suite and `npm run build`.**
- [ ] **Step 5: Commit**: `feat: members call and text only from their own lines`.

---

### Task 7: Visibility filter on every history endpoint

**Files:**
- Create: `src/visibility.js`, `tests/visibility.test.js`
- Modify: `src/logManager.js` (`getCallLogs`, `getMessageLogs`), `src/conversations.js` (`list`, `thread`, `numbersFor`), `src/activityViews.js` (`counts`, `markCall`, `markConversation`), `src/callAssist/routes.js` (session and history reads), `src/receptionist/routes.js` (members only see leads of workspaces they can open, already enforced by `resolveWorkspace`), their tests

**Interfaces:**
- Consumes: `req.user`, `req.workspace`.
- Produces `lineScope(user, workspaceId): Promise<{ all: boolean, hidden: string[], visible: string[], clientPrefix: string|null }>`:
  - For owners: `all: true`, and `hidden` is the personal numbers they aren't assigned to.
  - For members: `all: false`, and `visible` is the lines they may see, including the legacy number for Iron Wing members.
  - `clientPrefix` is `client:u<uid>_` for the user's own outbound calls, or null for bootstrap.
- Produces `lineCondition(scope, lineExpr, fromExpr, firstParam): { sql: string, params: any[] }`. It builds a SQL fragment for a call or message row, where:
  - `lineExpr` is the CASE that picks `to_number` or `from_number` by direction
  - `fromExpr` is the raw `from_number`
  - Owners: `NOT (line = ANY(hidden))` and not someone else's personal client call.
  - Members: `line = ANY(visible)`, or `fromExpr LIKE clientPrefix || '%'`.

- [ ] **Step 1: Write the failing tests** (Review Focus 4). One test per endpoint with a member scope. The SQL must carry the filter, and the params must exclude the owner's personal line.
  - call history
  - message history
  - conversation list
  - conversation thread: a hand-typed `local` equal to the personal line gives an empty list or 404
  - unread counts
  - marking a hidden call or conversation as viewed: no effect, 404
  - Live Assist session and history reads: 404 for a session on a hidden line
  - search (call history with `search`)

  Also add:
  - `visibility.test.js`, covering scope building for owner, member, member of Iron Wing (legacy included) and bootstrap.
  - `history on a released number is visible to owners only`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Thread `lineScope` through each handler once per request. Keep queries' existing workspace filters, and add the condition. Extend `tests/users.pg.test.js` with minimal `call_logs` and `message_logs` tables (only the columns the queries use) and `EXPLAIN` the filtered call-history and conversation-list queries against the scratch DB, to prove the SQL parses.
- [ ] **Step 4: Run them and see them pass**, then the whole suite.
- [ ] **Step 5: Commit**: `feat: each person sees only the lines they may see`.

---

### Task 8: Users and line-assignment UI; who did it

**Files:**
- Create: `frontend/src/Users.jsx`
- Modify:
  - `src/workspaceSettings.js`: user routes, assignee route, `savedBy: req.user.username`
  - `frontend/src/WorkspaceSettings.jsx`: number rows "Rings" and "Personal"
  - `frontend/src/main.jsx`: Settings hidden for members; current user shown
  - `tests/workspaceSettings.test.js`

**Interfaces:**
- Consumes: Task 2 user functions, `setNumberAssignees`, `GET /me`.
- Produces owner-only routes:
  - `GET /settings/users`
  - `POST /settings/users`
  - `PATCH /settings/users/:userId`
  - `POST /settings/users/:userId/password`
  - `PUT /settings/workspaces/:workspaceId/numbers/:numberId/assignees` with `{ userIds }`
- `publicError` 400 prefixes for every Task 2 and Task 5 message.

- [ ] **Step 1: Write the failing tests:**
  - Each user route maps the store errors to 400 and unknown errors to 500.
  - A member gets 403 on each route (shared with Task 3's table).
  - `agent profile saves record the username`: `updateProfile` is called with `savedBy === req.user.username`, or `'operator'` for bootstrap.
  - `password routes never echo the password`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - **`Users.jsx`:** list users, create (username, display name, password, role, workspaces), disable or enable, change role, reset password. It shows "Keep at least one enabled owner." errors in place.
  - **First owner while bootstrap:** creating the first owner while logged in as `operator` shows a notice: "Sign in again as <username>. The operator password stops working now." The page then reloads, and the browser prompts again.
  - **Number rows:** gain a multi-select "Rings", listing users who can open the workspace, and a "Personal" checkbox. The checkbox is disabled while the handler is AI agent.
  - **Member view:** members don't see the Settings nav item. The header shows the user's display name.
- [ ] **Step 4: Run the suite and `npm run build`, and check eslint for no new errors.**
- [ ] **Step 5: Commit**: `feat: users and line assignments in settings`.

---

### Task 9: Docs and final verification

**Files:**
- Modify: `README.md` (users and login, cutover, recovery, deploy order addendum). Do not edit `docs/superpowers/specs/*` (the owner has uncommitted edits there).

- [ ] **Step 1: README.**
  - Add the cutover steps, in order:
    1. Deploy.
    2. Log in as `operator`.
    3. Create your owner in Settings → Users.
    4. Sign in again.
    5. Create the dispatcher as a member of Iron Wing.
    6. Assign Dispatcher 2 to him and mark your Manager and Lead dev lines personal.
  - Add the recovery commands: `USER_PASSWORD=… npm run users -- reset-password <name>` and `create-owner`.
  - State that the deploy order after 2a is: migration 013, the 013 seed, then migration 014, then the code. Production runs happen only after 2c lands, with the owner's go-ahead.
- [ ] **Step 2: Run the full verification.**
  - Expected: all pass, and no new lint errors versus base.

  ```
  npm test
  AGENT_PROFILES_PG_TEST=1 TEST_DB_URL=… npx jest tests/agentProfiles.pg.test.js
  USERS_PG_TEST=1 TEST_DB_URL=… npx jest tests/users.pg.test.js
  npm run build
  npx eslint src tests frontend/src scripts
  ```
- [ ] **Step 3: Commit**: `docs: users, cutover and recovery`.
