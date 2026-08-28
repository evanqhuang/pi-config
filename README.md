# Pi configuration

Version-controlled Pi configuration, extensions, agent profiles, and local Pi
packages. The repository is designed to live directly at `~/.pi/agent`, so the
tracked tree is the active Pi installation rather than a separately copied
mirror.

## Repository layout

| Repository path | Purpose |
| --- | --- |
| `agents/` | Global agent profiles |
| `dev/` | Local Pi packages and extensions under development |
| `extensions/` | Standalone Pi extensions |
| `tests/` | Focused integration tests for custom extensions |
| Root JSON files | Pi settings and extension configuration |

Generated dependencies, credentials, sessions, plans, history, caches, backups,
and other machine-local runtime state are excluded by `.gitignore`.

## Installing on another machine

Clone directly into the Pi agent directory, then install package dependencies:

```sh
git clone git@github.com:evanqhuang/pi-config.git ~/.pi/agent
npm install --prefix ~/.pi/agent/dev/pi-code-review
npm install --prefix ~/.pi/agent/dev/pi-plan-mode
npm install --prefix ~/.pi/agent/dev/pi-subagents-local
```

If `~/.pi/agent` already contains runtime state, back it up first, clone the
repository, and restore only ignored private/runtime files. Do not commit
credentials, session history, managed plans, caches, or generated dependencies.
