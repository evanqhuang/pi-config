---
name: code-review
description: Use the single pi-code-review extension for one-shot reviews or the bounded initial/delta/final managed review lifecycle.
compatibility: Requires the installed pi-code-review package and gh for pull-request targets.
---

# Code review

Use `code_review` as the only code-review authority. Do not recreate finder
fan-out, verification, a review loop, or a reviewer subagent in the parent
conversation.

## One-shot review

For a normal report-only review, call `code_review` once with `action=run` and
the requested target. Publishing requires explicit user authorization through
`comment=true`.

## Managed implementation review

When an approved managed plan is active, pass its `planPath` (or allow the tool
to discover it from session context) and use `phase=auto`.

The lifecycle is fixed:

1. one comprehensive initial review;
2. one focused remediation-delta review;
3. at most one focused final confirmation review.

The implementation must be committed and the worktree clean before each managed
pass. Never request a fourth pass or reset automatically.

A managed run returns stable finding IDs, a session ID, and an exact reviewed
snapshot hash. Treat findings as candidate evidence only. The primary agent must
inspect changed lines, guidance, history, tests, and current intent and establish
that a candidate is introduced, reachable, impactful, contract-violating, and
evidenced before it can block.

Record every candidate with `action=record`, the exact session/snapshot values,
and one disposition:

- `confirmed-blocker`
- `non-blocking`
- `accepted-risk`
- `product-decision`
- `follow-up`
- `not-reproducible`
- `resolved`

A confirmed blocker requires concise parent evidence. P0/P1-equivalent
critical/high findings with high confidence may block. Medium findings block
only when deterministic and explicitly contract-based. Low, plausible,
medium/low-confidence, style, speculative, intentional, pre-existing, and
check-caught concerns do not block.

Fix all confirmed blockers in one coherent remediation commit, run relevant
checks, and call `code_review` again with `phase=auto`. If the final pass still
has a blocker, stop for architecture or product attention.

Use `action=status` to inspect the current lifecycle without running reviewers.
Use `action=reset` only with explicit user authorization and
`confirmReset=true`.
