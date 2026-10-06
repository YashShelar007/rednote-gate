import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyMatches, notesFromProfile, pageProblem, parseNoteUrl, sameComment, titleLength } from "./rednote.js";

const GOOD = "https://www.xiaohongshu.com/explore/6aa4b5e80000000028037e0b?xsec_token=ABArs&xsec_source=pc_search";

test("a note url from search is accepted", () => {
  assert.equal(parseNoteUrl(GOOD).noteId, "6aa4b5e80000000028037e0b");
});

test("overseas rednote.com note urls are accepted too", () => {
  assert.equal(parseNoteUrl(GOOD.replace("www.xiaohongshu.com", "www.rednote.com")).noteId, "6aa4b5e80000000028037e0b");
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

test("a reply target must match the approved author and text exactly", () => {
  const approved = { author: "Alice", text: "这条路线难吗？" };
  assert.equal(sameComment({ author: "Alice", text: "这条路线难吗？" }, approved), true);
  assert.equal(sameComment({ author: "Alice ", text: " 这条路线难吗？\n" }, approved), true, "whitespace does not matter");
  assert.equal(sameComment({ author: "Mallory", text: "这条路线难吗？" }, approved), false, "different author");
  assert.equal(sameComment({ author: "Alice", text: "这条路线难吗？还有别的吗" }, approved), false, "longer text");
  assert.equal(sameComment({ author: "Alice", text: "好" }, { author: "Alice", text: " " }), false, "blank approved text matches nothing");
  assert.equal(sameComment(undefined, approved), false);
});

test("my notes come from the first tab of the profile state, with links that carry the xsec_token", () => {
  const state = [[{ id: "6aaa9dfb0000000026017c4b", xsecToken: "AB+x/y=", noteCard: { displayTitle: "周末", interactInfo: { likedCount: "3" } } }, { id: "", xsecToken: "z" }], [{ id: "liked-tab", xsecToken: "q" }]];
  assert.deepEqual(notesFromProfile(state, "https://www.rednote.com", 10), [
    { noteId: "6aaa9dfb0000000026017c4b", title: "周末", likes: "3", url: "https://www.rednote.com/explore/6aaa9dfb0000000026017c4b?xsec_token=AB%2Bx%2Fy%3D&xsec_source=pc_user" },
  ]);
  assert.deepEqual(notesFromProfile(undefined, "https://www.rednote.com", 10), []);
});

test("the body read-back allows topics after the approved text, and nothing else", () => {
  const body = "今天在草坪上自习 ☀️\n效率很高";
  assert.equal(bodyMatches("今天在草坪上自习 ☀️\n\n效率很高", body, []), true, "whitespace does not matter");
  assert.equal(bodyMatches("今天在草坪上自习 ☀️ 效率很高 #校园生活 #自习", body, ["校园生活", "自习"]), true);
  assert.equal(bodyMatches("今天在草坪上自习 ☀️ 效率很高 #校园生活[话题]#", body, ["校园生活"]), true, "a linked topic chip");
  assert.equal(bodyMatches("今天在草坪上自习 效率很高", body, []), false, "the emoji was dropped");
  assert.equal(bodyMatches("今天在草坪上自习 ☀️ 效率很高 #校园", body, ["校园生活"]), false, "a topic was cut short");
  assert.equal(bodyMatches("今天在草坪上自习 ☀️ 效率很高 #校园生活 买买买", body, ["校园生活"]), false, "extra text after the topics");
});

test("title length counts a CJK character as 1 and ASCII as half", () => {
  assert.equal(titleLength("周末徒步记录"), 6);
  assert.equal(titleLength("abcd"), 2);
  assert.equal(titleLength("abc"), 2);
  assert.equal(titleLength("一二三四五六七八九十一二三四五六七八九十"), 20);
});
