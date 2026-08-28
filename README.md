# Pi configuration

Version-controlled custom Pi configuration, extensions, agent profiles, and
local Pi packages.

## Repository layout

| Repository path | Pi location |
| --- | --- |
| `config/` | `~/.pi/agent/` |
| `agents/` | `~/.pi/agent/agents/` |
| `extensions/` | `~/.pi/agent/extensions/` |
| `packages/` | `~/.pi/agent/dev/` |
| `tests/` | Focused tests for the custom extensions |

The checked-in `config/settings.json` references the local packages under
`~/.pi/agent/dev/`:

- `pi-code-review`
- `pi-plan-mode`
- `pi-subagents-local`

## Restoring on another machine

Copy or symlink each repository directory to the matching location in the
mapping above, then install dependencies in each local package:

```sh
npm install --prefix ~/.pi/agent/dev/pi-code-review
npm install --prefix ~/.pi/agent/dev/pi-plan-mode
npm install --prefix ~/.pi/agent/dev/pi-subagents-local
```

Pi's generated and private state is intentionally not tracked: authentication,
trusted-project state, session/history/plan data, model catalog caches, and
installed dependency directories.
