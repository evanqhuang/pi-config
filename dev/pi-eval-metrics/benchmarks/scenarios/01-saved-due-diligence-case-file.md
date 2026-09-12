# Saved Due-Diligence Case File

Implement a production-ready Saved Due-Diligence Case File workflow for the
Records Dashboard. An authenticated user should be able to create and manage
a case file associated with a property.

Each case file needs a title and property identity, status (`draft`,
`in_progress`, or `complete`), checklist items with completion state,
findings/notes, source URLs and documents, and created/updated/completed
timestamps.

Requirements:

1. Follow the existing application and styling patterns.
2. Add typed domain models and runtime validation.
3. Add authenticated CRUD using the existing persistence layer.
4. Enforce user/property authorization and prevent cross-user access.
5. Add create/open/edit flows from the existing property experience.
6. Implement loading, empty, validation-error, save-error, conflict, and
   success states.
7. Add deterministic JSON and Markdown export.
8. Add unit, integration, and UI coverage for happy paths, invalid input,
   authorization, persistence, and export.
9. Update relevant documentation and preserve existing behavior.
