import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CATALOGUE, helpText } from "./help.js";

const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const registered = (kind: "Tool" | "Prompt") => [...source("index.ts").matchAll(new RegExp(`register${kind}\\(\\s*"([a-z_]+)"`, "g"))].map((m) => m[1]);

test("help lists exactly the tools the server registers", () => {
  assert.deepEqual(CATALOGUE.tools.map((t) => t.name).sort(), registered("Tool").sort());
});

test("help lists exactly the workflows the server registers", () => {
  assert.deepEqual(CATALOGUE.workflows.map((w) => w.name).sort(), registered("Prompt").sort());
});

test("help shows the mode and what is left of today's budget", () => {
  const text = helpText({ version: "1.0.0", site: "rednote.com", dryRun: false, writesUsed: 5, likesUsed: 1, limits: { daily: 5, commentGapMin: 10, likes: 10 }, nextWrite: "Oct 7, 2:57 PM" });
  assert.match(text, /LIVE/);
  assert.match(text, /0 of 5 writes left/);
  assert.match(text, /next at Oct 7, 2:57 PM/);
  assert.match(text, /9 of 10 likes left/);
  assert.match(text, /rednote_create_post/);
  assert.match(helpText({ version: "1.0.0", site: "xiaohongshu.com", dryRun: true, writesUsed: 0, likesUsed: 0, limits: { daily: 5, commentGapMin: 10 } }), /DRY RUN/);
});
