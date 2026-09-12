# Long-horizon scenario set

The harness runs each scenario twice from the same Git baseline: first with
`pi-notes` omitted, then with `pi-notes` loaded. The task-specific prompt is
followed by the runner's common completion protocol.

Every scenario is intentionally cross-layer. A successful run should inspect
the existing architecture, implement the feature, add focused and regression
coverage, run the repository's prescribed verification commands, and update
documentation. The agent must not commit changes.

The eight scenarios cover:

1. Saved due-diligence case files
2. County-record refresh reliability
3. Recorded-document search review
4. Owner-request lifecycle
5. Durable agent-task operations
6. Screening-run comparison and retry
7. Source provenance and drift
8. Deterministic investigation bundles
