# Saved Due-Diligence Case File

Use this exact prompt for every replicate and both arms:

> Implement a production-ready **Saved Due-Diligence Case File** workflow for the Records Dashboard.
>
> An authenticated user should be able to create and manage a case file associated with a property. Each case file contains:
>
> - title and property identity
> - status: `draft`, `in_progress`, or `complete`
> - checklist items with completion state
> - findings/notes
> - source URLs and documents
> - created, updated, and completed timestamps
>
> Requirements:
>
> 1. Inspect the existing application architecture and follow its current patterns.
> 2. Add typed domain models and runtime validation.
> 3. Add authenticated CRUD API behavior using the project’s existing persistence layer.
> 4. Enforce user/property authorization and prevent cross-user access.
> 5. Add create/open/edit flows from the existing property experience.
> 6. Add loading, empty, validation-error, save-error, and success states.
> 7. Add deterministic export of a case file as JSON and Markdown.
> 8. Preserve existing behavior and styling conventions.
> 9. Add unit, integration, and UI coverage for happy paths, invalid input, authorization, persistence, and export.
> 10. Update relevant documentation.
>
> Do not modify the pi-notes extension. Work through the entire feature, run the focused tests, full test suite, typecheck, build, and fix regressions before reporting completion. Do not stop after the first passing test.

Run each arm from the same clean commit and a fresh top-level Pi session. Load
`pi-eval-metrics` in both arms; load `pi-notes` only in the Notes-present arm.
Arm, replicate, task, model, and revision metadata are inferred automatically.
