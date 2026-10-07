import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue, listItems, readItem, recoverInterrupted, transition, type PostArgs } from "./queue.js";

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

test("a path that is not a regular file is refused", () => {
  assert.throws(() => enqueue(fresh(), "create_post", { title: "t", body: "b", images: [fresh()] }), /Not a regular file/);
});

const MP4 = Buffer.concat([Buffer.from("0000001c667479706d703432", "hex"), Buffer.alloc(64)]); // ....ftypmp42
test("a video is checked by its signature, copied in and hashed", () => {
  const src = fresh();
  const dir = fresh();
  const { item } = enqueue(dir, "create_video", { title: "t", body: "b", video: png(src, "clip.mp4", MP4) });
  const rel = (item.args as { video: string }).video;
  assert.match(rel, /^q_.*\/video\.mp4$/);
  assert.deepEqual(readFileSync(join(dir, rel)), MP4);
  assert.equal(item.videoSha256?.length, 64);
});

test("a file that is not really a video is refused", () => {
  assert.throws(() => enqueue(fresh(), "create_video", { title: "t", body: "b", video: png(fresh(), "fake.mp4") }), /not an MP4 or MOV/);
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

test("liking the same note twice is one item, even with a fresh xsec_token", () => {
  const dir = fresh();
  const first = enqueue(dir, "like_note", { noteUrl: "https://www.rednote.com/explore/6a1111111111111111111111?xsec_token=A" });
  const second = enqueue(dir, "like_note", { noteUrl: "https://www.rednote.com/explore/6a1111111111111111111111?xsec_token=B" });
  assert.equal(second.duplicate, true);
  assert.equal(second.item.id, first.item.id);
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

test("the AI label is part of what is approved: the same post with and without it are two items", () => {
  const dir = fresh();
  const images = [png(dir)];
  const plain = enqueue(dir, "create_post", { title: "t", body: "b", images });
  const labelled = enqueue(dir, "create_post", { title: "t", body: "b", images, aiGenerated: true });
  assert.equal(labelled.duplicate, false);
  assert.notEqual(labelled.item.contentHash, plain.item.contentHash);
  assert.equal((readItem(dir, labelled.item.id).args as PostArgs).aiGenerated, true);
});
