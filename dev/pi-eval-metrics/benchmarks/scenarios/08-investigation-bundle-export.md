# Deterministic investigation bundle export

Create a production-ready investigation bundle for a watched property. The
bundle should collect selected property, county, recorded-document, screening,
owner-request, and provenance evidence into a deterministic JSON and Markdown
artifact suitable for review and download.

Requirements:

1. Follow existing export, provenance, auth, persistence, and property-page
   patterns; identify which records are optional, pending, blocked, or stale.
2. Add a typed export contract and stable schema version. The same logical
   snapshot must produce byte-identical JSON and semantically stable Markdown.
3. Capture the exact source/revision/fetched-at metadata for included evidence,
   exclude secrets and raw provider credentials, and clearly label unresolved
   or manual-review items.
4. Make generation safe for large bundles with a durable task or streaming
   boundary as appropriate, idempotent request identity, and conflict handling
   when the property changes during generation.
5. Enforce authentication and property ownership on request, status polling,
   and artifact download with indistinguishable unauthorized responses.
6. Add UI for selecting evidence, queued/running/complete/blocked/failed
   states, deterministic download, retry guidance, and empty/unavailable cases.
7. Add unit, emulator integration, and UI coverage for ordering, redaction,
   stale/partial evidence, authorization, retries, concurrent edits, and
   repeat-export determinism. Update docs and run every applicable gate.
