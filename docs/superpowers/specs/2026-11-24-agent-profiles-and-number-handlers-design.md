# Phase 2: agent profiles, users and per-person ringing, contact timeline

Status: draft for approval. Date: 2026-11-24. Phase 1 (number release/move, archive frees numbers) is shipped in `424e391`.

## Intent

Iron Wing Logistics LLC runs two businesses from one Twilio account and one app: Iron Wing Dispatching and KelevoTMS. Each business needs several phone lines that behave differently:

| Workspace | Line                 | Answered by                                                  |
| --------- | -------------------- | ------------------------------------------------------------ |
| KelevoTMS | Support              | AI agent (support persona)                                   |
| KelevoTMS | Lead dev (the owner) | The owner, in the softphone                                  |
| Iron Wing | Customer line        | AI agent "Jack" (today's receptionist)                       |
| Iron Wing | Dispatcher 1         | AI agent (dispatcher persona, brokers, carriers and drivers) |
| Iron Wing | Dispatcher 2         | Human dispatcher, in the softphone                           |
| Iron Wing | Manager (the owner)  | The owner, in the softphone                                  |

Today a workspace has one "active number", every non-AI call rings the one browser softphone, and the AI receptionist is hard-wired to Iron Wing: persona, greeting and knowledge are code, and routing checks `IRON_WING_WORKSPACE_ID`. Phase 2 makes the handler a property of the dialed number, makes AI personas data that belongs to a workspace, gives each person their own login and softphone ring, limits what each person sees, and gives every caller one timeline.

A human dispatcher will join. With today's single shared `operator` login (`src/security.js`) and one softphone identity per connection (`connection_<id>`), his softphone and the owner's would ring for every line on a connection, and he would see every workspace, including the owner's personal lines.

### Sub-phases

Phase 2 ships in three parts, each deployable on its own. Each gets its own implementation plan.

- **2a. Agent profiles and number handlers.** Sections *Data* to *Settings UI* below.
- **2b. Users, visibility and per-person ringing.** Section *2b*.
- **2c. Contact timeline and incoming-call context.** Section *2c*. Depends on 2b for visibility.

Order (owner's decision): 2a, then 2b, then 2c. The human dispatcher starts in a few weeks, after 2b ships.

## Goals

1. Each connection number has a handler: `softphone` (today's behaviour) or `ai_agent` (a chosen agent profile answers), plus a short label such as "Manager" or "Dispatcher 2". The browser softphone is the hub for every human line in every workspace.
2. Agent profiles are per workspace and editable in Settings: persona name, company, greeting, instructions, knowledge text, voice, on/off.
3. Iron Wing can run two AI lines (Jack and a dispatcher agent) and KelevoTMS can run its own support agent.
4. Each person has their own login and softphone. A line rings only the people assigned to it.
5. Each person sees only the history they should (rules in 2b). The owner sees every shared line in every workspace.
6. One timeline per caller per workspace: calls, texts, AI call summaries, Live Assist summaries and notes. The softphone shows the latest of it when a call rings.
7. Everything reachable today keeps working unchanged until an operator changes a number's handler or adds users.

## Non-goals

- **Outbound AI calls** (the dispatcher placing calls to carriers and drivers) are Phase 3.
- Changing the Twilio side: webhook URLs on numbers are still set by hand.
- Moving Iron Wing's legacy environment number (`TWILIO_CALLER_ID`) into the database.
- New agent tools beyond the fixed sets per kind below; call transfer; SMS handlers; ring groups or multiple human endpoints; per-profile business hours.
- Forwarding to outside phones (no `forward` handler): the softphone is the hub for all human lines.
- Handing a live AI call over to the softphone.
- Changes to Live Assist.
- AI memory of past calls (agents reading the timeline). Planned as the next phase, after 2c.
- Per-user unread state. Unread stays shared per workspace, like a shared inbox.
- Single sign-on, two-factor login, password reset by email.

## Anti-goals

- Jack's behaviour for Iron Wing callers changes in any way.
- An inbound call gets an error or silence because of this feature. Any failure falls back to today's softphone path, as `receptionist/twiml.js` does now.


## Constraints

- The database `iwd_database` is shared with `iwd-backend` and is production only. Migrations are additive and rerunnable. There is no scratch database, so any test that needs real Postgres needs one provisioned first.
- Prompt caching: the system prompt prefix must be byte-identical across calls of the same profile (`prompt.js`). Per-call text goes in the call context, as now.
- The global environment switches stay as the operator's safety controls: `RECEPTIONIST_ENABLED`, `RECEPTIONIST_TEST_MODE`, `RECEPTIONIST_TEST_CALLERS`, models, effort, daily limit, max call seconds, business hours. Test mode still limits every profile to test callers.
- Twilio's 2 second routing deadline (`DECISION_DEADLINE_MS`) still applies.

## Approaches considered

- **A. Agent profiles table plus per-number handler (chosen).** A profile has its own persona and a number points at it. Costs a table, an editor and extracting hard-coded text.
- B. One AI persona per workspace in `workspace_assistant_settings`. Cheaper, but Iron Wing cannot have both Jack and a dispatcher agent with different prompts.
- C. Per-number config in files or env. No UI and every change is a redeploy.

The owner chose A and chose to defer outbound calls to Phase 3.

## Design

### Data (migration 013, additive)

`agent_profiles`: `id uuid pk`, `workspace_id uuid fk`, `kind text check in ('receptionist','dispatcher','support')`, `name text` (label in Settings), `persona_name text` (spoken, e.g. Jack), `company_name text`, `greeting text`, `instructions text`, `knowledge text`, `voice text null` (falls back to `RECEPTIONIST_VOICE`), `enabled boolean default true`, `is_default boolean default false` (at most one per workspace, partial unique index), `created_at`, `updated_at`. Length caps: greeting 500, instructions 20,000, knowledge 60,000 characters.

`connection_numbers` gains `handler text not null default 'softphone' check in ('softphone','ai_agent')`, `agent_profile_id uuid null fk`, `label text null` (max 60), `observe_hours boolean not null default true`. Check constraint: `ai_agent` requires a profile in the same workspace as the number's connection.

`receptionist_calls` gains a nullable `agent_profile_id` so calls and leads show which agent took them. Old rows stay null.

### Prompt structure

Today's `RULES` constant splits in two:
- A fixed safety preamble in code, never editable, shared by every profile: AI disclosure, recording statement, spoken-text formatting, staying on subject, prompt-injection refusals, the do-not-bend fraud rules.
- `instructions` from the profile: persona, business, who calls, what to collect, callback wording.

Jack's seeded profile is the current text divided that way, with the same knowledge file (`knowledge/iron-wing.md`) and `GREETING`, so the assembled prompt for Iron Wing stays equivalent. A snapshot test must assert this.

### Kinds

The kind chooses the tool set and end_call outcomes (code, not data):
- `receptionist`: `lookup_carrier`, `end_call` with `lead | not_a_lead | spam` (unchanged).
- `dispatcher`: same tools; outcomes `message | urgent | spam`. Inbound only: takes calls from carriers and drivers and records a prepared message.
- `support`: no carrier lookup; outcomes `support_request | not_support | spam`.

### Routing

New `routeInbound` replaces the Iron Wing check in `decideRoute`:
1. Resolve the dialed number's handler (connection routes already resolve `provider.numberId`).
2. `ai_agent`: load the profile; if it is disabled, missing or in another workspace, fall back to the softphone path. Then the existing gates apply (feature enabled, test mode and test callers, contact skip within the profile's workspace, daily limit per caller).
3. `softphone`: today's `voiceResponse`. It already rings the connection's registered device and passes `CalledNumber`; it also passes `CalledLabel`. When `observe_hours` is false the "closed" announcement is skipped and the call always rings (for the owner's personal lines).

The legacy `/voice` route has no connection number: it keeps today's behaviour, answered by Iron Wing's default profile (`is_default`), gated by `workspace_assistant_settings.jack_enabled` as now. No existing connection number belongs to Iron Wing, so no live behaviour changes at deploy.

The relay token, `store.startCall` context, session, summary and leads code stop assuming Iron Wing and carry `workspaceId` and `agentProfileId`. `twiml.js` builds the relay greeting from the profile.

### Settings UI

Workspace settings gains an **Agents** section (list, create, edit, enable/disable, set default) and each number row gains label, handler, profile and "observe business hours" controls with the same phone-pause guard as other number changes. The incoming-call screen in the softphone shows the label next to the workspace name and dialed number (`useVoice.js` reads `CalledLabel`). Release/move from Phase 1 clears or checks these fields as needed: a move to another workspace resets the handler to `softphone`, clears the profile and keeps the label.

## 2b. Users, visibility and per-person ringing

### Accounts and login

- `app_users`: `id uuid pk`, `username text unique` (lowercase), `display_name`, `password_hash` (Node `crypto.scrypt`, salted, no new dependency), `role text check in ('owner','member')`, `enabled boolean`, `created_at`, `last_login_at`.
- `workspace_members(workspace_id, user_id)`: which workspaces a member can open. Owners can open every workspace without a row.
- `number_assignees(number_id, user_id)`: who rings for a line. A line can have several (ring all, first to answer wins).
- `connection_numbers` gains `personal boolean not null default false`.
- Login stays HTTP Basic, checked against `app_users`. The existing `operator:APP_PASSWORD` login keeps working as a bootstrap owner until the first owner account exists, then is refused. `req.user` is set for every authenticated request.
- Only owners can use Settings (workspaces, connections, numbers, agents, users). Members get 403 on every `/settings` write and do not see the Settings screen.

### Ringing

- Softphone identity becomes per person and per connection: `u<userId>_c<connectionId>`. The token endpoint mints it for `req.user` and only for connections in workspaces the user can open.
- A `softphone` line dials one `<Client>` per assignee (Twilio rings all and the first answer wins). A line with no assignees rings every owner, so nothing goes silent while numbers are being set up.
- The legacy Iron Wing number keeps its environment identity for the bootstrap login and rings every owner once owner accounts exist.
- Calls the user places use a line they are assigned to in that workspace (owners: any line). The workspace's active number stays the default for owners.

### What each person sees

A call or message belongs to a line by its number (`call_logs.to_number` for inbound, `from_number` for outbound; same for texts). A user sees a line's history when:

- they are an assignee of the line, or
- the line is not personal and they are an owner, or
- the line is not personal, its handler is `ai_agent`, and they are a member of its workspace.

Personal lines are visible only to their assignees, so the owner's Manager and Lead dev lines are hidden from the dispatcher. Contacts are shared within a workspace. Every history endpoint applies this filter: call history, conversations and threads, leads, Live Assist sessions, unread counts and search. Live update events stay content-free signals, and clients refetch through the filtered endpoints.

For the planned setup: the human dispatcher is a member of Iron Wing and assignee of Dispatcher 2. He sees Dispatcher 2's history plus Jack's and the AI dispatcher's calls and leads. He does not see the owner's personal lines or KelevoTMS.

### Users UI

Settings gains **Users** (owners only): create, disable, reset password, set role, choose workspaces. Each number row gains **Rings** (pick assignees) and **Personal**.

## 2c. Contact timeline and incoming-call context

- `GET /contacts/:phone/timeline` (workspace-scoped, filtered by 2b visibility) merges, newest first: calls (`call_logs`), texts (`message_logs`), AI call records (`receptionist_calls`: outcome, summary, callback promise), Live Assist sessions (`phone_call_sessions`: summary, notes, outcome). Paged. Transcripts are linked, not inlined.
- A timeline view opens from a contact, a call row, a conversation or a lead.
- When a call rings, the softphone fetches that caller's latest timeline entry in the call's workspace and shows a one-line summary on the incoming-call screen (a screen pop). It does not delay ringing: if the fetch is slow, the line appears when it arrives.

## Decided by me (owner can change)

- Three kinds and their outcome sets, as above.
- Business hours and the daily limit stay global in Phase 2. Today hours only change the callback wording in the call context (`isOpen`); the agent answers at any hour, and that stays true for every profile.
- Gates: `RECEPTIONIST_ENABLED`, test mode and the daily limit apply to every profile. A profile's `enabled` flag is its own on/off switch. The existing per-workspace `jack_enabled` setting keeps working and gates only that workspace's `is_default` profile.
- Outcomes and storage: new outcomes reuse `receptionist_calls` and the leads screen. The migration widens the `outcome` check constraint (today `lead | not_a_lead | spam | abandoned | failed`) to add `message | urgent | support_request | not_support`. Carrier fields (MC, USDOT) stay null for kinds that do not collect them.
- Safety preamble is modular: a common part for every profile (AI disclosure, "the call is transcribed so a person can follow up", spoken-text formatting, staying on subject, prompt-injection refusals) plus a fraud-rules part for `receptionist` and `dispatcher` only. It stays byte-identical per profile for caching.
- Jack lives in the app (owner's decision): after a one-time import, the database is the only source of truth for every agent, Jack included, and all are edited in Settings. The import is insert-only and never overwrites edits. `prompt.js` keeps only the fixed safety preamble and the kind tool sets; `knowledge/iron-wing.md` and Jack's instruction text remain in git only as the import's input. `scripts/receptionist-sim.js` reads the profile from the database. The snapshot test compares the prompt assembled from the import's inputs with today's `RULES` plus knowledge.
- Revision history: `agent_profile_revisions` stores a full copy of a profile's editable fields on every save (who, when). Settings lists revisions and can restore one, which saves as a new revision.
- Seeding: a migration script, like the other `scripts/migrate-*.js`, creates Jack's profile for `IRON_WING_WORKSPACE_ID` from the current code constants and marks it default. KelevoTMS gets no seed; the owner creates its profiles in the UI. A workspace may have no default profile, in which case the legacy `/voice` path falls back to the softphone.
- Iron Wing's customer line stays on the legacy environment number and the legacy `/voice` route (no cutover). New Iron Wing lines (AI dispatcher, human dispatcher, manager) are added to Iron Wing as connection numbers after deploy, using the Phase 1 release/move flow.
- Softphone hub: the softphone already registers one device per connection and shows the workspace name and dialed number on incoming calls, including for a workspace that is not selected. In 2a, lines are told apart by the label. 2b moves identities to per person (above).
- Visibility rules and roles (2b) follow the owner's approval: owner sees every shared line; a member sees assigned lines plus the AI lines of their workspaces; personal lines only their assignees. Modelled on Dialpad's admin and personal-line rules.
- HTTP Basic login is kept to limit change. Its known limit is that a browser cannot log out without closing it; a session-cookie login can replace it later.
- Compatibility: the new columns are nullable or defaulted and the check constraint only gains values, so existing reads and writes keep working. The plan must confirm `iwd-backend` does not enumerate `connection_numbers` or `receptionist_calls` columns strictly. Tests run on mocks plus a scratch Postgres provisioned for the work (for example a local container); nothing is tested against production.
- The dispatcher agent reuses the carrier lookup tool.
- Gates per kind: the "saved contact goes to the softphone" rule applies to `receptionist` profiles only, since Jack is for new callers. `dispatcher` and `support` agents answer saved contacts, because their callers are existing carriers, drivers and customers. The per-caller daily limit is counted per profile, with a profile column `daily_limit` (default: `RECEPTIONIST_DAILY_LIMIT` for receptionists, 20 for the other kinds).
- Notifications: each profile has an optional `alert_email`, which falls back to `RECEPTIONIST_ALERT_EMAIL`. The email template is chosen per kind: today's lead email for `receptionist`; a message email for `dispatcher` (subject starts "URGENT" for `urgent`); a support-request email for `support`. Transcript speaker labels use the profile's persona name, not "Jack". Outcomes that send an email: `lead`, `not_a_lead`, `message`, `urgent`, `support_request`. Spam and `not_support` send nothing.
- Closed hours: the closed announcement stays Iron Wing only, as today. `observe_hours` has effect only on Iron Wing numbers, so KelevoTMS lines keep ringing at all hours. Per-workspace announcement text is out of scope.
- Legacy Iron Wing number in 2b: treated as a fixed line "Iron Wing customer line", shared (not personal), `ai_agent` handled, so every Iron Wing member sees its calls and leads, including human softphone calls on it. It rings every owner.
- Visibility is judged on the line's current settings (a live join), not a snapshot at call time. Changing a line to personal hides its whole history from non-assignees, and changing it to `ai_agent` shows its history to workspace members. History whose number no longer has a row in that workspace (released or moved) is visible to owners only.
- `iwd-backend` is checked out at `/home/olorin4/web-dev/iwd-backend`, so the plan verifies its use of `connection_numbers` and `receptionist_calls` directly.

## Left to the builder

Exact column constraints, the bootstrap-login cutover mechanics, the scrypt parameters, the timeline query shape and paging, the seed script mechanism, the prompt split boundary (guided by the snapshot test), the form layout, how leads UI shows the agent and per-kind outcomes, and test strategy within the constraints above.

## Open dependencies

- KelevoTMS support knowledge text and the dispatcher agent's instructions are content the owner supplies. The design ships with editable placeholders only.
- A scratch Postgres is needed for any migration or SQL test beyond mocks.
