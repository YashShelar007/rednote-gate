import { test } from "node:test";
import assert from "node:assert/strict";
import { pageProblem, parseNoteUrl, titleLength } from "./rednote.js";

const GOOD = "https://www.xiaohongshu.com/explore/6aa4b5e80000000028037e0b?xsec_token=ABArs&xsec_source=pc_search";

test("a note url from search is accepted", () => {
  assert.equal(parseNoteUrl(GOOD).noteId, "6aa4b5e80000000028037e0b");
});

test("a bare note url is refused, because it triggers a captcha", () => {
  assert.throws(() => parseNoteUrl("https://www.xiaohongshu.com/explore/6aa4b5e80000000028037e0b"), /xsec_token/);
});

test("urls on other hosts are refused", () => {
  assert.throws(() => parseNoteUrl("https://evil.example/explore/6aa4b5e80000000028037e0b?xsec_token=x"), /Not a RedNote note/);
  assert.throws(() => parseNoteUrl("http://www.xiaohongshu.com/explore/6aa4b5e80000000028037e0b?xsec_token=x"), /Not a RedNote note/);
  assert.throws(() => parseNoteUrl("https://www.xiaohongshu.com/user/profile/abc?xsec_token=x"), /Not a RedNote note/);
});

test("redirects to the login wall, a 404 or a captcha are recognised by url", () => {
  assert.match(pageProblem("https://www.xiaohongshu.com/login?redirectPath=x") ?? "", /not logged in/);
  assert.match(pageProblem("https://www.xiaohongshu.com/404?source=/404/sec_x&error_code=300031") ?? "", /not available/);
  assert.equal(pageProblem(GOOD), null);
  assert.equal(pageProblem("https://creator.xiaohongshu.com/publish/publish?source=official"), null);
});

test("title length counts a CJK character as 1 and ASCII as half", () => {
  assert.equal(titleLength("周末徒步记录"), 6);
  assert.equal(titleLength("abcd"), 2);
  assert.equal(titleLength("abc"), 2);
  assert.equal(titleLength("一二三四五六七八九十一二三四五六七八九十"), 20);
});
