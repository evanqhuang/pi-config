# Owner-request lifecycle

Harden the property owner-request workflow from draft through reconciliation.
The feature must let an authorized user prepare a request, send it through the
existing mail/outbox boundary, receive or reconcile a response, and recover
from retries or concurrent edits.

Requirements:

1. Inspect the current owner-request state machine, Firestore persistence,
   mail outbox, authz helpers, and established property UI conventions.
2. Define and validate the complete lifecycle: draft, ready, sent, received,
   needs-reconciliation, reconciled, cancelled, and terminal failure where
   appropriate.
3. Make send/retry/reconcile operations idempotent with compare-and-swap,
   outbox deduplication, bounded retry behavior, and clear conflict responses.
4. Prevent cross-user/property access and avoid leaking whether another
   user's request exists.
5. Add the property request list/detail/editor UI with loading, empty, invalid,
   conflict, unavailable, success, and retry states.
6. Add unit, emulator integration, and UI tests for transitions, authorization,
   duplicate delivery, concurrent updates, outbox failure, and reconciliation.
7. Document operational semantics and run focused/full tests, typecheck, build,
   and lint before reporting completion.
