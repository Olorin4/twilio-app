# ADR 001: Integrate MMS into message conversations

- **Status:** Proposed
- **Date:** 2026-11-07
- **Related:** [Workspaces and communications integrations](workspaces-and-communications-design.md)

## Context

The app already receives and sends text messages, groups them into conversations, receives delivery callbacks, and refreshes the UI when messages change. The inbound webhook currently saves the message body but does not persist media. The outbound endpoint requires text and does not send attachments. Consequently an image-only inbound message can appear empty, and an operator cannot send an image.

Dispatching conversations can include delivery photos, freight damage pictures, and photographs of paperwork. These should appear alongside the corresponding text in the existing conversation. A number's advertised MMS capability does not establish that a particular destination, carrier, account registration, or route supports delivery.

The workspace design assigns messages and provider credentials to a workspace and connection. The existing shared operator login is not multi-user tenant isolation. The database is shared with another application, so changes must remain additive and compatible.

## Decision

Extend the existing messaging workflow to support MMS. Deliver incoming images first, followed by outgoing images. Use the existing conversation and message status model, adding attachment records and private media storage. Do not create a separate MMS inbox or automatically change Twilio routing.

### User experience

- Show attachments and any caption in the existing message bubble. Support image-only messages and a larger image preview. Show an attachment placeholder in the conversation list when the latest message has no text.
- Add an attachment picker, preview, removal control, and optional caption to the existing composer. Show the selected sending number, size and validation errors before sending. Preserve existing delivery statuses and display failures without suggesting an automatic resend when the outcome is uncertain.
- Start outbound support with JPEG, PNG and GIF. Handle other inbound content safely as downloadable attachments or an unavailable/unsupported placeholder; do not execute active content. PDF and other outbound formats are future work pending a concrete need and carrier compatibility checks.

### Incoming media

The signed inbound message webhook reads `NumMedia` and the indexed `MediaUrl` and `MediaContentType` fields. In a database transaction, persist the message and attachment metadata plus durable download work before acknowledging the webhook. Duplicate webhook deliveries must not create duplicate messages, attachments, or work. Media retrieval runs asynchronously with bounded retries, visible failure states, and recovery after process restarts; a transient file download failure must not discard the message.

The backend fetches media using the credentials for the message's original provider connection, including the legacy environment-based connection where applicable. Validate provider account, message and media identifiers and use an allowlisted Twilio API origin; do not fetch arbitrary user-supplied URLs or forward credentials across redirects. Store the retrieved bytes privately. Enforce download size limits while streaming, inspect actual file type rather than trusting the declared type, and prevent unsafe inline rendering. The UI accesses media through authenticated app endpoints that check workspace, message and connection ownership. Never expose provider credentials to the browser or log media URLs, credentials, or message content as part of media processing.

Reconciliation must discover attachment metadata for recovered messages and enqueue missing downloads, idempotently and within the correct provider connection. Existing messages remain readable even when media cannot be recovered; provide an explicit unavailable state. Reconciliation must not advance a checkpoint past work that has not been durably recorded.

### Outgoing media

Accept an authenticated, workspace-scoped upload to private storage. Validate actual file type and size on the server, generate server-controlled object names, and bind each staged file to its workspace and intended sender. The operator can submit a message with text, media, or both; an empty message without attachments remains invalid. Reject attachments belonging to another workspace or connection.

Twilio retrieves outbound media through a dedicated HTTPS URL that supports both `HEAD` and `GET`, returns the correct content type and length, and does not require the operator's browser session. Use an unguessable, narrowly scoped, expiring bearer token, permit repeated fetches while valid, redact tokens from logs, and retain access for a documented processing and retry window. The URL must expose only its intended file. Expiry and cleanup must account for queued requests and failure recovery; revoke access when safe. Authenticated viewing URLs and Twilio fetch URLs are separate.

Submit media URLs through the existing provider connection and preserve callback routing and delivery status handling. Persist a durable send intent and attachment associations before contacting Twilio, then record its message SID and status. A timeout or crash after submission is an **unknown outcome**, not evidence of failure: reconcile with Twilio where possible and require an explicit operator decision before retrying to avoid duplicate messages. Surface accepted-but-not-locally-finalized sends for recovery. Do not claim exactly-once delivery.

