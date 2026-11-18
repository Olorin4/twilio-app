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
- Only rows whose outcome is `lead` after the change are queued. A call the
  summary downgrades from lead to not_a_lead keeps its revision 1 in the
  outbox and gets no revision 2 (contract only allows outcome "lead").
  Open question for Outreach: how to retract such a lead.
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
