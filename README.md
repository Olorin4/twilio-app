# Twilio VoIP App

A browser-based VoIP application using Twilio, Express, PostgreSQL, and Node.js.  
This app logs incoming/outgoing calls and messages, provides a real-time call log, and integrates Twilio Webhooks.

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

### 5. Start the Server

```sh
npm start
```

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
