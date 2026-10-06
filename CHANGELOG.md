# Changelog

## [1.0.0] - 2026-10-06

First public release. Every flow below was checked against the live site on 2026-10-06 with a rednote.com account; see the "Last verified" table in the README.

### Added
- MCP server for Claude Code, Claude Desktop and Codex, for one throwaway RedNote account (xiaohongshu.com or rednote.com).
- Reads: login status, search, read a note, read comments, list your own notes.
- Writes, each queued for a human Approve click: photo notes with up to 9 images, linked topics and emoji; drafts; video notes; comments; replies; likes.
- Approval page on 127.0.0.1 that opens by itself, shows exactly what will be sent, gives 30 seconds to cancel, and shows a screenshot of every attempt. Mac notifications.
- Text-card images rendered locally for notes without photos.
- Workflows as slash commands: post_from_concept, post_photos, reply_to_comments, research_topic, review_queue.
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
