import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNoteUrl, titleLength } from "./rednote.js";

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

test("title length counts a CJK character as 1 and ASCII as half", () => {
  assert.equal(titleLength("周末徒步记录"), 6);
  assert.equal(titleLength("abcd"), 2);
  assert.equal(titleLength("abc"), 2);
  assert.equal(titleLength("一二三四五六七八九十一二三四五六七八九十"), 20);
});
