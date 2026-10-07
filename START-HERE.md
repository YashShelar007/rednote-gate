# Start here

For a new contributor or a new AI coding session. Read this first, then [README.md](README.md).

## What this is

rednote-gate is a local MCP server for ONE throwaway RedNote account. Reads run directly. Writes go into a queue and wait for a human to click Approve on a local page. A worker in the same process then performs them, one at a time, inside a daily budget. Every attempt is logged.

## Rules

- Only ever use the dedicated throwaway account. Never a primary or brand account.
- Never load a browser MCP, such as `@playwright/mcp`, in the same client session as rednote-gate. An agent with a browser could click Approve.
- AI sessions never approve anything. Do not read `data/approval-url`, open the approval page or call its endpoints. Do not read or print `.session/state.json`. Approval is the human's job.
- Do not add any path that posts without an approved queue item. Do not add retries after `unknown` or after a block.
- Every DOM selector lives in the `SEL` object in `src/rednote.ts`. Nowhere else.
- Nothing touches the live site unless a human is watching and following [PROTOTYPE-RUNSHEET.md](PROTOTYPE-RUNSHEET.md).
- Docs style: short sentences, plain English, no em dashes or en dashes.

## File map

| Path | What it is |
| --- | --- |
| `src/cli.ts` | The `rednote-gate` command and the package bin. No arguments runs the MCP server (`index.ts`). Subcommands: setup, login, connect, live, dry, stop, approve, status, doctor, help. |
| `src/home.ts` | Where data and the login live: `RN_HOME`, else a clone that already has `.session/`, else `~/.rednote-gate`. |
| `src/index.ts` | MCP stdio entry point, kept thin. Registers the tools and workflow prompts. Writes go to the queue; reads go to the service, which it starts if needed. |
| `src/queue.ts` | The queue. One JSON file per write. Image checks, copying and hashing. Status changes. Duplicate check. |
| `src/ledger.ts` | Append-only `ledger.jsonl`. Budget and halt state are worked out from it. |
| `src/worker.ts` | Takes the oldest approved item that fits the budget. Writes the ledger lines around each attempt. |
| `src/service.ts` | The long-running service: owns the lock, the browser, the approval page, the worker and notifications. Started on demand by `index.ts`; `rednote-gate stop` stops it. |
| `src/config.ts` | Paths, limits, mode, version and the service probe. Shared by `index.ts`, `service.ts` and `cli.ts`. |
| `src/approval.ts` | The approval page on 127.0.0.1. Token, Host and origin checks. Approve, Reject, Cancel, Resume. |
| `src/rednote.ts` | The browser flows and the `SEL` selectors. The only file that knows RedNote's pages. |
| `src/session.ts` | Playwright browser and the saved login session. |
| `src/login.ts` | `rednote-gate login`: the one-time QR login. |
| `src/*.test.ts` | Offline tests. `npm test` builds and runs them. They never touch RedNote. |
| `docs/landscape.md` | Research on other RedNote projects, checked 2026-10-06. Keep as is. |
| `docs/friction.md` | Dated log of captchas, walls and warnings seen on RedNote. |
| `PROTOTYPE-RUNSHEET.md` | How to verify each flow on the live site, with capture blocks. |
| `~/.rednote-gate/data/` | Runtime data: queue, ledger, settings, screenshots, approval link, lock. In a clone with an older login, `data/` in the clone (git-ignored). |
| `~/.rednote-gate/.session/state.json` | The saved login. A credential. In a clone with an older login, `.session/` in the clone (git-ignored). |

## How a write flows

1. The agent calls a write tool, for example `rednote_create_post`.
2. `queue.ts` checks the input. Images must be absolute paths to real JPEG, PNG or WebP files, 20 MB at most, 1 to 9 per note. It copies them into `data/queue/<id>/` and hashes them.
3. If an identical item is already `pending`, `approved`, `posting`, `posted` or `unknown`, it returns that id. Otherwise it writes `data/queue/<id>.json` with status `pending` and returns the new id. No browser is involved.
4. A human runs `rednote-gate approve` (or the page opens by itself), opens the page, reads the exact content and clicks Approve. The item becomes `approved`. Nothing is posted yet.
5. Every 10 seconds the worker reads the ledger. If halted, it does nothing. Otherwise it takes the oldest item that was approved at least 30 seconds ago (the undo window). In live mode the item must also fit the budget.
6. The worker writes an `attempt` line to the ledger, then marks the item `posting`. Only then does the browser start. This order means a crash still uses up budget and never leads to a second post.
7. `rednote.ts` runs the flow and takes a screenshot. It clicks the final button only when `RN_DRY_RUN=0` and the item was approved.
8. The item becomes `posted`, `dry_run`, `failed` (dry run error, or a live error before the final click) or `unknown` (live error after the final click). The worker writes a `result` line.
9. If RedNote showed a captcha or a "too frequent" warning, a `blocked` line is written. The worker stops and reads are refused until a human clicks Resume.
10. On the next start, any item still `posting` becomes `unknown` (live) or `failed` (dry run). A live one is never retried.

## How a read flows

The agent calls a read tool. It is refused if rednote-gate is halted, if another process holds the browser lock, or if a note URL has no `xsec_token`. Otherwise the browser opens the page and the tool returns the data. A captcha during a read halts rednote-gate the same way as during a write.

## What is verified (as of 2026-10-06)

- **Live site:** nothing. Every flow is "not yet verified" in the README table.
- **Offline:** `npm test` covers the queue, ledger, worker and approval page without RedNote.
- **Observed, logged out, through Firecrawl:** a bare note URL leads to a captcha, and the same note with `xsec_token` is readable. See [docs/friction.md](docs/friction.md).
- **Research:** [docs/landscape.md](docs/landscape.md).

The selectors in `SEL` came from reading other projects. None has been checked against the live site.

## What to do next

1. Make sure `npm run build` and `npm test` pass.
2. Do the read ladder in [PROTOTYPE-RUNSHEET.md](PROTOTYPE-RUNSHEET.md), headed, on the throwaway account.
3. Do the write ladder: publish, draft, comment, reply. Dry run first each time. One live write per evening at most, days apart.
4. After each flow: fill its capture block, fix `SEL` if needed, add any friction to [docs/friction.md](docs/friction.md), and update the "Last verified" table in the README with the date and result.
5. Later, not decided yet: a selector repair step that proposes a `SEL` fix with evidence for human review. See the Stagehand section in [docs/landscape.md](docs/landscape.md). Decide only after every flow has been verified.
