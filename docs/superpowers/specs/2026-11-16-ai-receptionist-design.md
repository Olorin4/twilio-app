# AI receptionist for the public sales line — design

Date: 2026-11-16 · Status: approved by the owner on 2026-11-16 · App: `twilio-app`

Background research: `reports/AI voice lead and dispatch automation.md` and the notes in
`research_notes/AI voice lead and dispatch automation/` (ConversationRelay protocol details are in
`voice_ai_architecture_and_vendors.md`).

Items marked **[owner]** were decided by the owner in conversation. Items marked **[my call]** are
defaults chosen while writing this up; the owner approved them as a group on 2026-11-16 without
discussing each one, so they are settled but cheap to revisit.

## Intent

Every call to the public Iron Wing number is answered by an AI agent whose only job is to turn an
interested caller into a warmed lead for the owner to close. **[owner]**

A call succeeds when it ends with: a warmed lead, their MC number collected, and a promise that a
human will call them back. The owner then reads an AI-written summary and a suggested script, and
calls back from the softphone — right away or a few minutes later. **[owner]**

Why now: today a caller either reaches the softphone within 20 seconds or hears a flat recorded
sentence and is hung up on (`src/callResponse.js:59-93`, `src/callAnnouncements.js:63-69`). Leads
who call outside 07:00–18:00 Eastern, or while the owner is busy, are lost, and the recorded
message sounds dated.

## Goals

1. The agent answers inbound calls to the public Iron Wing number at all hours. **[owner]**
2. It sounds like a friendly, professional, knowledgeable American dispatcher. **[owner]**
3. It answers questions from a written knowledge document about the dispatching business, and
   says so when it does not know. **[owner: knowledge of the business; my call: one document, see
   Approaches]**
4. It collects the caller's MC number and checks it against public FMCSA data.
5. It ends by promising a callback, then produces a lead card with summary and script.
6. The owner is alerted and can call back in one click.
7. With the feature switched off, or when the agent cannot start, calls behave exactly as today.

## Non-goals (first version)

- Outbound AI calls, and any texting of callers by the agent. (Both need caller consent that the
  website forms do not capture yet; see the research report.) The alert to the owner's own phone
  in section 5 is a separate matter.
- Live transfer or putting the caller on hold. The AI call always ends; the owner calls back.
  **[my call]**
- Driver, load, billing or account-change handling. Driver communication moves to a separate
  internal number. **[owner]**
- Spanish. English only. **[my call]**
- Other workspaces or the Kelevo brand. Iron Wing only. **[my call]**
- Audio recording. Only the text transcript is kept. **[my call]**
- Sending leads to `outreach` or a CRM. The stored record leaves room for it later.
- A vector store or per-question retrieval (approach B below).
- Anything about accent tools. Krisp is selected as the microphone in the browser and needs no
  code.

## Anti-goals

The build has failed, even if it works technically, if any of these happen:

- The agent states a price, term, guarantee or promise that is not in the knowledge document.
- The agent claims or implies it is human, or dodges when asked.
- A caller who asks for a person is argued with. (They get an immediate callback promise.)
- A caller hears long dead air, or the call drops silently when something breaks.
- The existing softphone, call logging or announcements change behaviour while the feature is off.

## Constraints

- **Stack:** Node ≥22.12, Express 4, plain JavaScript (CommonJS), PostgreSQL via `pg`, Jest. New
  dependencies: `ws`, `@anthropic-ai/sdk` and `nodemailer`.
- **No WebSocket server exists.** The HTTP server is created at `index.js:34`. Express middleware,
  including the login check at `index.js:15-29`, does not run on WebSocket upgrades, so the
  WebSocket endpoint needs its own authentication.
- **New webhook paths must be added to the login-bypass list** at `index.js:15-29` and must
  validate Twilio signatures like the existing ones (`src/security.js:24-32`,
  `src/connectionWebhooks.js`).
- **Both voice routes must be covered:** legacy `POST /voice` and
  `POST /webhooks/:connectionId/voice` (`src/router.js:57-91,162-183`).
- **`voiceResponse()` is synchronous** (`src/callResponse.js:14`). Deciding whether a caller is a
  saved contact or rate-limited needs a database read, so that decision happens before it is
  called, or the function becomes async.
