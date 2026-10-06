# Spec: v1.1, npm package and dashboard (2026-10-06)

## Objective
Anyone can install rednote-gate with one npm command, and run it day to day from one page: approve writes, see activity, and tune limits and mode without editing config.

## Capability map

| Module id | Responsibility | Depends on |
| --- | --- | --- |
| `settings` | Limits, mode and toggles in one settings file, validated against hard maximums, read live | none |
| `dashboard` | The approval page grows Activity and Settings sections; settings change from the page | `settings` |
| `home` | Data and login live in `~/.rednote-gate` (a clone that already has `.session/` keeps using its own folder) | none |
| `cli` | `rednote-gate` command: no arguments runs the MCP server; `setup`, `login`, `connect`, `live`, `dry`, `stop`, `status`, `approve` | `home`, `settings` |
| `npm` | Publishable package: bin, files, prepublish tests, install docs | `cli` |

Build order: `settings`, then `dashboard`; `home`, then `cli`, then `npm`.

## Assumptions
1. Settings file `settings.json` in the data folder. Precedence: settings file, then environment variables, then defaults. The service re-reads it, so a change applies within one worker tick, without a restart.
2. Hard maximums that no setting can pass: 20 writes a day, 50 likes a day, comments at least 2 minutes apart. Defaults stay 5, 10, 10.
3. Switching to LIVE from the dashboard needs an explicit confirmation tick. Approvals stay bound to the mode they were given in.
4. `npm run live` and `npm run dry` (and `rednote-gate live|dry`) write the mode into the settings file instead of re-registering the MCP server.
5. `npm publish` is run by the owner (it needs the owner's npm login).

## Success criteria
- Settings: unit tests for defaults, env fallback, bounds and bad input; a change in the file applies to the next tick.
- Dashboard: tests for the settings form (token, same origin, bounds, live confirmation); checked by eye in light, dark and phone width.
- npm: `npm pack` contains only runtime files; a global install from the tarball runs `rednote-gate status` and starts the MCP server.

## Boundaries
- Always: tests first; nothing reaches RedNote without an Approve click.
- Never: settings above the hard maximums; secrets in the package; publishing to npm without the owner.
