import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { connectSources, discover, mount, normalizeURL, cleanURL, renderList, sources } from "../src/discussed-elsewhere.js";

const ARTICLE = "https://Example.com/journal/post/?utm_source=x#top";
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// A fetch that answers by host; unknown hosts get a 500.
const fakeFetch = (answers) =>
  vi.fn(async (url) => {
    const host = new URL(url).host;
    const answer = answers[host];
    if (answer === undefined) return json({ error: "unknown host " + host }, 500);
    return typeof answer === "function" ? answer(new URL(url)) : json(answer);
  });

describe("normalizeURL", () => {
  it("ignores scheme, case, www, trailing slash, fragment and trackers", () => {
    expect(normalizeURL(ARTICLE)).toBe("example.com/journal/post");
    expect(normalizeURL("http://www.example.com/journal/post")).toBe("example.com/journal/post");
    expect(normalizeURL("https://example.com/journal/post/?b=2&a=1&fbclid=z")).toBe("example.com/journal/post?a=1&b=2");
  });
  it("rejects what is not a web address", () => {
    expect(normalizeURL("not a url")).toBe("");
    expect(normalizeURL("mailto:me@example.com")).toBe("");
  });
  it("cleanURL keeps the address as submitted elsewhere", () => {
    expect(cleanURL(ARTICLE)).toBe("https://example.com/journal/post/");
  });
});

describe("sources", () => {
  it("hn keeps only exact matches from Algolia's token search", async () => {
    const fetch = fakeFetch({
      "hn.algolia.com": {
        hits: [
          { objectID: "1", url: "https://example.com/journal/post/", title: "Post", num_comments: 4, points: 20, created_at: "2026-01-01T00:00:00Z" },
          { objectID: "2", url: "https://example.com/journal/other/", title: "Other", num_comments: 40, points: 200 },
        ],
      },
    });
    const { discussions, errors } = await discover(ARTICLE, { sources: ["hn"], fetch });
    expect(errors).toEqual([]);
    expect(discussions).toEqual([
      expect.objectContaining({ source: "hn", label: "Hacker News", url: "https://news.ycombinator.com/item?id=1", comments: 4, score: 20 }),
    ]);
    const called = new URL(fetch.mock.calls[0][0]);
    expect(called.searchParams.get("query")).toBe("https://example.com/journal/post/");
    expect(called.searchParams.get("restrictSearchableAttributes")).toBe("url");
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", mode: "cors" });
  });

  it("reddit asks the archive for both slash spellings and dedupes", async () => {
    const post = { id: "abc", subreddit: "linux", permalink: "/r/linux/comments/abc/post/", url: "https://example.com/journal/post", title: "Post", num_comments: 3, score: 9, created_utc: 1700000000 };
    const fetch = fakeFetch({ "arctic-shift.photon-reddit.com": { data: [post, { ...post, id: "gone", _meta: { removal_type: "moderator" } }] } });
    const { discussions } = await discover(ARTICLE, { sources: ["reddit"], fetch });
    expect(fetch.mock.calls.map((c) => new URL(c[0]).searchParams.get("url")).sort()).toEqual(["https://example.com/journal/post", "https://example.com/journal/post/"]);
    expect(discussions).toEqual([expect.objectContaining({ label: "Reddit r/linux", url: "https://www.reddit.com/r/linux/comments/abc/post/", comments: 3, date: "2023-11-14T22:13:20.000Z" })]);
  });

  it("bluesky folds backlinked posts into one line and drops posts nobody engaged with", async () => {
    const record = (rkey) => ({ did: "did:plc:x", collection: "app.bsky.feed.post", rkey });
    const fetch = fakeFetch({
      "constellation.microcosm.blue": (u) => json({ records: u.searchParams.get("source").includes("embed") ? [record("a"), record("b")] : [record("c")] }),
      "public.api.bsky.app": (u) => {
        expect(u.searchParams.getAll("uris")).toHaveLength(3);
        return json({
          posts: [
            { uri: "at://did:plc:x/app.bsky.feed.post/a", author: { handle: "one.test" }, record: { text: "hi", createdAt: "2026-02-02T00:00:00Z" }, replyCount: 2, likeCount: 5 },
            { uri: "at://did:plc:x/app.bsky.feed.post/b", author: { handle: "two.test" }, record: { text: "" }, replyCount: 0, likeCount: 0 },
            { uri: "at://did:plc:x/app.bsky.feed.post/c", author: { handle: "three.test" }, record: { text: "" }, replyCount: 1, likeCount: 1 },
          ],
        });
      },
    });
    const { discussions } = await discover(ARTICLE, { sources: ["bluesky"], fetch });
    expect(discussions).toEqual([expect.objectContaining({ label: "Bluesky", url: "https://bsky.app/profile/one.test/post/a", comments: 3, score: 6, posts: 2 })]);
    const subject = new URL(fetch.mock.calls[0][0]).searchParams.get("subject");
    expect(subject).toBe("https://example.com/journal/post/");
  });

  it("bluesky returns nothing without backlinks and never calls the app view", async () => {
    const fetch = fakeFetch({ "constellation.microcosm.blue": { records: [] } });
    const { discussions, errors } = await discover(ARTICLE, { sources: ["bluesky"], fetch });
    expect(discussions).toEqual([]);
    expect(errors).toEqual([]);
    expect(fetch.mock.calls.every((c) => new URL(c[0]).host === "constellation.microcosm.blue")).toBe(true);
  });

  it("lemmy names the community with its home instance", async () => {
    const fetch = fakeFetch({
      "lemmy.example": {
        posts: [
          { post: { id: 1, url: "https://example.com/journal/post/", ap_id: "https://lemmy.other/post/9", name: "Post", published: "2026-03-03T00:00:00Z" }, community: { name: "linux", actor_id: "https://lemmy.other/c/linux" }, counts: { comments: 7, score: 3 } },
          { post: { id: 2, url: "https://example.com/elsewhere/", ap_id: "https://lemmy.other/post/10", name: "Nope" }, community: { name: "x", actor_id: "https://lemmy.other/c/x" }, counts: { comments: 1, score: 1 } },
        ],
      },
    });
    const { discussions } = await discover(ARTICLE, { sources: ["lemmy"], lemmy: { instance: "https://lemmy.example/" }, fetch });
    expect(discussions).toEqual([expect.objectContaining({ label: "Lemmy !linux@lemmy.other", url: "https://lemmy.other/post/9", comments: 7 })]);
    expect(new URL(fetch.mock.calls[0][0]).host).toBe("lemmy.example");
  });
});

