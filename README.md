# Twilio VoIP App

A browser-based VoIP application using Twilio, Express, PostgreSQL and Node.js.  
This app logs incoming/outgoing calls and messages, provides a real-time call log, and integrates Twilio Webhooks.

The frontend is a React application built with Vite. The server provides the
Twilio token, voice and SMS webhooks, and recent activity endpoints. Incoming
SMS can be viewed in the app; outbound SMS is not yet implemented. The phone
address book is stored separately from existing driver and company records.

---

## Features

## 📌 Built on Twilio’s Quickstart

This project was originally based on [Twilio’s Quickstart Voice App](https://github.com/twilio/voice-quickstart-node), which handled basic voice call routing.

### 🔥 Major Enhancements:

✅ **Call & SMS Logging** – Calls and messages are now stored in PostgreSQL.  
✅ **Custom REST API** – Added `/call-logs` and `/message-logs` for structured data retrieval.  
✅ **Twilio Webhooks** – Calls & messages log instantly via webhooks.  
✅ **Frontend Integration** – Built UI to display call & message logs in real-time.  
✅ **Database Optimization** – Prevents duplicate logs using `ON CONFLICT DO NOTHING`.  
✅ **Authentication (Planned)** – Working on adding JWT-based authentication.  
✅ **Error Handling & Debugging** – Uses `docker logs twilio-app` for server monitoring.

> 💡 **What I Learned**: Working on this project deepened my knowledge of **Twilio APIs, Express.js, PostgreSQL, and real-time event handling.**

---

## Tech Stack

| Technology            | Used For                 |
| --------------------- | ------------------------ |
| Node.js               | Backend server           |
| Express.js            | API Routing              |
| Twilio API            | VoIP & Messaging         |
| PostgreSQL            | Database                 |
| Webhooks              | Real-time updates        |
| JavaScript (Frontend) | Fetch API for UI updates |
| Docker                | Container deployment     |

---

## Installation

### 1. Clone the Repository

```sh
git clone https://github.com/Olorin4/twilio-app.git
cd twilio-voip-app
```

### 2. Install Dependencies

```sh
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the root directory:

```
PORT=3001
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_TWIML_APP_SID=your_twilio_app_sid
TWILIO_CALLER_ID=your_twilio_caller_id
TWILIO_IDENTITY=YourName
TWILIO_API_KEY=your_twilio_api_key
TWILIO_API_SECRET=your_twilio_api_secret
DB_USER=your_postgres_user
DB_HOST=your_postgres_host
DB_DATABASE=your_postgres_db
DB_PASSWORD=your_postgres_password
DB_PORT=5432
```

### 4. Set Up your PostgreSQL Database

Run:

```sh
psql -U yourusername -d yourdatabase -f setup.sql
```

### 5. Build and start the server

```sh
npm run build
npm start
```

The production server serves the generated `dist` directory. Docker builds it
automatically. Node.js 22.12 or newer (below 25) is required. To work on the frontend,
start the backend with `npm start` and run `npm run dev` in a second terminal;
Vite proxies the app's API requests to port 3001.

Set `APP_PASSWORD` to a strong password and `TWILIO_WEBHOOK_BASE_URL` to the
public HTTPS origin. Sign in with username `operator` and that password. Voice
and SMS webhooks must use the matching public origin and Twilio request
signatures.

Before using Contacts, run `npm run migrate:contacts` once against the intended
database. This creates the `phone_contacts` table without modifying existing
driver or company records. The migration is safe to rerun. For a local
PostgreSQL instance without TLS, set `DB_SSL=false`; production defaults to
the existing TLS connection settings.

Run `npm run migrate:activity-views` before using unread activity tracking.
Incoming calls and messages after the migration are unviewed until acknowledged;
older history is treated as viewed. The migration is safe to rerun.

Run `npm run migrate:call-announcements` against the intended database before
starting the version with automated-message tracking. The additive migration is
safe to rerun; older calls retain an unknown message status. Initiated means the
app returned instructions to play a greeting, and completed means Twilio reached
the instruction after the greeting; neither proves the caller listened.

Run `npm run migrate:receptionist-calls` before enabling the AI receptionist. It
creates the `receptionist_calls` table and is safe to rerun.

Run `npm run migrate:call-costs` before starting a release that shows call
costs. It adds columns for Twilio's price of each call leg and for the Claude
and ConversationRelay cost of calls the AI receptionist answered, and is safe to
rerun. The expanded call history then shows each call's cost next to its
status, and hovering it shows the parts. A cost appears only once Twilio has
priced the call and all its legs, which can take hours and for some calls never
happens; unpriced calls from the last two weeks are looked up again hourly. The
Claude and ConversationRelay parts are estimates from list prices at the time of
the call (`src/receptionist/costs.js`), marked with "≈". Replies the caller
interrupted are counted only for the prompt they had read.

Run `npm run migrate:twilio-reconciliation` before starting a release with call
callbacks and reconciliation. This migration creates call-leg and sync checkpoint
tables; the first reconciliation looks back at least one day, and subsequent
runs retain a one-day overlap and resume after downtime. Manual refresh syncs
with Twilio; a recovery sync also runs every 15 minutes. The previous one-minute
polling remains enabled by default during rollout. After verifying incoming and
outgoing signed call callbacks in the deployed app, set
`TWILIO_CALL_WEBHOOKS_VERIFIED=true` and restart to disable that polling.
Incoming and outbound
dialed call legs report progress to `/call-status` using signed webhooks. An
incoming call routed straight to an office-closed greeting has no dialed client
leg and cannot be identified as missed by that leg. Historical calls without a
recovered child leg may also lack a missed-call indicator.

### Running with Docker

In production the app runs as a Docker container built from this repository:

```sh
docker network create edge   # once; the compose file joins this external network
docker compose up -d --build
docker logs -f twilio-app
```

The container reads its configuration from the `.env` file next to
`docker-compose.yml` and listens on port 3001 without publishing a host port,
so it expects a reverse proxy on the `edge` network. See the Deployment section
of `docs/workspaces-and-communications-design.md` for the production procedure
and rollback.

---

## API Endpoints

| Method | Endpoint        | Description                       |
| ------ | --------------- | --------------------------------- |
| GET    | `/call-logs`    | Retrieves latest call logs        |
| GET    | `/message-logs` | Retrieves latest SMS logs         |
| POST   | `/voice`        | Twilio Webhook for incoming calls |
| POST   | `/sms`          | Twilio Webhook for incoming SMS   |

---

## Usage

### Making Calls

1. Dial your Twilio number to trigger a call.
2. The call logs instantly via Twilio Webhook (`/voice`).
3. Calls are synced every 5 minutes via `syncCallLogs()`.

### Sending SMS

1. Send an SMS to your Twilio number.
2. The message is logged instantly in the database.
3. The frontend fetches new messages every minute.

### Fetching Logs

1. Open the browser console (`F12 → Console`).
2. Run:

```javascript
fetch("/call-logs")
  .then((res) => res.json())
  .then(console.log);
```

---

## How It Works

### Call Logging Flow

```
1. Caller dials Twilio number
2. Twilio sends webhook to `/voice`
3. Backend logs the call via `logCall()`
4. Database stores the log
5. Frontend fetches logs from `/call-logs`
```

### Message Logging Flow

```
1. Sender sends SMS
2. Twilio sends webhook to `/sms`
3. Backend logs the message via `getMessageLogs()`
4. Database stores the message
5. Frontend fetches messages from `/message-logs`
```

---

## Next Steps

- Replace polling (`setInterval()`) with WebSockets for real-time logs.
- Add authentication (JWT) to secure API endpoints.
- Build an admin dashboard to manage logs.

---

## Contributors

- Nick Kalas (https://github.com/Olorin4)

---

## License

This project is licensed under the MIT License.

---

### SMS conversations

Run `npm run migrate:message-delivery` against the intended database before starting this version. This creates a separate delivery-status table and is safe to rerun. Set `TWILIO_WEBHOOK_BASE_URL` to the public app origin and configure the inbound SMS webhook to POST to `/sms`. Outbound messages include `/sms-status` as their Twilio status callback; both webhooks validate Twilio signatures. The signed-in browser listens on `/message-events` and refreshes conversations on reconnect. Configure the reverse proxy to allow streaming and disable response buffering for that route.

Set `TWILIO_PREVIOUS_NUMBERS` to a comma-separated list of former Twilio numbers (E.164 format) to include their messages in conversations. Messages that do not involve a configured number are not assigned to a conversation. Existing messages have no delivery status unless a callback is received.

---

## AI receptionist

When it is switched on, inbound calls to the public Iron Wing number are answered
by an AI phone assistant ("Jack") instead of ringing the softphone first. The
greeting gives only his name; he says he is an AI assistant, or that the call is
transcribed, when a caller asks. Jack answers
questions from a written knowledge document, collects the caller's MC number and
checks it against FMCSA's public records, and promises that a dispatcher will call
back. When the call ends, a lead card with a summary and a suggested callback
script appears in the softphone's **Leads** view, and an email goes to the owner.

Jack never places calls and never sends texts. Callers saved in Contacts skip him
and ring the softphone as before. If he cannot start, or fails mid-call, the call
falls back to the behaviour described above (ring the softphone during calling
hours, the recorded announcement otherwise).

Design and plan: `docs/superpowers/specs/2026-11-16-ai-receptionist-design.md`
and `docs/superpowers/plans/2026-11-16-ai-receptionist.md`.

### How it works

- The voice webhook decides per call (`src/receptionist/routing.js`) and, for an
  agent call, returns `<Connect><ConversationRelay>` (`src/receptionist/twiml.js`).
- Twilio ConversationRelay does speech recognition and the voice, and exchanges
  text with this app over a WebSocket at `/receptionist/ws`
  (`src/receptionist/server.js`, `session.js`).
- Each caller turn is answered by Claude (`src/receptionist/agent.js`) using the
  rules in `src/receptionist/prompt.js` and the knowledge document at
  `src/receptionist/knowledge/iron-wing.md`.
- After the call, `src/receptionist/finalize.js` writes the summary, saves the row
  in `receptionist_calls`, refreshes the softphone and sends the email.

### Settings

All settings are environment variables; `.env.example` lists them with comments.

| Variable                                                            | Default                         | Meaning                                                                                          |
| ------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `RECEPTIONIST_ENABLED`                                              | off                             | The agent answers only when this is exactly `true`.                                              |
| `RECEPTIONIST_TEST_MODE`                                            | on                              | While on, only test callers reach the agent. Off only when exactly `false`.                      |
| `RECEPTIONIST_TEST_CALLERS`                                         | none                            | Comma-separated E.164 numbers that always reach the agent.                                       |
| `RECEPTIONIST_HOURS_START` / `_END` / `_TZ`                         | `7` / `18` / `America/New_York` | Calling hours, used for the callback promise and the existing closed-hours announcement.         |
| `RECEPTIONIST_VOICE`                                                | `7EzWGsX10sAS4c9m9cPf`          | ElevenLabs voice for profiles with no voice of their own (ConversationRelay format, e.g. `-v4`). |
| `RECEPTIONIST_SAY_VOICE`                                            | none                            | Optional voice for the recorded announcements. Unset keeps today's voice.                        |
| `RECEPTIONIST_LIVE_MODEL` / `_EFFORT`                               | `claude-opus-5-5` / `low`       | Model and effort for the live call.                                                              |
| `RECEPTIONIST_LIVE_THINKING`                                        | `default`                       | `off` turns thinking off on Sonnet and Haiku models.                                             |
| `RECEPTIONIST_LIVE_SPEED`                                           | `standard`                      | `fast` uses fast mode on Opus (higher price).                                                    |
| `RECEPTIONIST_SUMMARY_MODEL`                                        | `claude-opus-5-5`               | Model for the after-call summary.                                                                |
| `RECEPTIONIST_DAILY_LIMIT`                                          | `3`                             | Agent calls per caller number per 24 hours, for profiles with no daily limit of their own.       |
| `RECEPTIONIST_MAX_CALL_SECONDS`                                     | `480`                           | After this long the agent wraps the call up.                                                     |
| `RECEPTIONIST_RELAY_RATE`                                           | `0.07`                          | ConversationRelay price per minute in US dollars, used to estimate call costs.                   |
| `RECEPTIONIST_ALERT_EMAIL`                                          | none                            | Where emails go, for profiles with no alert email of their own.                                  |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | port `587`                      | The mail account that sends them.                                                                |
| `ANTHROPIC_API_KEY`                                                 | none                            | Read by the Anthropic SDK.                                                                       |
| `TRUST_PROXY`                                                       | off                             | Proxies in front of the app (production `1`). Unset: only the per-username sign-in cap.          |

### Agent profiles

Each workspace can have several AI agent profiles (kind `receptionist`,
`dispatcher` or `support`): name, persona, company, greeting, instructions,
knowledge, voice, daily limit, alert email and an enabled switch, with a saved
revision history. Each phone number's handler is either the softphone or one
profile of the same workspace. Iron Wing's default profile (Jack) also answers
the legacy `/voice` route. Edit profiles and number handlers in the app; the
code is in `src/agentProfiles.js` and `src/receptionist/`. Design:
`docs/superpowers/specs/2026-11-24-agent-profiles-and-number-handlers-design.md`.

A profile is read when a call starts; editing it does not change a call in
progress. If a profile is disabled, missing or in another workspace when a call
arrives, the call takes the softphone path.

Which settings still apply once Jack is a profile:

- Daily limit: the profile's own value; `RECEPTIONIST_DAILY_LIMIT` only for a
  profile that leaves it empty (`src/receptionist/routing.js`).
- Voice: the profile's own voice; `RECEPTIONIST_VOICE` only for a profile with
  none (`src/receptionist/twiml.js`).
- Alert email: the profile's own address; `RECEPTIONIST_ALERT_EMAIL` only for a
  profile with none (`src/receptionist/alertEmail.js`).

After the Jack import these three live in his profile, so changing the
environment variables later does not change his behavior. Everything else
(`RECEPTIONIST_ENABLED`, test mode and callers, hours, models, max call length,
`RECEPTIONIST_SAY_VOICE`, SMTP) stays global and applies to every profile.
Alert emails for every workspace are sent from the one `SMTP_FROM` display
name, so another business's emails carry that sender name.

#### Deploy order

Production steps need the owner's go-ahead. Do not run them without it.

1. `npm run migrate:agent-profiles` against production, **before** the new code
   is deployed. It is additive and safe to rerun. It waits at most 5 seconds
   for a table lock; if it times out, simply rerun it. Deploying before step 1
   breaks inbound calls on connection numbers, outgoing calls and softphone
   tokens in every workspace (the app logs `DATABASE NOT MIGRATED` at startup
   when this happens).
2. `npm run seed:agent-profiles` right after the migration, run with
   production's `RECEPTIONIST_DAILY_LIMIT`
   (`RECEPTIONIST_DAILY_LIMIT=<prod value> npm run seed:agent-profiles`). It
   imports Jack as Iron Wing's default profile and takes his daily limit from
   the machine running the seed; a local `.env` without the variable gives 3,
   and the value then sticks.
3. Deploy the code.
4. Place a test-caller call to the legacy number and check it still reaches
   Jack (greeting, a saved row in `receptionist_calls`, and the email). In
   Settings, confirm Jack's daily limit matches production's, his voice is
   empty and his alert email is empty.

#### Testing against Postgres

The Postgres suites are skipped unless a scratch database is named. They refuse
any database whose name does not end in `_test`. Some suites read `TEST_DB_URL`
and others `DB_URL`, so set both to the same scratch database. Run them with
`--runInBand` (they share the public schema and can flake in parallel). With a
scratch Postgres on port 55433:

    DB_SSL=false DB_URL=postgresql://postgres:test@localhost:55433/twilio_app_test \
      TEST_DB_URL=postgresql://postgres:test@localhost:55433/twilio_app_test \
      AGENT_PROFILES_PG_TEST=1 USERS_PG_TEST=1 RINGING_PG_TEST=1 \
      CALL_ASSIST_PG_TEST=1 OUTREACH_INTAKE_PG_TEST=1 npx jest --runInBand

### Contact timeline and screen pop

`GET /contacts/:phone/timeline` (E.164 numbers only, 20 items a page, at most
50) returns one list for a number, newest first, merging calls, texts, AI agent
calls and Live Assist sessions. A call session appears only when it used Live
Assist or has notes or an outcome. It follows the same visibility rules as
history, so a user sees only what they could already see there.

**History** opens the timeline from contact rows, call rows, the conversation
header and lead cards. **Open** on an AI agent call opens the Leads view; on a
Live Assist session it opens that call's details.

When a call rings, the softphone shows `<name> · Last: <summary> · <relative
time>` under the number. It reads the call's own workspace, skips the ringing
call itself, never delays ringing and fails silently.

### Users, login and recovery

People sign in with a username and password. Settings and Users are
owner-only. Members see only their workspaces, ring only on lines assigned to
them, call and text only from their own lines, and see only the lines they may
see: assigned lines and shared AI lines (including the Iron Wing customer line
for Iron Wing members). A personal line is visible only to its assignees;
owners also see a personal line while it has no reachable assignee, because it
rings them.

#### Cutover

The `operator:APP_PASSWORD` login works only until the first enabled owner
exists. In order:

1. Deploy.
2. Log in as `operator`.
3. Create your owner in Settings -> Users.
4. Sign out and sign in again as your owner; the `operator` login stops working.
5. Create the dispatcher as a member of Iron Wing.
6. Assign the dispatcher's line ("Dispatcher 2") to him, and mark your own
   lines ("Manager" and "Lead dev") personal.

#### Recovery commands

`DB_URL=<target> npm run migrate:users` applies migration 014. The user scripts read the
password only from the `USER_PASSWORD` environment variable, never from argv:

    read -rs USER_PASSWORD; export USER_PASSWORD
    DB_URL=<target> npm run users -- create-owner <username>
    DB_URL=<target> npm run users -- reset-password <username>

The scripts load `.env` through dotenv, so a missing shell `DB_URL` silently
falls back to the `.env` database. Always pass `DB_URL` explicitly for the
database you mean. A CLI password reset, and any disable or role change made in Settings -> Users,
take effect on the running server immediately, because the server re-checks the
user's row on every cached login.

#### Deploy order (Phase 2: 2a, 2b and 2c)

1. Migration 013.
2. The 013 seed, with production's `RECEPTIONIST_DAILY_LIMIT`.
3. Migration 014.
4. Set `TRUST_PROXY` and confirm `TWILIO_IDENTITY` (see the checks below).
5. Deploy the code.
6. The owner cutover (Settings -> Users, steps above).
7. A test call.

Every production step needs the owner's go-ahead; deployment is on hold until
Phase 2c has landed.

Before deploying, check:

- `TWILIO_IDENTITY` is set in production. After cutover the `operator` login
  never mints a token again, so it is the only source of the legacy number's
  bootstrap identity: without it, the fallback ring (when the ring list can't
  be read) dials nobody and sync misses legacy softphone calls. The server
  warns at startup when it is unset.
- At startup the server logs `DATABASE NOT MIGRATED: run npm run migrate:users`
  when migration 014 is missing. It never crashes on it, so check the log.
- Production sets `TRUST_PROXY=1`, but only after confirming that the edge
  nginx sets `X-Forwarded-For` on the requests it proxies to the app, with
  either `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` or
  `proxy_set_header X-Forwarded-For $remote_addr;`. Express then takes the
  client's address from the last hop the edge added. Trust exactly as many
  proxies as really sit in front of the app: with too many trusted, a client
  can send its own `X-Forwarded-For` and forge its address, which lets it
  dodge the sign-in limits or lock out another address. `TRUST_PROXY=1` is
  safe only because port 3001 is reachable only from the edge nginx (the
  container publishes no host port). `TRUST_PROXY=true` is refused at startup,
  and so is any value Express can't read; `false`, `off`, `no` and `0` mean
  off.
- Failed sign-ins are limited to 30 a minute per client address, 10 a minute
  per client address and username together, and 100 a minute per username
  from anywhere, then answered with `429 Too many sign-in attempts`. A
  stranger's failures from their own address never lock a username out from
  another, and people already signed in keep working. A cached login lasts 5
  minutes from its last passing check, so an active session never falls back
  to a full password check. With IPv6 at the edge one client can rotate
  addresses within its /64, so the per-address limits slow it less; the
  per-username cap still applies. Without `TRUST_PROXY` every client looks
  like the edge nginx, so only the per-username cap applies and the server
  logs this at startup:
  `Per-client sign-in limits are off: set TRUST_PROXY to the number of proxies in front of the app. Only the per-username cap applies.`

### Simulated callers

`npm run receptionist:sim` explains what a run costs and stops. Adding `--yes`
(`node scripts/receptionist-sim.js --yes [scenario]`) plays eleven scripted callers
against the real agent in text only, with no phone call, and prints each
conversation with PASS/FAIL checks. It calls the Claude API and costs money.
It plays Iron Wing's default agent profile from the database; `--seed` plays
Jack from `src/receptionist/seed/jack.js` with no database, and
`--profile <id>` plays another profile.

### Rollout checklist

1. In the Twilio console, accept the terms for ConversationRelay (Privacy &
   Security; in the legacy console, the Predictive and Generative AI/ML Features
   Addendum). ConversationRelay does not work until this is done.
2. Run `npm run migrate:receptionist-calls` against the production database.
3. Confirm the reverse proxy passes WebSocket upgrades for `/receptionist/ws`. A
   WebSocket client connecting to `wss://<host>/receptionist/ws` must be refused
   by the app with HTTP 403, not fail at the proxy.
4. Set `ANTHROPIC_API_KEY`, the SMTP settings and `RECEPTIONIST_ALERT_EMAIL`. Set
   `RECEPTIONIST_ENABLED=true`, leave `RECEPTIONIST_TEST_MODE` on, and put your own
   number in `RECEPTIONIST_TEST_CALLERS`. Call in and check:
   - Twilio accepts the voice `7EzWGsX10sAS4c9m9cPf` and it sounds right on a
     phone line;
   - Jack's goodbye is not cut off before the call ends (if it is, raise the
     70 ms-per-character wait in `speakMs` in `src/receptionist/session.js`);
   - a spoken MC number and a keyed-in one (digits, then `#`) both work;
   - hanging up early still produces a card;
   - a call with your caller ID blocked makes Jack ask for a callback number;
   - talking without a pause for 20 seconds does not trigger "Are you still
     there?";
   - saying "okay, bye" over Jack's goodbye does not leave the call hanging;
   - the lead email arrives, and **Call back** on the card dials the right number;
   - `RECEPTIONIST_SAY_VOICE`, once set, plays on the fallback announcements.
