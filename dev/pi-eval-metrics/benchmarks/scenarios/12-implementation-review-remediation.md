# Implementation review and remediation

<!-- repository: hostelhawk -->

Choose one substantial, recently implemented HostelHawk workflow and
perform a two-stage implementation-plus-review task. The review must be
independent enough to catch omissions rather than merely restating the code
that was just written.

Requirements:

1. Inspect the repository and select a bounded workflow with meaningful API,
   persistence, authorization, UI, and test surfaces.
2. Implement one missing production-ready capability using established project
   patterns, including validation, conflict handling, failure states, tests,
   and documentation.
3. After the implementation passes focused checks, reset your perspective and
   audit the complete change against an explicit checklist: correctness,
   account isolation, stale/concurrent updates, idempotency, price provenance,
   accessibility, cache behavior, error recovery, and backward compatibility.
4. Trace every checklist item to concrete code and test evidence. Record
   unsupported or uncertain items as findings rather than assuming coverage.
5. Remediate all confirmed gaps found by the review and add regression tests
   that would have caught them before the audit.
6. Run the repository's full applicable verification gates after remediation
   and report the final evidence separately from the initial implementation
   result.
