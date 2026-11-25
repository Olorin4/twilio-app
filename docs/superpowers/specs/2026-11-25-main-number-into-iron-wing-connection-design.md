# Main number into the Iron Wing connection — design

## Goal

Move the main Iron Wing number, (817) 865-3016, from the legacy setup into Iron Wing's saved Twilio connection, "Iron Wing" (`64d9ad54-…`).

- The legacy setup is the server's environment variables and the `/voice` and `/sms` webhooks.
- After the move, the main number behaves exactly like every other line: who answers it, its label, the hours switch, Personal, "Rings", and "Call and text from".
- Its existing history stays visible and keeps its meaning.
- The legacy code stays in place as the fallback.
- Deleting the legacy setup and unsetting `TWILIO_CALLER_ID` is a later, separate step. It is out of scope here.

## The rule: a legacy number that is in a connection is "moved"

A legacy number counts as moved when it is in `TWILIO_CALLER_ID` or `TWILIO_PREVIOUS_NUMBERS` and is also a `connection_numbers` row of an Iron Wing connection.

Wherever the legacy setup is special-cased, it steps aside for a moved number. There is no new setting: adding the number to the connection is the switch, and releasing it is the rollback.

Where the legacy setup steps aside for a moved number:

| Area | Today (legacy) | Moved |
|---|---|---|
| Legacy sync, every 60 s | Owns every legacy number | Skips moved numbers. The connection's sync owns them, so a call is never claimed by both. |
| Member visibility | Members always see the legacy numbers | A moved number follows its line's rules, like any line. |
| Owner's caller-ID fallback (`getProvider` with no active line) | Falls back to the legacy number | No fallback: "No phone number is selected". The cutover selects the main line. |
| `selectLegacy` ("use the existing number") | Allowed | Refused: "The main number now belongs to the Iron Wing connection." |
| Owner lines (`usableLines`) and `/settings/config` `legacyPhoneNumber` | Show the legacy number | Hidden. `legacyPhoneNumber` is `""` and `legacyMoved` is `true`, so the picker and the Settings card hide it. |
| `listWorkspaces` `active_phone` fallback | `TWILIO_CALLER_ID` | None |
| Browser registration of the legacy Device (`listVoiceTargets`) | Registered | **Still registered**, so a rollback rings at once |
| `/voice` and `/sms` routes | Answer the number | Unchanged. They only receive calls if Twilio is pointed back at them (rollback). |

The add-number guard ("already assigned to the environment connection") still applies, with one exception. Iron Wing's own connection may take a legacy number when that connection is on `TWILIO_ACCOUNT_SID`. Every other workspace or account is still refused.

History needs no change:
- Old rows have a NULL connection and keep their legacy meaning, through `FROM_LEGACY`, which keys on a NULL connection and `$1 = TWILIO_CALLER_ID`.
- New rows carry the connection.
- Visibility, conversations, the timeline and leads go by phone number or call SID, so old and new history show together on the same line. The line's label applies to both.

## Not changed

- **Fax.** It is gated to the legacy provider, and Twilio's Programmable Fax has been discontinued. Fax already sends with an undefined "from": `sendFax.js` imports `callerID`, but `token.js` exports `callerId`. After the move, `/fax` answers 409 like other connection lines.
- **The legacy routes, tokens and identities.** These remain for rollback.

## Cutover

Done by the owner and me, after deploying the code.

1. In Settings, under the Iron Wing connection, open "Manage numbers" and add +18178653016.
2. On that line, set the label to "Main", "Answered by" to AI agent → Jack, and leave hours on.
3. In the top bar, set "Call and text from" to Main.
4. In Twilio, point the number's voice and SMS webhooks at `/webhooks/64d9ad54-3d96-4d4b-a227-e1bc7870784a/voice` and `/sms`.
5. Make test calls: an inbound call that Jack answers; an outbound call from the browser; a text each way.
6. After 15 minutes, check that the new calls are attributed to the connection and show once.

Between steps 1 and 4, Twilio still sends calls to `/voice`, and they keep working there.

## Rollback

1. In Twilio, point the webhooks back at `/voice` and `/sms`. The legacy Device is still registered, so calls ring at once.
2. Release +18178653016 from the connection in Settings. Every legacy behaviour comes back: sync, visibility, picker and fallback.
3. In "Call and text from", choose the main (legacy) number.
