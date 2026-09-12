# Failure and recovery hardening

<!-- repository: hostelhawk -->

Harden an existing asynchronous HostelHawk workflow by finding a real failure
path, reproducing it deterministically, and carrying the repair through to a
verified recovery. Prefer a workflow that crosses scraper, database, API, and
UI boundaries.

Requirements:

1. Inspect existing tests, fixtures, worker leases, retry policy, error
   projection, and user-facing recovery states before selecting the target.
2. Identify a concrete malformed-input, Hostelworld failure, stale-price,
   duplicate-job, database-pool, or scheduler-recovery path that is not
   adequately covered.
3. Add a failing regression test that demonstrates the problem without
   weakening or skipping existing checks.
4. Implement the smallest complete fix, preserving idempotency, price-history
   integrity, provenance, bounded retries, and health semantics.
5. Exercise at least one unsuccessful repair hypothesis or neighboring failure
   condition and use the resulting evidence to refine the implementation.
6. Verify recovery from the original failure and ensure a repeated retry does
   not duplicate work or corrupt state.
7. Add operational diagnostics or documentation that make the failure
   actionable, then run focused and full applicable checks to a clean result.
