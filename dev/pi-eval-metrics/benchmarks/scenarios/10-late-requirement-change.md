# Late requirement change

<!-- repository: hostelhawk -->

Implement a saved hostel-price alert that initially appears to be a
straightforward authenticated feature, then incorporate the compatibility
constraint below after establishing the existing design and implementation
path.

Initial requirements:

1. Add typed alerts tied to a hostel, stay dates, occupancy, room preference,
   currency, and target nightly price.
2. Support create, pause, resume, update, delete, list, and detail operations.
3. Build the corresponding hostel UI with complete loading/error/conflict
   states and focused web, database, and UI tests.

Late compatibility constraint (treat this as newly discovered after completing
the initial architecture inspection):

4. Existing persisted watch records and API clients cannot be migrated or
   broken. They may omit currency and occupancy, use the legacy `enabled`
   boolean, and send requests without a revision field. Preserve read
   compatibility while all newly written records use the canonical schema.
5. Concurrent legacy and canonical clients must remain safe: normalization,
   compare-and-swap behavior, idempotency, authorization, and response shapes
   need explicit coverage.
6. Revisit earlier design decisions after applying the constraint, remove any
   obsolete assumptions, update documentation, and run the full applicable
   verification battery.