- **The database is shared with `iwd-backend`.** Schema changes are additive SQL migrations with a
  matching `scripts/migrate-*.js` and npm script (pattern: `migrations/006_call_announcements.sql`).
- **The reverse proxy in front of the app is outside this repo** and was not inspected. It must
  allow WebSocket upgrades on the new path. Verify before any live test.
- **Compliance position:** this is inbound-only, which is the one AI voice use the research found
  needs no prior consent. The agent still discloses that it is an AI and that the call is
  transcribed, in its first sentence.
- **Claude API usage** must follow the current Anthropic SDK guidance (load the `claude-api` skill
  when implementing): streaming, tool use with `tool_choice: auto`, prompt caching, and handling of
  the `refusal` stop reason.

## Approaches

| | A. ConversationRelay, knowledge in the instructions | B. A plus a searchable knowledge store | C. Managed platform (ElevenLabs agents or Retell) |
|---|---|---|---|
| Knowledge | One reviewed document, loaded whole | Retrieved per question | Platform's knowledge base |
| Speed on the call | Fastest; no lookup per turn | Lookup delay on some turns | Slowest measured in the research |
| Fit | Stays inside `twilio-app` | Stays inside `twilio-app` | Number routing leaves the app |
| Effort | Least | More moving parts | Quick start, then glue work |

**Chosen: A. [owner]** The sales knowledge is small enough to load whole, which avoids dead air and
wrong retrievals. The knowledge document is structured in sections so B can be added later if it
grows.

## Design

### 1. Routing

When a call arrives for the public Iron Wing number, in this order:

1. Feature switch off → today's behaviour.
2. Caller is on the test list → the agent answers, skipping checks 3–5, so the owner can call in
   repeatedly from a saved number while tuning. **[my call]**
3. Test mode on (and caller not on the test list) → today's behaviour.
4. Caller is saved in Contacts (`phone_contacts`, matched on E.164) → today's behaviour. People the
   owner already knows ring the softphone directly. **[my call]**
5. Caller has exceeded the daily limit of agent calls (default 3 per number per day) → today's
   behaviour. **[my call]**
6. Otherwise → return `<Connect action="…"><ConversationRelay …/></Connect>`.

If ConversationRelay fails to start or the session ends in failure, Twilio calls the `action` URL;
that handler falls back to today's behaviour (ring the softphone in hours, announcement otherwise).

Outgoing calls from the softphone are untouched.

### 2. The conversation

A WebSocket endpoint on the existing HTTP server speaks the ConversationRelay protocol: Twilio
sends the caller's words as text and receives the agent's reply as streamed text, and handles
speech recognition, the voice, and interruptions.

- **Authentication:** the voice webhook (already signature-checked) mints a single-use, short-lived
  token per call and passes it to the session; the endpoint rejects any connection that does not
  present a valid one. Confirm against Twilio's docs how parameters reach the socket and whether
  the upgrade request is also signed; use both if available.
- **Model loop:** each caller turn is sent to Claude with streaming on; text is forwarded to Twilio
  as it arrives. When the caller interrupts, the conversation history is trimmed to what was
  actually spoken.
- **Prompt:** a fixed system prompt (persona, rules, call goal) followed by the knowledge
  document, cached. Because call volume is low, use the one-hour cache lifetime and warm the cache
  when the call connects, while the greeting plays.
- **Name: [owner]** the agent is called Jack Jones. It introduces itself by name and as an AI
  assistant in the same sentence, and refers to the person who will call back as "a dispatcher".
- **Style rules in the prompt:** one or two short spoken sentences per turn, one question at a
  time, no lists, numbers spoken digit by digit.
- **Tools (two only):**
  - `lookup_carrier(mc_number | usdot)` — see section 3.
  - `end_call(outcome, callback_when, notes)` — outcome is `lead`, `not_a_lead` or `spam`. The
    server says the closing line, ends the session and hangs up.
- **Non-leads:** existing customers, drivers, brokers and vendors get a short, polite message
  taken and a promise that someone will call back; the card is marked "not a lead". Obvious sales
  spam is ended politely. **[my call]**
