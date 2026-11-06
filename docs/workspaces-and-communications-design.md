# Workspaces and communications integrations

## Scope and outcome

Iron Wing and, later, Kelevo are independent workspaces operated by the same signed-in operator. Each workspace owns its contacts, numbers, conversations, call history and unread state. A workspace can have multiple saved provider connections and numbers. Twilio is the first provider; a provider boundary must not imply unsupported parity across providers.

The current delivery covers **(1) workspaces and safe assignment of existing Iron Wing data** and **(2) saved Twilio connections and number selection**. Creating the Kelevo connection, exercising live calling and messaging for both brands, automated customer support, and multi-user tenancy are future work. The current operator login remains shared and must never be described as tenant isolation.

Implementation status: **code complete for the first delivery, not yet activated**. Implemented and covered by tests: the additive schema, credential encryption, read-only Twilio validation, the settings API, workspace-scoped reads and writes, per-connection signed webhooks, per-connection reconciliation and checkpoints, multi-device Voice registration, the workspace switcher with scoped unread counts, and the Settings screen (create workspace, validate and save a connection, update credentials, add numbers, select the active number). Changing the connection or number pauses the browser phone and re-registers it automatically if it was connected.

Not yet done: applying migration 005 and setting `WORKSPACE_CREDENTIALS_KEY` in the target environment; a real webhook configuration check (Settings currently states that routing is not verified); removing or renaming workspaces, connections and numbers without losing history; and automated tests for the Settings screen and multi-device Voice logic. Nothing has been deployed or exercised against live Twilio. Do not deploy until the activation steps and a rehearsal on an isolated database are complete.

## Interaction

The existing top-left brand area contains the workspace switcher. The sidebar has a dedicated Settings screen for workspaces and connections; audio settings remain in their current top-bar dropdown. Settings shows connection name, account identity, owned numbers, capabilities, active sender and configuration health without disclosing stored secrets. Credential fields are password inputs and are cleared after submission. Users can create a workspace, validate and save a Twilio account, select an owned voice/SMS number, and switch the active connection and number. An unsuccessful validation leaves the previous configuration intact. Deletion and credential rotation must not silently delete history, reconfigure remote resources, or strand webhooks.

Switching workspaces or a connection is disabled while a call is ringing, connecting, or active. Stop the old browser Voice device, invalidate in-flight operations, select the new connection, obtain a fresh token and register the new device. The exact sending number and connection are displayed before calling or messaging. An incoming call for a non-selected workspace must remain receivable and explicitly identified, or the UI must clearly report the limitation; never claim this capability without implementing and testing it. Unread badges are workspace-scoped, with an indication for other workspaces.

## Data model and ownership

- `workspaces`: stable UUID and display name. The existing Iron Wing workspace receives a fixed bootstrap identity so migration is repeatable.
- `provider_connections`: workspace ID, provider, display name, provider account identifier, encrypted credential envelope, status and timestamps. Enforce unique provider account ownership or explicitly model shared-account routing; reject ambiguous inbound routes.
- `connection_numbers`: connection ID, provider number SID, E.164 number, capabilities and activation state. A single selected outgoing number is explicit; number ownership and assignment are validated against the provider.
- Calls and messages carry workspace ID and connection ID, and retain provider identifiers for idempotency. Phone contacts carry workspace ID. Imported history, delivery records, call legs and read state remain associated with their original workspace and connection; joins and all search and pagination queries apply workspace scope. A phone number by itself does not identify a workspace across accounts.
- A conversation is identified by workspace, connection, local number and remote number; identical external numbers across workspaces or local lines remain separate. Existing historical numbers retain their associations rather than being reassigned to a new connection.
- Provider sync checkpoints and asynchronous events are per connection, not process-global. Webhook routing uses an unambiguous public connection identifier plus the provider account/number, and validates the signature using that connection's secret before storing anything. Invalid, ambiguous or unconfigured routes fail closed.

The database is currently shared with `iwd-backend`. Expand it additively, preserving existing IDs, foreign keys and compatibility with its Prisma migrations and writes. The migration is transactional, rerunnable and backfills **all existing Iron Wing records** without changing their meaning. Any write path outside this app that can create shared rows must receive a compatible Iron Wing default or be updated in coordination with its owner. Do not transfer production data into development; rehearse against a synthetic database with the existing schema, then verify live separately after an authorized deployment.

## Credentials and provider boundary

Encrypt Twilio Auth Tokens and API Key secrets using authenticated encryption with a dedicated randomly generated server-side encryption key held outside the database. Version the encrypted envelope and bind it to the connection identity as associated data. Never return secrets in reads, put them in browser storage, logs, Git, URLs or screenshots, or reuse the app login password as an encryption key. Key backup, rotation and recovery must be documented; losing the key makes encrypted credentials unrecoverable. A missing or invalid key prevents writes and never falls back to plaintext. Existing environment credentials must continue to work until explicitly migrated, and startup must fail clearly instead of silently switching accounts.

Validation uses read-only Twilio requests and checks account credentials, API key/secret and TwiML application ownership, number ownership and capabilities. Webhook validation still requires the account's Auth Token; Voice SDK tokens require the appropriate API key and TwiML application. Validation must not create resources, update phone-number routing, place calls or send messages. Display the required webhook URLs and their status; do not change Twilio routing automatically without a concrete review and authorization. Registration/approval and regional messaging requirements remain provider-side prerequisites.

Twilio's incoming number or Messaging Service and TwiML App can route to the app using connection-specific signed URLs. Old and new account credentials can coexist, so inbound events from inactive selections are still authenticated and stored. Remote webhooks and connections must not be removed merely because the operator changes the selected workspace.

## Consistency and recovery

All data queries and mutations must take explicit workspace context; the selected workspace in the browser is a convenience, not an authorization boundary. Per-connection reconciliation paginates, uses durable checkpoints and overlap, and only advances on a complete successful run. Callback updates are idempotent and tolerate duplicates and out-of-order statuses. Server-sent events must refresh the correct workspace and reconnect safely. Background operation must continue for every enabled connection, not only the one selected in a browser.

## Future: Kelevo, automation and tenant isolation

Kelevo onboarding comes after the current implementation is complete and explicitly authorized; do not create a Kelevo account or configure Twilio now. Later, support automation should have explicit knowledge sources, escalation, audit history, sending limits and human control; it must not silently access Iron Wing data or take actions in Kelevo TMS. Multi-tenancy requires real users, authenticated sessions, workspace membership and roles, enforced authorization across every endpoint and webhook, tenant-safe secrets and jobs, and a separate security review. The current single shared login is not multi-tenancy.

## Verification and rollout

Test migration from a realistic synthetic shared schema, repeatability, legacy backend compatibility, scoped reads/writes and duplicate/ambiguous routing, signed/unsigned webhooks, credential encryption and redaction, failed validation and rotation, per-connection sync and unread counts, navigation, active-call switching guard, and real browser device behavior using fakes. Use synthetic Twilio APIs and never place calls or send SMS without explicit instruction. Rehearse migration on an isolated database on the deployment host before any authorized production migration; back up and verify rollback compatibility, deploy code and schema together, then verify the running app and callbacks separately. No deployment or external Twilio changes are part of writing this design.
