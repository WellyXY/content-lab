import assert from "node:assert/strict";
import test from "node:test";
import { buildNotifications, unreadCount } from "../lib/notifications.ts";

const alert = (id, postId, rule, at) => ({ id, post_id: postId, rule, fired_at: at, payload_json: JSON.stringify({ creatorHandle: "trnhthao", currentViews: 549600, delta: 114700, dayDelta: 114700 }) });

test("signals fired together for one post become one notification linking to the post", () => {
  const items = buildNotifications({
    alerts: [alert("a1", "p1", "surge", "2026-10-13T05:00:10Z"), alert("a2", "p1", "acceleration", "2026-10-13T05:00:10Z"), alert("a3", "p1", "milestone", "2026-10-13T05:00:11Z"), alert("a4", "p2", "surge", "2026-10-12T18:00:00Z")],
    recreations: [], posts: [], analyses: [],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].href, "/posts/p1");
  assert.match(items[0].titleZh, /trnhthao/);
  assert.match(items[0].detailZh, /日增爆发.*加速.*里程碑/);
});

test("finished and failed recreations, new posts in a batch and finished analyses are listed newest first", () => {
  const items = buildNotifications({
    alerts: [],
    recreations: [{ id: "r1", post_id: "p3", status: "complete", updated_at: "2026-10-13T04:00:00Z", creator_handle: "mie.lowlp" }, { id: "r2", post_id: "p4", status: "failed", updated_at: "2026-10-13T03:00:00Z", creator_handle: null }, { id: "r3", post_id: "p5", status: "designing", updated_at: "2026-10-13T06:00:00Z", creator_handle: null }],
    posts: [{ id: "n1", bound_at: "2026-10-13T02:00:05Z", market: "VN", creator_handle: "a" }, { id: "n2", bound_at: "2026-10-13T02:00:30Z", market: "VN", creator_handle: "b" }, { id: "n3", bound_at: "2026-10-13T02:01:00Z", market: "TR", creator_handle: "c" }],
    analyses: [{ post_id: "n1", created_at: "2026-10-13T02:20:00Z", creator_handle: "a" }],
  });
  assert.deepEqual(items.map((item) => item.kind), ["recreation_done", "recreation_failed", "analysis_done", "new_posts"]);
  assert.equal(items[0].href, "/posts/p3");
  assert.match(items[3].titleZh, /新增 3 条帖子/);
  assert.match(items[3].detailZh, /VN 2.*TR 1/);
  assert.equal(items[3].href, "/posts");
});

test("unread counts only items after the last time the viewer opened the list", () => {
  const items = [{ at: "2026-10-13T05:00:00Z" }, { at: "2026-10-13T03:00:00Z" }];
  assert.equal(unreadCount(items, null), 2);
  assert.equal(unreadCount(items, "2026-10-13T04:00:00Z"), 1);
});
