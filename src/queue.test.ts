import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue, listItems, readItem, recoverInterrupted, transition } from "./queue.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const fresh = () => mkdtempSync(join(tmpdir(), "rng-queue-"));
const png = (dir: string, name = "a.png", bytes = PNG) => {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
};

test("a queued post is a plain JSON file a stranger can read", () => {
  const dir = fresh();
  const { item } = enqueue(dir, "create_post", { title: "Hi", body: "Body text", images: [png(fresh())] });
  const onDisk = JSON.parse(readFileSync(join(dir, `${item.id}.json`), "utf8"));
  assert.equal(onDisk.tool, "create_post");
  assert.equal(onDisk.status, "pending");
  assert.equal(onDisk.args.title, "Hi");
  assert.equal(onDisk.args.body, "Body text");
  assert.match(onDisk.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(item.id, /^q_\d{8}T\d{6}_[0-9a-f]{4}$/);
});

test("images are copied into the queue, so editing the original later changes nothing", () => {
  const src = fresh();
  const original = png(src);
  const dir = fresh();
  const { item } = enqueue(dir, "create_post", { title: "t", body: "b", images: [original] });
  writeFileSync(original, Buffer.concat([PNG, Buffer.from("changed")]));
  const copy = join(dir, (item.args as { images: string[] }).images[0]);
  assert.deepEqual(readFileSync(copy), PNG);
  assert.equal(item.imageSha256?.length, 1);
});

test("a file that is not really an image is refused", () => {
  const src = fresh();
  const fake = png(src, "secret.png", Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----"));
  assert.throws(() => enqueue(fresh(), "create_post", { title: "t", body: "b", images: [fake] }), /not a JPEG, PNG or WebP/);
});

test("relative image paths are refused", () => {
  assert.throws(() => enqueue(fresh(), "create_post", { title: "t", body: "b", images: ["a.png"] }), /absolute/);
});

test("queuing the same write twice returns the first item instead of a second one", () => {
  const dir = fresh();
  const args = { noteUrl: "https://www.xiaohongshu.com/explore/abc?xsec_token=x", text: "nice" };
  const first = enqueue(dir, "post_comment", args);
  const second = enqueue(dir, "post_comment", args);
  assert.equal(second.duplicate, true);
  assert.equal(second.item.id, first.item.id);
  assert.equal(listItems(dir).length, 1);
});

test("a rejected write can be queued again", () => {
  const dir = fresh();
  const args = { noteUrl: "https://www.xiaohongshu.com/explore/abc?xsec_token=x", text: "nice" };
  const first = enqueue(dir, "post_comment", args);
  transition(dir, first.item.id, "rejected");
  assert.equal(enqueue(dir, "post_comment", args).duplicate, false);
});

test("status can only move along the allowed path", () => {
  const dir = fresh();
  const { item } = enqueue(dir, "post_comment", { noteUrl: "u", text: "t" });
  assert.throws(() => transition(dir, item.id, "posting"), /pending -> posting/);
  transition(dir, item.id, "approved");
  const posting = transition(dir, item.id, "posting");
  assert.deepEqual(posting.history.map((h) => h.status), ["pending", "approved", "posting"]);
});

test("an item left mid-post by a crash becomes unknown and is never retried", () => {
  const dir = fresh();
  const { item } = enqueue(dir, "post_comment", { noteUrl: "u", text: "t" });
  transition(dir, item.id, "approved");
  transition(dir, item.id, "posting");
  assert.deepEqual(recoverInterrupted(dir).map((i) => i.id), [item.id]);
  assert.equal(readItem(dir, item.id).status, "unknown");
  assert.throws(() => transition(dir, item.id, "posting"));
});

test("a dry run cut off by a crash becomes failed, since it never clicks the final button", () => {
  const dir = fresh();
  const { item } = enqueue(dir, "post_comment", { noteUrl: "u", text: "t" });
  transition(dir, item.id, "approved");
  transition(dir, item.id, "posting", "dry run");
  recoverInterrupted(dir);
  assert.equal(readItem(dir, item.id).status, "failed");
});

test("ids that could escape the queue folder are refused", () => {
  assert.throws(() => readItem(fresh(), "../../.session/state"), /bad queue id/);
});
