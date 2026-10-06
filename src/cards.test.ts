import { test } from "node:test";
import assert from "node:assert/strict";
import { cardHtml, checkCards, THEMES } from "./cards.js";

test("title and lines are HTML-escaped, so card text can never become markup", () => {
  const html = cardHtml({ title: `<script>alert("x")</script>`, lines: [`it's <b>bold</b> & "quoted"`] }, THEMES[0], 1, 1);
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("it&#39;s &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;"));
});

test("the footer is escaped too", () => {
  const html = cardHtml({ title: "t", footer: `<img src=x onerror="y">` }, THEMES[0], 1, 1);
  assert.ok(!html.includes("<img"));
});

test("no theme loads anything from the network", () => {
  for (const theme of THEMES) {
    const html = cardHtml({ title: "校园自习好去处", lines: ["图书馆三楼靠窗"] }, theme, 1, 1);
    assert.doesNotMatch(html, /http|@import|url\(/i, theme);
  }
});

test("the page is exactly 1080 by 1440", () => {
  const html = cardHtml({ title: "t" }, THEMES[0], 1, 1);
  assert.match(html, /1080px/);
  assert.match(html, /1440px/);
});

test("the page number shows only when there is more than one card", () => {
  assert.match(cardHtml({ title: "t" }, THEMES[0], 2, 3), />2\/3</);
  assert.doesNotMatch(cardHtml({ title: "t" }, THEMES[0], 1, 1), />1\/1</);
});

test("every theme renders the title, and an unknown theme is refused", () => {
  assert.ok(THEMES.length >= 4);
  for (const theme of THEMES) assert.ok(cardHtml({ title: "Study spots" }, theme, 1, 1).includes("Study spots"));
  assert.throws(() => cardHtml({ title: "t" }, "neon", 1, 1), /Unknown theme "neon"/);
});

test("a card needs a title of 1 to 40 characters", () => {
  assert.throws(() => checkCards([{ title: "" }]), /title/);
  assert.throws(() => checkCards([{ title: "   " }]), /title/);
  assert.throws(() => checkCards([{ title: "字".repeat(41) }]), /40/);
  assert.doesNotThrow(() => checkCards([{ title: "字".repeat(40) }]));
});

test("a card has at most 8 lines of at most 60 characters", () => {
  assert.throws(() => checkCards([{ title: "t", lines: Array(9).fill("tip") }]), /8 lines/);
  assert.throws(() => checkCards([{ title: "t", lines: ["x".repeat(61)] }]), /60/);
  assert.doesNotThrow(() => checkCards([{ title: "t", lines: Array(8).fill("x".repeat(60)) }]));
});

test("a set has 1 to 9 cards", () => {
  assert.throws(() => checkCards([]), /1 to 9/);
  assert.throws(() => checkCards(Array(10).fill({ title: "t" })), /1 to 9/);
});

test("cardHtml validates the card it is given", () => {
  assert.throws(() => cardHtml({ title: "" }, THEMES[0], 1, 1), /title/);
});
