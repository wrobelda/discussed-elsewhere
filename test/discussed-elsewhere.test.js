import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { connectSources, define, discover, normalizeURL, cleanURL, renderList, sources } from "../src/discussed-elsewhere.js";

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
  it("cleanURL keeps the address as submitted elsewhere, and rejects other schemes", () => {
    expect(cleanURL(ARTICLE)).toBe("https://example.com/journal/post/");
    expect(cleanURL("mailto:me@example.com")).toBe("");
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
    expect(discussions).toEqual([expect.objectContaining({ label: "Lemmy (linux on lemmy.other)", url: "https://lemmy.other/post/9", comments: 7 })]);
    expect(new URL(fetch.mock.calls[0][0]).host).toBe("lemmy.example");
  });
});

describe("discover", () => {
  it("asks nothing about an address that is not a web URL", async () => {
    const fetch = fakeFetch({ "hn.algolia.com": { hits: [{ objectID: "1", url: null, title: "Ask HN", num_comments: 3 }] } });
    expect(await discover("not a url", { fetch })).toEqual({ discussions: [], errors: [] });
    expect(await discover("mailto:me@example.com", { fetch })).toEqual({ discussions: [], errors: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops discussions whose address is not a web URL", async () => {
    const source = { id: "odd", label: "Odd", hosts: [], lookup: async () => [{ source: "odd", label: "Odd", url: "javascript:alert(1)", comments: 9, score: 0 }, { source: "odd", label: "Odd", url: "https://ok.test/t", comments: 1, score: 0 }] };
    const { discussions } = await discover(ARTICLE, { sources: [source], fetch: fakeFetch({}) });
    expect(discussions.map((d) => d.url)).toEqual(["https://ok.test/t"]);
  });

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

describe("<discussed-elsewhere>", () => {
  const TAG = "discussed-elsewhere";
  const page = (markup = `<${TAG} id="box"></${TAG}>`, win = {}) => {
    const dom = new JSDOM(`<!doctype html><link rel="canonical" href="https://example.com/journal/post/">${markup}`, { url: "https://example.com/journal/post/?utm_source=x" });
    Object.assign(dom.window, win);
    define(TAG, dom.window);
    return { dom, box: dom.window.document.getElementById("box") };
  };
  const settled = (box) => new Promise((ok) => box.addEventListener("settled", (e) => ok(e.detail), { once: true }));
  const tick = () => new Promise((ok) => setTimeout(ok, 0));

  it("looks up on connection, from the canonical address, and renders a list", async () => {
    const fetch = fakeFetch({ "hn.algolia.com": { hits: [{ objectID: "7", url: "https://example.com/journal/post/", num_comments: 1, points: 3 }] } });
    const { box } = page(`<${TAG} id="box" sources="hn"></${TAG}>`);
    expect(box.url).toBe("https://example.com/journal/post/");
    box.options = { fetch }; // set right after definition: still in time
    const detail = await settled(box);
    expect(detail.status).toBe("done");
    expect(box.innerHTML).toBe('<ul><li class="comment-line"><a href="https://news.ycombinator.com/item?id=7" rel="noopener"><span class="platform">Hacker News</span> (<span class="count">1 comment</span>)</a></li></ul>');
    expect(fetch).toHaveBeenCalledTimes(1);
    await box.load();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("takes url, sources, texts and the Lemmy instance from attributes", async () => {
    const fetch = fakeFetch({ "lemmy.example": { posts: [] } });
    const { box } = page(`<${TAG} id="box" url="https://other.test/a/" sources="lemmy" lemmy-instance="lemmy.example" loading-text="wait" empty-text="nothing" error-text="broken"></${TAG}>`);
    box.options = { fetch };
    expect(box.textContent).toBe("");
    await settled(box);
    expect(box.innerHTML).toBe('<p class="empty">nothing</p>');
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("q")).toBe("https://other.test/a/");
  });

  it("ignores a timeout attribute that is not a positive number", async () => {
    const seen = [];
    const fetch = vi.fn(async (url, init) => {
      seen.push(init.signal);
      return json({ hits: [] });
    });
    const { box } = page(`<${TAG} id="box" sources="hn" timeout=""></${TAG}>`);
    box.options = { fetch };
    await box.load();
    expect(seen[0].aborted).toBe(false);
  });

  it('loading="lazy" waits for the element to near the viewport', async () => {
    const observed = [];
    const IntersectionObserver = class {
      constructor(cb, opts) {
        Object.assign(this, { cb, opts });
        observed.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    };
    const fetch = fakeFetch({ "hn.algolia.com": { hits: [] } });
    const { box } = page(`<${TAG} id="box" sources="hn" loading="lazy"></${TAG}>`, { IntersectionObserver });
    box.options = { fetch };
    await tick();
    expect(fetch).not.toHaveBeenCalled();
    expect(observed[0].opts).toEqual({ rootMargin: "300px" });
    observed[0].cb([{ isIntersecting: true }]);
    await settled(box);
    expect(observed[0].disconnected).toBe(true);
    expect(box.innerHTML).toBe('<p class="empty">No discussions found.</p>');
  });

  it("every source failing is an error line; cancel() stops a lookup", async () => {
    const { box } = page();
    box.options = { fetch: fakeFetch({}) };
    await settled(box);
    expect(box.innerHTML).toBe('<p class="is-error">Could not look up discussions.</p>');

    const slow = vi.fn(() => new Promise(() => {}));
    const { box: other } = page(`<${TAG} id="box" sources="hn" loading-text="wait"></${TAG}>`);
    other.options = { fetch: slow };
    await tick();
    expect(other.textContent).toBe("wait");
    other.cancel();
    expect(slow.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("respects the reader's data-saver setting until load() is called", async () => {
    const fetch = fakeFetch({ "hn.algolia.com": { hits: [] } });
    const { dom, box } = page(`<${TAG} id="box" sources="hn"></${TAG}>`);
    Object.defineProperty(dom.window.navigator, "connection", { value: { saveData: true }, configurable: true });
    box.options = { fetch };
    await tick();
    expect(fetch).not.toHaveBeenCalled();
    await box.load();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("load() resolves to the settled state, and cancel() lets a later load() start afresh", async () => {
    const { box } = page(`<${TAG} id="box" sources="hn"></${TAG}>`);
    const slow = vi.fn(() => new Promise(() => {}));
    box.options = { fetch: slow };
    box.load();
    box.cancel();
    const fetch = fakeFetch({ "hn.algolia.com": { hits: [] } });
    box.options = { fetch };
    const detail = await box.load();
    expect(detail).toEqual({ status: "done", discussions: [], errors: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a cancelled lookup that settles later does not render over the fresh one", async () => {
    const { box } = page(`<${TAG} id="box" sources="hn"></${TAG}>`);
    const hit = (id) => json({ hits: [{ objectID: id, url: "https://example.com/journal/post/", num_comments: 1 }] });
    box.options = { fetch: vi.fn(() => new Promise((ok) => setTimeout(() => ok(hit("old")), 30))) };
    let events = 0;
    box.addEventListener("settled", () => events++);
    box.load();
    box.cancel();
    box.options = { fetch: vi.fn(async () => hit("new")) };
    await box.load();
    await new Promise((ok) => setTimeout(ok, 60));
    expect(box.querySelector("a").getAttribute("href")).toBe("https://news.ycombinator.com/item?id=new");
    expect(events).toBe(1);
  });

  it("define() registers a second tag name in the same window", async () => {
    const { dom } = page();
    expect(() => define("my-discussions", dom.window)).not.toThrow();
    const el = dom.window.document.createElement("my-discussions");
    el.options = { fetch: fakeFetch({ "hn.algolia.com": { hits: [] } }) };
    el.setAttribute("sources", "hn");
    dom.window.document.body.append(el);
    const detail = await el.load();
    expect(detail.status).toBe("done");
    expect(el.innerHTML).toBe('<p class="empty">No discussions found.</p>');
  });

  it("renderList escapes what the sources return", () => {
    const { box } = page();
    renderList(box, { status: "done", discussions: [{ label: "<b>x</b>", url: "https://a.test/?q=<s>", comments: 2 }] }, { comments: (n) => `${n} c` });
    expect(box.querySelector(".platform").textContent).toBe("<b>x</b>");
    expect(box.querySelector("b")).toBeNull();
    expect(box.querySelector("a").getAttribute("href")).toBe("https://a.test/?q=<s>");
    renderList(box, { status: "done", discussions: [{ label: "x", url: "javascript:alert(1)", comments: 0 }] }, { comments: (n) => `${n}` });
    expect(box.querySelector("a").hasAttribute("href")).toBe(false);
  });
});
