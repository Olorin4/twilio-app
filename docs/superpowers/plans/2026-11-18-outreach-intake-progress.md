# Outreach intake (jack.call.v1) progress

Branch feat/outreach-intake. Design §6, plan T1–T2.

## Decisions

- summary_status is not a column: revision 1 is always PENDING; revision 2 is
  READY when a summary is stored, UNAVAILABLE when it is null or the
  NO_SUMMARY placeholder (moved to `src/receptionist/noSummary.js`, finalize
  re-exports it unchanged).
- finishCall/updateSummary now run on a pooled client in a transaction; the
  outbox insert runs under a SAVEPOINT. If the insert fails (e.g. table not
  migrated yet) the call row is still committed and only the event is
  skipped (logged with the PG error code only); the backfill recovers it.
  Saving Jack's lead wins over telling Outreach.
- Contract amendment (orchestrator, agreed with Outreach): `call.outcome` is
  `lead | not_a_lead`; `not_a_lead` only when `record.revision > 1` (zod
  refine). updateSummary queues revision 2 `not_a_lead` only when a revision 1
  row exists for the call (guarded inside the INSERT ... WHERE EXISTS, same
  transaction/savepoint). Calls never reported as leads queue nothing.
  Backfill: not_a_lead calls with a stored summary get revision 2 only when
  revision 1 is already in the outbox; what a call was first reported as is
  not stored, so one without revision 1 is treated as never reported
  (counted as `skipped`).
- source_link base = TWILIO_WEBHOOK_BASE_URL (the app's public origin);
  APP_ORIGIN is only a dev frontend origin.
- Event id namespace constant: `3b0c7f52-5d0e-4c55-9a7e-6f0a1f8e2d41`
  (src/outreachIntake/payload.js). Never change it.

## Log
- T1 c347bc0 outbox migration 009, events queued in finishCall/updateSummary tx, payload + zod schema + fixture
- T2 ac6b4ac sender (bearer + X-IW-Signature, backoff, 4xx final except 408/429), index.js start behind OUTREACH_INTAKE_ENABLED=1, backfill script

Verified on a throwaway postgres:18.4 (`twilio_intake_test`): migration
rerun, lead saved when the outbox table is missing, rev 1/2 queued once,
non-lead skipped, backfill dry-run/real/rerun counts, sender claim + retry +
deliver updates. Sender claims with a 2-minute lease on next_attempt_at
(no transaction held across the HTTP call). Revisions of one call may arrive
out of order after a retry; Outreach must keep the highest record.revision.
- amend 8d22b10 jack.call.v1 not_a_lead on revision >1; downgrade queues rev 2 only if rev 1 exists; backfill same rule

## Review fixes

- R-T1 789763c OUTREACH_INTAKE_WORKSPACE_ID (uuid, lowercased) required: isReady needs it; shouldEnqueue/enqueue refuse rows of other workspaces; backfill SELECT filters `workspace_id = $2` and the row check repeats it; unset → nothing queued/read, `WORKSPACE_ID_UNSET` logged once per process
- R-T2 07b5d9c LIMITS in contract.js (caller_name/company 200, mc_number/usdot 32, callback_promise 500, fleet_size 100, summary 2000) enforced by zod; payload clamps (trim, cut, no split surrogate pair)
- R-T3 ec9c574 401/403/404 retry with slow backoff 15 min doubling, cap 6 h, still FAILED at MAX_ATTEMPTS (12); other 4xx except 408/429 final
- R-T4 24d9562 tests/outreachIntake/outbox.pg.test.js, opt-in (OUTREACH_INTAKE_PG_TEST=1 + DB_URL db name ending _test; drops/recreates receptionist_calls + outreach_outbox). Ran once on throwaway postgres:18.4 at 127.0.0.1:55435 (twilio_intake_test): 3/3 pass; container removed. Skips (3 skipped) when off or the db name lacks _test.
