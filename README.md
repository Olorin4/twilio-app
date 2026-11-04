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
✅ **Error Handling & Debugging** – Uses `pm2 logs` for server monitoring.

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
| PM2                   | Process monitoring       |

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
automatically. Node.js 22.12 or newer is required. To work on the frontend,
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

or with PM2:

```sh
pm2 start index.js --name twilio-voip
```

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
