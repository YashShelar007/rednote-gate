# Changelog

## [Unreleased]

### Added
- Dashboard: today's usage as meters on the approval page, and a Settings page for mode, daily limits, comment gap and notifications. Changes apply live, without a restart.
- `data/settings.json`, checked against hard maximums (20 writes, 50 likes, comments at least 2 minutes apart). Switching to live needs a confirmation tick.
- Install from npm: `npm install -g rednote-gate`, then `rednote-gate setup`.
- `rednote-gate` command. With no arguments it runs the MCP server. Subcommands: `setup`, `login`, `connect`, `live`, `dry`, `stop`, `approve`, `status`, `doctor`, `help`.
- `rednote-gate doctor`: offline checks for Node, Chromium, login, settings, ledger and the service. It never contacts RedNote.
- `rednote-gate connect` also prints the config for Claude Desktop and Codex.
- `RN_HOME` sets where data and the login live.

### Changed
- Data and login now live in `~/.rednote-gate` by default. A clone that already has `.session/` keeps using its own folder, so existing installs keep working. `RN_DATA_DIR` and `RN_SESSION_PATH` still override.
- `rednote-gate live` and `dry` (and `npm run live|dry`) write the mode into `settings.json` instead of re-registering the server with Claude Code. `live` asks for confirmation, or takes `--yes`.
- `npm run setup|login|connect|live|dry|stop|approve` now run the `rednote-gate` command.
- The package bin is `dist/cli.js`. The npm package ships compiled code, README, LICENSE and CHANGELOG only.

### Security and safety
- New data folders are created owner-only (0700).
- `rednote-gate stop` only signals the pid in the lock file after checking it is the rednote-gate service, so a stale lock never stops another program.

## [1.0.0] - 2026-10-06

First public release. Every flow below was checked against the live site on 2026-10-06 with a rednote.com account; see the "Last verified" table in the README.

### Added
- MCP server for Claude Code, Claude Desktop and Codex, for one throwaway RedNote account (xiaohongshu.com or rednote.com).
- Reads: login status, search, read a note, read comments, list your own notes.
- Writes, each queued for a human Approve click: photo notes with up to 9 images, linked topics and emoji; drafts; video notes; comments; replies; likes.
- Approval page on 127.0.0.1 that opens by itself, shows exactly what will be sent, gives 30 seconds to cancel, and shows a screenshot of every attempt. Mac notifications.
- Text-card images rendered locally for notes without photos.
- Workflows as slash commands: post_from_concept, post_photos, reply_to_comments, research_topic, review_queue, help.
- `rednote_help`: every tool and workflow, the current mode, and what is left of today's budget.
- `npm run setup`, `npm run live`, `npm run dry`, `npm run stop`.

### Security and safety
- Nothing is published, sent or liked without a human click on Approve, enforced in code. An approval only runs in the mode (dry run or live) it was given in.
- Daily limits enforced from an append-only ledger that survives restarts: 5 writes, 10 likes, one comment every 10 minutes.
- A captcha or "too frequent" warning stops everything until a human resumes. No retries, no captcha solving.
- Every field is read back before the final click; replies only go to a comment whose author and text still match.
- Approval page: Host check, per-start token, same-origin POSTs, strict CSP, no framing.
- Session file and approval link are owner-only (0600) and never returned to the MCP client.

### Known limits
- Browser automation is against RedNote's terms; the account can be banned. Use a throwaway account.
- Drafts saved on RedNote's website stay in rednote-gate's browser; they do not reach the phone app.
- Selectors will drift as RedNote changes its pages; fixes go in `SEL` in `src/rednote.ts`.
