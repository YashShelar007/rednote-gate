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

## 2026-10-06: logged-out local browser is sent to the login page

- Where: the same note page, with its `xsec_token`, opened by rednote-gate's own Playwright Chromium (headless) from a home connection
- Account state: logged out, no saved session
- How observed: a one-page probe of `getNote`, no account involved
- What happened: RedNote redirected to `/login` and showed the QR login wall. `__INITIAL_STATE__.note.noteDetailMap` held only a placeholder keyed `"undefined"`. Firecrawl, fetching the same url from its servers, had been served the note.
- Ledger line: none. Not a captcha, so no halt.
- Effect on code or process: `open()` now recognises a redirect to `/login` and says "not logged in, run `npm run login`" instead of a misleading layout error. Note reads can only be verified after login.
