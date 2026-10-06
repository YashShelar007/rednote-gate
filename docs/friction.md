# Friction log

A dated log of anti-bot friction seen on RedNote: captchas, sliders, login walls, "too frequent" warnings, redirects. Newest entry at the bottom.

Add an entry every time something like this happens, even if it went away on its own. If rednote-gate halted, copy the `blocked` line from `data/ledger.jsonl` into the entry. If you changed code because of it, say what.

Template:

```
## YYYY-MM-DD: short title

- Where: the URL or page
- Account state: logged in or logged out
- How observed: rednote-gate tool, or another tool
- What happened:
- What worked instead:
- Ledger line: (if rednote-gate halted)
- Effect on code or process:
```

## 2026-10-06: bare note URL leads to a captcha

- Where: a note page, `https://www.xiaohongshu.com/explore/<id>` with no `xsec_token`
- Account state: logged out
- How observed: Firecrawl's scraper, not rednote-gate
- What happened: the bare note URL redirected to `/404` with `error_code=300031`. The page showed a slider captcha titled "Security Verification", with the prompt 拖动箭头完成拼图.
- What worked instead: the same note with its `xsec_token` was readable while logged out.
- Also seen: the search page, logged out, showed only a login wall.
- Ledger line: none. rednote-gate was not involved.
- Effect on code or process: note URLs must carry `xsec_token`. rednote-gate refuses bare note URLs before the browser opens. Take note URLs from `rednote_search` results.
