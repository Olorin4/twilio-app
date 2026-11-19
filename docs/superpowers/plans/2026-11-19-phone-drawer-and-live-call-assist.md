# Phone drawer, callback scripts, and live call assist

**Approved for planning on November 19, 2026.** The assisted calling pilot is internal-only. Implementation and rollout are described below.

## Outcome

Use one global phone drawer to make and receive calls, prepare a callback from a lead or missed call, and see suggested wording while speaking. An assisted human call can produce a short summary and, when enabled, a speaker-labeled transcript. The operator controls the call and confirms its outcome. Jack continues to answer calls and produce Leads cards through the existing receptionist workflow.

## 1. Port the Kelevo drawer and move the phone

Port the behavior of KelevoTMS's `packages/features/src/shell/Drawer.tsx`, the drawer styles in `packages/ui-components/src/theme.ts`, and the applicable session behavior in `packages/features/src/shell/AppShell.tsx`. Implement the port as a local React component and CSS. Use Twilio App's card surfaces, typography, borders, and existing call green. Map the drawer to Twilio App's navigation height and safe areas.

- Render through a portal with a 300 ms right-edge slide on open and close, rounded left corners on larger screens, and Kelevo's shadow and overlay behavior. Follow its full-width phone, approximately 80vw tablet, and approximately 33.25rem desktop sizing, with its responsive wide-screen cap where it fits.
- Preserve outside-press, Escape, and close-button dismissal. Use a stable gutter when locking background scroll. Give the body an independent scroll area and keep the header and call controls accessible. Use a reduced-motion variant.
- Move focus into the drawer on open and return it to the opener on close. Keep the closed drawer out of the tab order during and after its exit. At full width, prevent keyboard focus from moving behind the drawer. On desktop preserve Kelevo's undimmed overlay and outside-press behavior, including switching directly to another phone entry point. Test keyboard and touch dismissal.
- Add a prominent green handset button at the right end of the global top bar, including Settings, with an accessible name and expanded state. Move the number input, connect control, keypad, DTMF, mute, answer, decline, hangup, audio levels, and SMS composer out of the page grid. Keep the existing audio settings accessible.
- Keep the [Voice SDK hook](../../../frontend/src/useVoice.js) mounted in [the app shell](../../../frontend/src/main.jsx). Closing the drawer or navigating keeps a call and its redial context available. A compact ringing or active-call control on the handset button reopens the drawer and identifies the call's workspace. An incoming call shows `Answer` and `Decline` from every view. Keep the active-call workspace-switch restriction.
- Keep typed digits and SMS drafts when the drawer is closed in the same workspace. Use the shell's workspace reset pattern. An unrelated destination must never inherit a pending SMS draft or a different customer's script. Preserve existing SMS conversation actions.

**Acceptance.** Verify desktop, touch, keyboard, and reduced motion. Calls, Messages, Contacts, and Leads use the freed space. Answer a call while on Settings, close and reopen the drawer during an active call, send DTMF while connected, and send an SMS from the existing composer. Verify the green launcher and call controls at 320 px and while the mobile keyboard is open.

## 2. Prepare the callback before dialing

Extract the current script presentation from [Leads](../../../frontend/src/Leads.jsx) for use in the card and drawer. Keep [the callback-number selection rules](../../../frontend/src/leadCard.mjs), including preference for the number supplied by the caller. Show both the callback target and caller ID if they differ.

| Entry point                | Drawer behavior                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Green handset              | Open the keypad and restore its current workspace draft.                                                                                            |
| Contacts or Call history   | Prefill the selected number and leave dialing to the operator.                                                                                      |
| Leads callback             | Open the selected lead with its summary, confirmed details, promised callback time, and prepared script. Preserve the Leads view behind the drawer. |
| Missed call without a lead | Prefill the caller's number and offer the missed-call template.                                                                                     |

Initial callback templates:

- **Carrier lead** — “Hi [name], this is [dispatcher] from Iron Wing. Jack said you called about [confirmed topic]. Is now a good time? What are you running, and what would you like help with first?”
- **Existing carrier, broker, or vendor** — “Hi [name], this is [dispatcher] from Iron Wing, returning your call about [confirmed topic or reference]. Is there a deadline I should know about? Let me confirm the next step before we hang up.”
- **Missed call with no context** — “Hi, this is [dispatcher] from Iron Wing Dispatching. I’m returning your call. How can I help?”

Use the existing generated script when available. Present an opener, two or three points to cover, unanswered questions, and one proposed next step. Omit unknown placeholders from spoken lines. If the dialed number changes, detach the lead context and its pending call association. Link a genuine lead callback by lead ID and resolved call SID, including when the lead's callback number differs from caller ID. Keep **Mark done** explicit, with **No answer** and **Needs follow-up** available as call outcomes. A callback attempt, failure, or unreviewed call leaves the lead open.

**Acceptance.** Opening a callback never dials automatically. Verify the alternate-number case, missing number, missing script, edited destination, busy phone, failed call, and status updates from both the drawer and Leads.

## 3. Run live transcription on internal test calls

