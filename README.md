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
by an AI phone assistant ("Jack") instead of ringing the softphone first. Jack
tells the caller he is an AI assistant and that the call is transcribed, answers
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

| Variable                                                            | Default                         | Meaning                                                                                            |
| ------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `RECEPTIONIST_ENABLED`                                              | off                             | The agent answers only when this is exactly `true`.                                                |
| `RECEPTIONIST_TEST_MODE`                                            | on                              | While on, only test callers reach the agent. Off only when exactly `false`.                        |
| `RECEPTIONIST_TEST_CALLERS`                                         | none                            | Comma-separated E.164 numbers that always reach the agent.                                         |
| `RECEPTIONIST_HOURS_START` / `_END` / `_TZ`                         | `7` / `18` / `America/New_York` | Calling hours, used for the callback promise and the existing closed-hours announcement.           |
| `RECEPTIONIST_VOICE`                                                | `7EzWGsX10sAS4c9m9cPf`          | ElevenLabs voice, in ConversationRelay's voice format (a model suffix such as `-v4` may be added). |
| `RECEPTIONIST_SAY_VOICE`                                            | none                            | Optional voice for the recorded announcements. Unset keeps today's voice.                          |
| `RECEPTIONIST_LIVE_MODEL` / `_EFFORT`                               | `claude-opus-5-5` / `low`       | Model and effort for the live call.                                                                |
| `RECEPTIONIST_LIVE_THINKING`                                        | `default`                       | `off` turns thinking off on Sonnet and Haiku models.                                               |
| `RECEPTIONIST_LIVE_SPEED`                                           | `standard`                      | `fast` uses fast mode on Opus (higher price).                                                      |
| `RECEPTIONIST_SUMMARY_MODEL`                                        | `claude-opus-5-5`               | Model for the after-call summary.                                                                  |
| `RECEPTIONIST_DAILY_LIMIT`                                          | `3`                             | Agent calls per caller number per 24 hours.                                                        |
| `RECEPTIONIST_MAX_CALL_SECONDS`                                     | `480`                           | After this long the agent wraps the call up.                                                       |
| `RECEPTIONIST_ALERT_EMAIL`                                          | none                            | Where lead emails go.                                                                              |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | port `587`                      | The mail account that sends them.                                                                  |
| `ANTHROPIC_API_KEY`                                                 | none                            | Read by the Anthropic SDK.                                                                         |

### Simulated callers

`npm run receptionist:sim` explains what a run costs and stops. Adding `--yes`
(`node scripts/receptionist-sim.js --yes [scenario]`) plays eight scripted callers
against the real agent in text only, with no phone call, and prints each
conversation with PASS/FAIL checks. It calls the Claude API and costs money.

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