### Storage, limits and security

Use private persistent storage behind a storage interface. A persistent host volume is the proposed initial implementation, subject to confirming capacity, access, backup and restore; the container's writable layer is not durable storage. Private object storage is an alternative if operational requirements favor it. Do not use the public social-media bucket. Store only metadata and storage keys in PostgreSQL; never expose private filesystem paths. Define and verify backups, restore, retention, deletion and orphan cleanup before production use. The retention period remains an open product decision and must be configurable or explicitly set before enabling production ingestion.

Twilio documents up to 10 media URLs and a 5 MB combined outbound MMS limit, with additional type, carrier and destination restrictions. The initial UI should use a conservative configurable limit below the provider maximum, initially one image per message; validate the complete payload on the server. Do not silently compress or change a document: if image resizing is added, show the user that it happens. Apply bounded inbound file size, request timeouts and storage quotas independently of provider limits. See [Twilio accepted media types](https://www.twilio.com/docs/messaging/guides/accepted-mime-types) and [Message resource](https://www.twilio.com/docs/messaging/api/message-resource).

## Data and operational changes

- Add a message attachment table with stable ID, message association, workspace and provider connection, direction, provider media ID where available, private storage key, content type, size, and processing state. Add unique constraints for idempotency; scope all lookups and joins. Record durable download and outbound send work and its recovery state.
- Extend conversation queries and events so attachment changes refresh the correct view. Keep pagination and existing text-only messages working. Ensure connection identity is preserved when multiple connections or numbers are present; do not infer ownership from the remote number alone.
- Make the migration additive, rerunnable and compatible with the shared database. Rehearse with a synthetic shared schema and test existing write paths; do not copy production data locally. Deployment, migration and Twilio configuration changes require their own authorization.
- Expose operational failures without logging file contents, private fetch tokens or credentials. Provide a way to retry failed downloads and clean up expired uploads, while preserving records needed for investigation and reconciliation.

## Alternatives considered

- **Store only Twilio media URLs:** less infrastructure, but introduces a runtime dependency on Twilio media availability and credentials, and does not give the app direct control of retention and backups.
- **Use a public bucket for all media:** simple for Twilio to fetch, but unsuitable for potentially sensitive dispatch documents. A scoped temporary fetch URL over private storage limits exposure.
- **Build a separate MMS inbox:** duplicates conversation and unread behavior and makes a single exchange harder to follow.
- **Support all file types immediately:** increases security and carrier compatibility work without a confirmed need. Images provide a bounded first release.

## Consequences and open decisions

The app gains useful photo messaging but also takes responsibility for media storage, access control, cleanup and recovery. Outbound URLs are bearer credentials during their validity period and cannot prevent someone who obtains one from accessing the corresponding file until expiry. Provider acceptance does not guarantee carrier delivery. Inbound files can contain sensitive or hostile content; metadata validation alone is not malware scanning.

Before implementation or production activation, decide the storage location and backup ownership, retention period, acceptable inbound size and quotas, and whether PDFs are needed. Confirm actual MMS capability, account and registration status, geographic support, and applicable charges for the chosen number and destinations. Confirm the existing webhook route and media authentication behavior for each connection without changing remote settings automatically.

## Verification and rollout

1. Test signed and unsigned webhooks, image-only and captioned messages, multiple incoming attachments, duplicate events, failure/retry/restart behavior, reconciliation, malicious URLs and files, workspace isolation, and existing SMS behavior. Test upload limits, expired tokens, repeated `HEAD`/`GET`, cross-workspace access, callbacks and unknown outbound outcomes.
2. Rehearse the additive migration against an isolated synthetic database on the deployment host; verify a backup and rollback compatibility. Test persistent storage and restoration separately. Deploy the receive and send stages only when separately authorized.
3. Verify the deployed configuration and signed webhook paths without changing routing. With explicit authorization, send a real image to and from the intended number and supported destination, inspect Twilio status and the app conversation, and distinguish carrier delivery from API acceptance. Record remaining provider or carrier limitations.