Pilot outbound human callbacks to teammates on a dedicated test connection or number and an explicit destination allowlist. Gate the feature on the server with a default-off setting and workspace, connection, and destination checks. In the drawer, the eligible operator can select **Live assist** before dialing. Transcription begins when the other test participant answers. The internal flow has no consent prompt, announcement, or confirmation step. Keep the call usable with assist disabled or unavailable.

- Extend the outbound Voice SDK call path in [the app shell](../../../frontend/src/main.jsx), [the Voice SDK hook](../../../frontend/src/useVoice.js), and [the voice router](../../../src/router.js). Create a short-lived, single-call intent in an authenticated workspace route. Bind it to the selected destination, provider connection, browser Voice identity, and optional lead ID. Pass its opaque ID in the SDK connect parameters. Resolve the actual parent CallSid from the signed outbound Voice webhook. Apply existing provider and workspace checks and strip invalid assist intent from an otherwise valid dial.
- Use [existing child call events](../../../src/callEvents.js) to confirm the remote leg answered. Start one Twilio Real-Time Transcription session on the bridged parent call via REST, with both tracks enabled and partial events disabled. Verify speaker mapping for the browser-to-phone bridge with a real internal call, then label the tracks `Dispatcher` and `Caller`. Use a bounded retry for the answer-to-start race. End capture on hangup or via **Stop live assist**, which leaves the call connected.
- Add a connection-scoped transcription callback through [the existing webhook authentication](../../../src/connectionWebhooks.js). Resolve each event to an authorized session from its account, connection, CallSid, and TranscriptionSid. Handle callbacks arriving before the transcription create response. Accept each final utterance once using the transcription SID and sequence ID. Bound request sizes, acknowledge promptly after persisting, and process suggestions asynchronously. Store raw content outside access logs.
- Add authenticated, workspace-scoped server-sent events for one active session and a snapshot endpoint for reconnect. Use header-aware streaming with the existing workspace API conventions. Send status and suggestions through this channel. Existing generic activity events can trigger a summary refresh without carrying text. Reject cross-workspace lookups and discard events for a superseded call or workspace.
- Model capture states as `waiting for answer`, `listening`, `stopped`, and `unavailable`. Use a distinct state for suggestion and summary failures. Make intent binding, job claims, terminal transitions, and callback ingestion idempotent. If a provider start times out, wait for its signed callback and reconcile against the stored intent. Retry only when the provider confirms the original request did not start capture. Otherwise show assist as unavailable and keep the call connected.

**Acceptance.** Confirm start occurs after answer, both tracks are correctly labeled, stopping assist leaves audio connected, and busy, canceled, no-answer, and non-allowlisted calls start no capture. Test duplicate, delayed, and out-of-order webhooks, workspace isolation, a disconnected browser, Twilio errors, and a lost API response. Public calls and Jack's ConversationRelay path remain outside the pilot.

[Twilio start/stop transcription API](https://www.twilio.com/docs/voice/api/realtime-transcription-resource) · [Twilio transcript event and track details](https://www.twilio.com/docs/voice/twiml/transcription)

## 4. Show live prompts from the existing Claude connection

Reuse the app's Anthropic client configuration, Iron Wing knowledge loading, and usage tracking from [Jack's agent](../../../src/receptionist/agent.js) and [summary generator](../../../src/receptionist/summary.js). Give the human assistant its own prompt and output schema. It gets the operator's prepared script, verified lead data, relevant approved company facts, and a bounded window of final utterances.

- Render one prominent **Say next** card with one or two sentences. Keep a short callback checklist visible alongside it. The operator can **Pin** the current wording or request **Suggest next**. Show listening, pending, and unavailable states without interrupting the script.
- Ask the model for a suggestion only when there is something useful to say or ask. Start with a short debounce after a completed caller turn, a five-second minimum between automatic requests, and at most one in-flight request per call. Merge rapid turns, suppress repeated suggestions, and discard responses for outdated context or ended calls. Configure the model, maximum assist duration, and maximum suggestions per call for the pilot. Give manual refresh priority within the same request limit.
- Require a compact validated response with suggested wording and an optional checklist hint. Keep caller speech as untrusted input. Use approved knowledge for prices and service terms, ask when a detail is missing, and keep suggested commitments under operator control. Route all output to the drawer. The model has no access to call controls or a speech output.
- Track transcription time, Anthropic tokens, suggestion count, and time from completed caller turn to visible suggestion. Aim for a typical useful suggestion within three seconds on the pilot calls and record measured median and 95th percentile. Treat the target as something to test. Keep the prepared script available during slow or failed requests.

**Acceptance.** Use a scripted test conversation with a carrier who switches topics, an unanswered question, a request for a price outside the knowledge document, and two rapid caller turns. Confirm suggestions remain grounded, pinned wording stays readable, stale responses never overwrite newer context, and the caller hears only the operator.

## 5. Save the call result and generate the summary