5. Break it on purpose. Unset `ANTHROPIC_API_KEY`, call in, and confirm you hear
   the fallback sentence and an "Agent failed" card and email appear. Then stop
   the WebSocket from connecting (for example by blocking the path at the proxy)
   and confirm the call falls back to ringing the softphone. Finally, restart
   the app in the middle of a test call and note what the caller hears: Twilio's
   documentation does not say whether that reaches the fallback.
6. Compare `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` on test
   calls (with `RECEPTIONIST_LIVE_THINKING=off` for the last two, and
   `RECEPTIONIST_LIVE_SPEED=fast` as an Opus option) and choose by ear and cost.
7. Review and approve `src/receptionist/knowledge/iron-wing.md`, leaving no
   `TODO(owner)` lines. Jack answers "the dispatcher will cover that on the call"
   for anything the document does not state.
8. Set `RECEPTIONIST_TEST_MODE=false`. Read every transcript for the first two
   weeks.

### Live call assist

Run `npm run migrate:call-assist` and `npm run migrate:assistant-settings` after
the workspace and receptionist migrations.
The green phone button opens the dialer on every screen. Leads callbacks open a
prepared script before dialing. Operators can reopen a call from **Details** in
Calls to save or review its outcome and notes.

The top-bar **Phone settings** menu stores **AI assistant (Jack)** and
**Live Assist** preferences per workspace. Both default to on and apply to new
calls. Jack follows the server's receptionist settings and routing rules.
Set `CALL_ASSIST_ENABLED=true` to make Live Assist available on outbound phone
calls. Each workspace can turn it on or off for new calls with its switch. A
signed HTTPS webhook origin and server-side Anthropic configuration are
required. When Live Assist is on for the workspace, the drawer's **Live assist**
option starts selected and can be cleared before dialing. Capture
starts after the recipient answers and can be stopped
independently of the call. Leave recording off. Enable
`CALL_ASSIST_RETAIN_TRANSCRIPT` when operators need to review the captured text after the call.

Live suggestions default to Claude Haiku 5.5. Set `CALL_ASSIST_MODEL` to
override it. Post-call summaries continue to use the separate summary model.

On rollback, set `CALL_ASSIST_ENABLED=false` and restart the app so the worker
can stop active pilot transcriptions and suppress pending model work. The other
phone controls remain available. See the
[implementation plan](docs/superpowers/plans/2026-11-19-phone-drawer-and-live-call-assist.md)
for the test checks and data retention.