- **"Can I talk to a person?"** → agree at once, ask for the MC number so the dispatcher is ready,
  promise the callback, end.
- **Limits:** a call is wrapped up at 8 minutes. If the model errors or stalls, the agent says a
  fixed sentence promising a callback and ends; the card is flagged "agent failed". **[my call]**

Greeting (wording to be tuned by ear):

> "Thanks for calling Iron Wing Dispatching. This is Jack, the AI assistant here, and this call
> is transcribed so our dispatcher can follow up. Are you looking for dispatch for your truck?"

### 3. MC number capture and check

- The caller can say the number or key it in followed by `#`.
- `lookup_carrier` queries FMCSA's public open-data service on `data.transportation.gov` — the
  same source `outreach` uses (`outreach/apps/api/src/features/ingestion/mc-numbers.ts:9`,
  `company-census.ts`) — and returns legal name, DBA, state, power units and authority status.
  The builder confirms the exact dataset fields; do not import code across repos.
- The agent says a short filler ("one second while I pull that up") before the lookup, which has a
  2.5-second timeout.
- **Match:** the agent confirms by name and place ("I have Smith Trucking out of Dallas, Texas —
  is that you?"). Stored as verified.
- **No match or timeout:** the agent reads the digits back one by one and stores the number as
  unverified.
- **No MC yet:** accepted. A USDOT number is taken if they have one; otherwise the card says
  "no authority yet".

Calling the public service directly, instead of asking `outreach`, is deliberate: `outreach` only
holds carriers it has imported as prospects, and this keeps the first version inside one app.
**[my call]**

### 4. The callback promise

- Inside the owner's calling hours (default: the existing 07:00–18:00 Eastern rule): "a dispatcher
  will call you back in the next few minutes from this number."
- Outside those hours: the agent offers the next day and lets the caller name a time window; the
  window is stored on the card. **[my call]**

Hours become a setting instead of the hardcoded values at `src/callResponse.js:56-57`.

### 5. After the call

When the session ends for any reason, including the caller hanging up mid-call, a second, non-live
Claude request turns the transcript and the carrier record into a structured result: caller name,
company, MC/USDOT, fleet size, equipment, current situation, questions and objections raised,
anything the agent could not answer, interest level, the promised callback time, a three-to-five
line summary, and a suggested callback script (opener, points to make, answers to their
objections, the next step to ask for).

The record is saved in a new table (`receptionist_calls`, keyed by call SID, with workspace,
caller number, timings, outcome, extracted fields, carrier snapshot, summary, script, transcript
and a status of new / called / dismissed). Calls with no caller speech are stored as abandoned
without a model request.

Then the owner is alerted two ways:

- **In the softphone.** The existing live event stream (`src/messageEvents.js`) only signals that
  something changed and carries no data, so the Leads view needs a new endpoint to fetch cards.
  A browser notification is shown for new leads; no browser-notification code exists today.
  **[my call]**
- **By email. [owner]** An email to the owner's alert address with the caller's name, company, MC
  number and its check result, the promised callback time, the summary and the script, plus a link
  to the softphone. `twilio-app` sends no email today; add SMTP sending with `nodemailer`,
  configured by its own settings. `iwd-backend` already sends mail this way
  (`iwd-backend/src/emailService.js`) and is the reference for the approach; do not import code
  across repos. A failed email is logged and must never block saving the card.

Only `lead` and `not_a_lead` outcomes send an email; spam, abandoned and failed calls appear in
the softphone only. Emails are sent at any hour. **[my call]**

### 6. The lead card in the softphone

```
┌─ NEW LEAD ─────────────────────── promised: next few minutes ─┐
│ Mike Alvarez · Alvarez Hauling LLC                 2 min ago  │
│ MC 1234567 ✓ verified · Dallas, TX · 2 trucks · authority 2025│
│                                                               │
│ Summary                                                       │
│ Owner-operator, 2 dry vans, runs TX–GA. Unhappy with current  │
│ dispatcher's fee. Asked about pricing and whether we handle   │
│ factoring paperwork. Wants to start next week.                │
│                                                               │
│ Suggested script                                              │
│ 1. Open: "Mike, this is … from Iron Wing, you called about …" │
│ 2. Fee question → …                                           │
│ 3. Couldn't answer on the call: factoring paperwork           │
│ 4. Ask for: sign-up today, send agreement link                │
│                                                               │
│ [ Call back ]   [ Transcript ]   [ Mark done ]   [ Not a lead ]│
└───────────────────────────────────────────────────────────────┘
```

"Call back" dials through the existing softphone call path. Cards live in a new "Leads" view,
newest first, with unhandled ones counted like unread activity.

### 7. Knowledge document

One Markdown file in the repo, versioned with the code, with sections: who we are; services; plans
and pricing; how onboarding works; requirements; documents needed; common questions and
objections; what the agent must never say (income or rate guarantees, legal or insurance advice,
anything not written here).

A first draft is written from the website pages (`iron-wing-dispatching/src/pages/index.astro`,
`sign-up.astro`, `terms.astro`, the blog). **The owner reviews and approves the document before
launch; that approval is a launch gate.** Questions the agent could not answer show up on lead
cards, which is how the document improves.

### 8. Voice

An ElevenLabs voice through ConversationRelay, chosen by voice ID in a setting. **The owner chose
voice ID `7EzWGsX10sAS4c9m9cPf` [owner]**; it is the default value of the setting. It has not yet
been tried inside ConversationRelay: the first test-mode call confirms that Twilio accepts this ID
and that it sounds right on a phone line, which flattens what a website preview sounds like. If
Twilio rejects it, the owner picks another library voice. Whether a privately designed or cloned
voice works inside ConversationRelay is unconfirmed.

The two fallback announcements also get a modern voice (a `voice` attribute on the existing
`<Say>` calls), so the safety net does not sound like the old system. The voice is a setting with
no default: until it is set and confirmed on a test call, the announcements are unchanged.

### 9. Model

The model is a setting, one for the live call and one for the after-call summary.

- **Live call default: `claude-opus-5-5` at low effort [my call]**, following current Anthropic
  guidance to default to the most capable Opus. This differs from the research report, which
  suggested Sonnet 5.5.
- Response delay is what matters on a call and has not been measured for any model here. Before
  launch, compare `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` on test calls and
  let the owner choose by ear and cost. List prices per million tokens (input/output): Opus 5.5
  $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50.
- After-call summary: `claude-opus-5-5`, structured output.

### 10. Settings and rollout

Settings (environment variables): feature switch, test-caller list, calling hours, voice ID, live
and summary models, owner alert email address, SMTP host/port/user/password/from address, daily
per-caller limit, maximum call length, Anthropic API key.

Rollout:

1. **Test mode:** the agent answers only for numbers on the test list. The owner calls in, hears
   the voice and the conversation, and tunes the knowledge document and greeting.
2. **Launch gates:** knowledge document approved; voice confirmed on a test call; model chosen; proxy WebSocket
   support verified; a fallback call tested with the agent deliberately broken.
3. **Live for all callers.** The owner reads every transcript for the first two weeks.

### 11. Testing

- Unit tests (Jest, existing style in `tests/`): routing decisions; the WebSocket session against
  scripted ConversationRelay messages with a mocked model; MC parsing and lookup with mocked HTTP;
  persistence; the fallback handler; alert email sending.
- A scripted set of simulated callers (new owner-operator, no MC yet, existing customer, broker,
  price-pusher, "are you a robot?", caller who asks for a human, solicitor) run against the real
  model and reviewed by hand before launch. This costs API money; get the owner's go-ahead before
  running it.
- Live test calls in test mode.

## Left to the builder

- Module layout (suggest `src/receptionist/`), table column types, route names.
- ConversationRelay message handling details and TwiML attributes, from Twilio's current docs.
- The exact FMCSA dataset query.
- Prompt wording, beyond the rules stated above.
- How the Leads view fits the existing softphone layout (`frontend/src/main.jsx`).
- Which neural voice the fallback announcements use.

## Still to come from the owner

1. The email address alerts go to, and SMTP credentials for sending (set as environment values at
   deploy time, never committed).
2. Review and approval of the knowledge document, once the first draft exists.
3. The choice of live-call model, after the test-call comparison in section 9.