Add a migration and runner following the pattern in [existing call migrations](../../../migrations). Use separate records for assisted human calls, scoped by workspace, provider connection, and canonical parent CallSid. Link the originating lead optionally. Store intent/session state, final transcript turns, summary state, and operator-entered disposition and notes. Expose results through an authorized call-detail read, with availability only in the history list. Reuse [call history's parent/child grouping](../../../src/logManager.js) so one human conversation has one set of insights.

- When capture stops or the call ends, allow a bounded drain for final transcript events, then queue one post-call Claude summary from the same transcript. Summarize the reason for calling, outcome, commitments, unanswered questions, next action, and any stated owner or deadline. Leave uncertain details blank. An empty transcript or no answer produces no model summary.
- Expose **Summary**, **Transcript** when retained, **Notes**, and **Outcome** in the drawer after hanging up and on the exact call in history. Keep AI suggestions and operator-confirmed values distinguishable. Save manual notes independently of transcription and model health. A late model response cannot overwrite operator notes, disposition, or lead status.
- Persist a summary job before acknowledging terminal processing, lease it while running, and retry transient errors with backoff. Use a unique call key for one stored summary and predictable retries. An upstream model request can still be billed again if the worker loses its response. Display `Processing` or `Unavailable` and allow a controlled retry while source text exists.
- Start the pilot without audio recording. Use a durable, short-lived text buffer for retries. Proposed defaults are to delete raw turns on successful summary or within 24 hours of capture ending, and to retain an expandable transcript for up to seven days only when explicitly enabled for the internal workspace. Purge pilot summaries and drafts after 30 days. Operator notes saved through the normal call workflow follow that workflow's retention.
- Keep Jack's [receptionist finalization](../../../src/receptionist/finalize.js) and its existing Outreach intake contract intact. Human-call summaries stay in Twilio App for this pilot.

**Acceptance.** Verify the summary joins the intended call even when history sync arrives later, and that an alternate callback number preserves the lead link. Test duplicate finalization, retry after process restart, delayed final transcript, empty transcript, a partial transcript after stopping assist, retention cleanup, and a model outage with operator notes still saveable. Clearly label summaries from partial capture.

## Twilio costs and alternatives

Published U.S. list prices checked November 19, 2026. Figures are incremental to normal browser and telephone call-leg charges.

| Option                                                     | Cost and role                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pilot. Twilio live transcription with app-owned Claude** | $0.027 per transcribed minute, or $0.27 for 10 minutes, plus Claude calls for the live suggestions and one summary. Record observed Twilio usage for a two-track pilot and the actual Claude model and token totals before setting a budget.                                                                                                                                                                                                                            |
| **Twilio-native suggestions**                              | Use Next Best Response at $0.005 per 1,000 combined input and output characters per run, or a Custom Language Operator at $0.002 per 1,000 input and $0.018 per 1,000 output characters. Add live transcription and Conversation Orchestrator ingestion at $0.0002 per 1,000 ingested characters, plus any optional knowledge or memory charges. Use on-communication triggers with a bounded cadence and send results by webhook to the same drawer. Flex is optional. |
| **Post-call-only option**                                  | Twilio dual-channel recording plus batch transcription costs $0.0265 per minute before storage and summary generation. Add $0.0005 per stored minute per month. This option can ship later for selected calls that need a summary without live prompts. Account eligibility and the specific batch flow should be verified before implementation.                                                                                                                       |

Reusing the live transcript avoids a separate batch transcription for the same captured segment. Jack's ConversationRelay usage is billed on its own call path. Verify provider charges against real calls before comparing Claude and Twilio-native costs. The native option stays a design alternative for the pilot.

[U.S. Voice rates](https://www.twilio.com/en-us/voice/pricing/us) · [Conversation Intelligence and Orchestrator rates](https://www.twilio.com/en-us/products/conversational-ai/pricing) · [Twilio agent-assist architecture](https://www.twilio.com/en-us/blog/insights/agent-assist) · [Twilio batch transcription configuration](https://www.twilio.com/docs/configurations/batch-transcriptions)

## Implementation and release order

1. Port the drawer and move the phone UI. Verify responsive behavior and existing calls and SMS before enabling any capture.
2. Route contact, history, and Leads callbacks through the drawer. Add the reusable scripts and explicit dispositions.
3. Implement internal-only transcription, stream lifecycle, call linking, and stop controls. Exercise the path with two internal phone endpoints before feeding utterances to Claude.
4. Add live suggestions, post-call summary processing, transcript retention, and the call-history detail. Verify migrations against disposable PostgreSQL data, then run `npm test -- --runInBand`, `npm run lint`, and `npm run build` under supported Node 22.
5. Run browser checks on desktop and touch, then test real internal callbacks for success, no answer, stopping assist, closing the drawer mid-call, and provider/model failure. Inspect the outcome, summary, provider usage, and transcript deletion. Local tests and provider callbacks alone do not establish audio, latency, or billing.
6. Keep the pilot disabled by default outside the internal connection and destination allowlist. The server-side switch is the rollback for capture and AI processing. Disable new starts immediately, have the worker stop active pilot transcriptions, and suppress queued pilot AI work while connected calls continue. Public call capture requires a separate rollout decision.
