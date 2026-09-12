# Durable agent-task operations console

Create an operator-facing task console for the dashboard's durable agent-task
queue. It should make queued work observable and safely actionable without
allowing an operator to corrupt leases or bypass domain authorization.

Requirements:

1. Trace the existing task schema, claim/lease implementation, retry/cancel/
   priority routes, domain-event projection, and admin/user authorization.
2. Add a typed task summary and filtered list/detail API with stable pagination,
   status/priority/type filters, safe error categories, and no secret payloads.
3. Add guarded cancel, retry, reprioritize, and reclaim actions with CAS,
   lease ownership checks, idempotency, and audit metadata.
4. Build a usable UI with polling, stale-lease indication, action confirmation,
   optimistic conflict handling, empty/loading/error states, and retry guidance.
5. Preserve task payload privacy and never expose credentials, raw provider
   errors, or another user's task data.
6. Add unit, integration, and UI tests for pagination, races, expired leases,
   duplicate actions, authorization, terminal states, and event projection.
7. Update operator documentation and run the complete applicable verification
   battery, fixing regressions rather than merely describing them.
