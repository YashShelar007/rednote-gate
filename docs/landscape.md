# Landscape

Checked 2026-10-06. Every row cites the commit that was read. Stars come from the GitHub API on that date. Re-check before quoting any of this in the README.

## Summary

Nine RedNote automation projects were read. Six can write to an account. None of the nine enforces a per-item human approval in code. Four ask for one in agent instructions, which an agent can skip. One project (mimi17-shq) already does write idempotency and crash recovery well. None enforces a daily write budget on the write path.

## What exists

| Project | Lang | Stars | HEAD read | Writes | Human approval | Idempotency or ledger | Budget on write path | Captcha |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | Go | 16,124 | a5c8f77, 2026-09-22 | publish, video, comment, reply, like, favorite, notification replies | Skill text only (`skills/post-to-xhs/SKILL.md:207`) | Skips an already-set like or favorite | No. README advises about 50 posts a day | None found |
| [sykuang/rednote-mcp](https://github.com/sykuang/rednote-mcp) (npm `@sykuang/rednote-mcp` 1.1.0) | TS, Playwright | 4 | 7e87754, 2026-07-27 | publish, video, comment, reply, like, favorite | Skill text only (`skills/operations/SKILL.md:30`) | No | No | None found |
| [iFurySt/RedNote-MCP](https://github.com/iFurySt/RedNote-MCP) (owns npm `rednote-mcp` 0.2.3) | TS | 1,117 | 74bf739, 2025-05-11 | None. Read only | n/a | n/a | n/a | None found |
| [JonaFly/RednoteMCP](https://github.com/JonaFly/RednoteMCP) | Python | 128 | 619d394, 2025-04-18 | One template comment tool. Posts immediately | No | No | No | None found |
| [chenningling/RedBook-Search-Comment-MCP](https://github.com/chenningling/RedBook-Search-Comment-MCP) | Python | 44 | e6efe25, 2025-04-23 | Same as JonaFly. A derivative | No | No | No | None found |
| [yangsijie666/xiaohongshu-crawler](https://github.com/yangsijie666/xiaohongshu-crawler) | Python | 21 | 59abbe2, 2026-02-28 | None. Read-only crawler | n/a | n/a | Random delays only | None. Uses stealth plugins |
| [DeliciousBuding/xiaohongshu-skill](https://github.com/DeliciousBuding/xiaohongshu-skill) | Python | 42 | afa9680, 2026-08-24 | publish (4 kinds), comment, reply, like, collect | Skill text, per item, in chat (`SKILL.md:34`). Publish stops before the final click unless `--auto-publish` is passed. Nothing checks who passed it. Comment and like run at once | No key. Publish reports confirmed, unconfirmed or failed | Quotas defined. Only planning commands check them (`scripts/sop.py`) | Detects, raises, stops |
| [mimi17-shq/xiaohongshu-mcp-reliable](https://github.com/mimi17-shq/xiaohongshu-mcp-reliable) | Go | 2 | 4454899, 2026-10-05 | As xpzouying, as async tasks | No | Yes. Idempotency key, 10 minute content-hash dedupe (`publish_tasks.go:22`), durable task files, a crash marks the task `unknown` and it is not retried | No | None found |
| [estelledc/xiaohongshu-publish](https://github.com/estelledc/xiaohongshu-publish) | Markdown skill | 0 | 45c355d, 2026-08-15 | publish or update a note only | Skill text. A one-time summary confirmed just before the final click (`skills/xiaohongshu-publish/SKILL.md:188`). Tests only check the wording exists | No retry on an unknown result | No | Stops, hands to the user |

Notes:

- The brief's "Python approval-gated skill under the topic `rednote`" is DeliciousBuding/xiaohongshu-skill. Its gate is an instruction to the agent, not code.
- sykuang/rednote-mcp describes itself as a Node and Playwright port of xpzouying/xiaohongshu-mcp.
- The topic `rednote` held 195 repos on 2026-10-06. Only the ones above were read.

## What this project adds

1. **A per-item approval gate enforced in code.** Write tools only enqueue. Nothing reaches the browser until a human clicks Approve on that item in a local page. Of the nine projects read, none does this in code. The four that ask for approval do it in prompt text.
2. **A daily write budget on the write path.** Default 5 writes a day and 1 comment every 10 minutes. Derived from the ledger so it survives a restart. None of the nine enforces a budget where the write happens.
3. **A human-readable ledger.** One `ledger.jsonl` line per attempt with the outcome and a screenshot path. Credit where due: mimi17-shq already solves idempotency and crash recovery. Its rule that an uncertain result becomes `unknown` and is never retried is the right model to borrow. This project's addition is the audit trail a stranger can read, not idempotency itself.

Stopping on a captcha is a guardrail here, not a selling point. DeliciousBuding and estelledc already stop.

## What it deliberately does not do

- Post anything without a human click on Approve. No approval in chat.
- Support more than one account, one browser context, or concurrent writes.
- Bulk post, or schedule posts nobody is watching.
- Solve captchas, or retry after a captcha or a "too frequent" warning.
- Favorite, follow or message. Writes are post, draft, comment, reply and like. Likes were added on 2026-10-06, after this research: `rednote_like_note` goes through the same approval page and has its own daily cap, 10 by default.
- Run the account in a cloud browser. See the Firecrawl result below.
- Touch a primary or brand account.

Known limit: an agent with its own browser tool on the same machine could open the approval page and click Approve. The run sheet's `@playwright/mcp` is exactly such a tool. Code cannot fully prevent this. The defence is process: never load a browser MCP in the same client session as this server.

## Firecrawl experiment (2026-10-06, about 20 of the 60 minutes)

Question: can a logged-in RedNote session live in a Firecrawl named profile, and do search and note pages come back readable?

How profiles work (docs.firecrawl.dev/features/interact and /capabilities, read 2026-10-06): profiles are cloud only. A profile is filled by a scrape with `saveChanges: true`, then an Interact session where you log in, then stopping it. The MCP scrape tool can only load a profile, not save one. You supply the target site's login.

Logged-out results, no profile:

| Page | Result |
| --- | --- |
| `search_result?keyword=奖学金` | Login wall. Only "登录后查看搜索结果" and the QR modal |
| `/explore` | Readable. Lists note links in two forms: bare `/explore/<id>` and one with `xsec_token` |
| Note with `xsec_token` | Readable: title, body, tags, date, region, like, collect and comment counts. Comments stay at "加载中" |
| Same note, bare URL | Redirect to `/404` with `error_code=300031`, plus a **slider captcha** |

Logged-in half: **not tested.** It needs you to log in through Firecrawl's live browser view with the throwaway phone.

Recommendation: drop it. Even if it works, it breaks two guardrails:

- A cloud profile is a second browser context for the same account, from a different IP and fingerprint than the local Playwright that does the writes.
- The session, a credential, would sit on a third party's servers.

Read tools stay on local Playwright.

First friction record for `docs/friction.md`: on 2026-10-06 a bare note URL with no `xsec_token` produced a 404 page and a slider captcha. The scaffold's `search()` can return bare URLs, because its card selector matches both link forms.

## Stagehand and Phase 4

Read 2026-10-06. Sources: github.com/browserbase/stagehand at 7abca76 (main), tag `@browserbasehq/stagehand@3.7.3` (3554b02), and docs.stagehand.dev v3 and v4 pages on caching, act, observe and browser config. MIT. npm `latest` is 4.1.0.

- **v3 caching:** a local `cacheDir` with one JSON file per key. Each file stores absolute XPath actions. The key hashes the instruction, URL and variable keys. A hit needs no LLM.
- **v3 self-heal:** on by default. When a cached XPath fails, it re-snapshots the accessibility tree, asks the LLM again, retries, and overwrites the cache file.
- **v4:** caching is server side on Browserbase and has no effect with a local browser. v4 has no Playwright interop.
- **Repair output:** no version writes a repaired selector into source code, produces a reviewable diff with evidence, or opens a PR.
- **Element choice:** both versions use the accessibility tree. `observe()` returns absolute XPaths.

Preliminary verdict: a gap remains. That gap is a repair step with no LLM in the runtime path that proposes a CSS or role selector for `SEL` and opens a PR with evidence. Stagehand's method is worth borrowing for it: accessibility snapshot, element-id-to-XPath map, model picks the element. Decide for real only after Phases 1 to 3, as the brief says.

## Name

`rednote-mcp` belongs to iFurySt on npm. Checked 2026-10-06 against registry.npmjs.org (404 means free) and GitHub repository name search:

| Name | npm | GitHub repos with that name |
| --- | --- | --- |
| `rednote-gate` | free | none |
| `rednote-outbox` | free | none |
| `rednote-airlock` | free | none |
| `xhs-outbox` | free | none |
| `xhs-gate` | free | taken (Captainkk1/xhs-gate) |

Chosen 2026-10-06: `rednote-gate`.

"RedNote" is the platform's trademark. Existing packages use it, but it is still a risk worth knowing about. A scoped name such as `@<your-npm-user>/rednote-gate` is a fallback if the unscoped name gets taken.