describe("discover", () => {
  it("sorts by comments then score and reports failed sources", async () => {
    const fetch = fakeFetch({
      "hn.algolia.com": { hits: [{ objectID: "1", url: "https://example.com/journal/post", num_comments: 2, points: 1 }, { objectID: "2", url: "https://example.com/journal/post/", num_comments: 2, points: 8 }] },
      "constellation.microcosm.blue": { records: [] },
      "lemmy.world": { posts: [] },
    });
    const { discussions, errors } = await discover(ARTICLE, { fetch });
    expect(discussions.map((d) => d.url)).toEqual(["https://news.ycombinator.com/item?id=2", "https://news.ycombinator.com/item?id=1"]);
    expect(errors).toEqual([{ source: "reddit", error: expect.any(Error) }]);
    expect(errors[0].error.message).toMatch(/HTTP 500 from arctic-shift/);
  });

  it("lists the origins a CSP must allow", () => {
    expect(connectSources()).toEqual([
      "https://hn.algolia.com",
      "https://arctic-shift.photon-reddit.com",
      "https://constellation.microcosm.blue",
      "https://public.api.bsky.app",
      "https://lemmy.world",
    ]);
    expect(connectSources(["lemmy"], { lemmy: { instance: "lemmy.ml" } })).toEqual(["https://lemmy.ml"]);
  });
});

describe("mount", () => {
  const page = () => {
    const dom = new JSDOM(`<!doctype html><link rel="canonical" href="https://example.com/journal/post/"><div id="box"></div>`, { url: "https://example.com/journal/post/?utm_source=x" });
    return { dom, box: dom.window.document.getElementById("box") };
  };

  it("takes the canonical address, defers to visibility, and renders a list", async () => {
    const { dom, box } = page();
    const observed = [];
    dom.window.IntersectionObserver = class {
      constructor(cb, opts) {
        this.cb = cb;
        this.opts = opts;
        observed.push(this);
      }
      observe(el) {
        this.el = el;
      }
      disconnect() {
        this.disconnected = true;
      }
    };
    const fetch = fakeFetch({ "hn.algolia.com": { hits: [{ objectID: "7", url: "https://example.com/journal/post/", num_comments: 1, points: 3 }] } });
    const controller = mount(box, { sources: ["hn"], fetch });
    expect(controller.url).toBe("https://example.com/journal/post/");
    expect(observed[0].opts).toEqual({ rootMargin: "300px" });
    expect(box.innerHTML).toBe("");
    const settled = new Promise((ok) => box.addEventListener("discussed-elsewhere", (e) => ok(e.detail)));
    observed[0].cb([{ isIntersecting: true }]);
    expect(box.querySelector("p.loading")).not.toBeNull();
    const detail = await settled;
    expect(detail.status).toBe("done");
    expect(observed[0].disconnected).toBe(true);
    expect(box.innerHTML).toBe('<ul><li class="comment-line"><a href="https://news.ycombinator.com/item?id=7" rel="noopener"><span class="platform">Hacker News</span> (<span class="count">1 comment</span>)</a></li></ul>');
    expect(fetch).toHaveBeenCalledTimes(1);
    await controller.load();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("load() runs the lookup at once, and every source failing is an error", async () => {
    const { box } = page();
    const fetch = fakeFetch({});
    const controller = mount(box, { fetch });
    await controller.load();
    expect(box.innerHTML).toBe('<p class="is-error">Could not look up discussions.</p>');
  });

  it("nothing found is the empty message, and cancel() stops a lookup", async () => {
    const { box } = page();
    const fetch = fakeFetch({ "hn.algolia.com": { hits: [] } });
    await mount(box, { sources: ["hn"], fetch }).load();
    expect(box.innerHTML).toBe('<p class="empty">No discussions found.</p>');

    const slow = vi.fn(() => new Promise(() => {}));
    const { box: other } = page();
    const controller = mount(other, { sources: ["hn"], fetch: slow, messages: { loading: "wait" } });
    const pending = controller.load();
    expect(other.textContent).toBe("wait");
    controller.cancel();
    expect(slow.mock.calls[0][1].signal.aborted).toBe(true);
    await Promise.race([pending, new Promise((ok) => setTimeout(ok, 20))]);
    expect(other.textContent).toBe("wait");
  });

  it("renderList escapes what the sources return", () => {
    const { box } = page();
    renderList(box, { status: "done", discussions: [{ label: "<b>x</b>", url: "https://a.test/?q=<s>", comments: 2 }] }, { comments: (n) => `${n} c` });
    expect(box.querySelector(".platform").textContent).toBe("<b>x</b>");
    expect(box.querySelector("b")).toBeNull();
    expect(box.querySelector("a").getAttribute("href")).toBe("https://a.test/?q=<s>");
  });
});
