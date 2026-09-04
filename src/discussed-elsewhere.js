// discussed-elsewhere: find where an article is being discussed and list the
// threads. The module is browser-only, dependency-free and keyless, because
// every source answers cross-origin JSON to an unauthenticated fetch. So it
// runs under a strict Content-Security-Policy whose connect-src lists only
// these hosts:
//
//   hn        https://hn.algolia.com
//   reddit    https://arctic-shift.photon-reddit.com, an archive mirror;
//             reddit.com itself refuses unauthenticated JSON since 2026
//   bluesky   https://constellation.microcosm.blue, a backlink index, and
//             https://public.api.bsky.app for the post counts
//   lemmy     https://<instance>, lemmy.world by default
//
// Lobsters has a URL lookup at /stories/url/all, but it sends no CORS
// headers, so it cannot be a browser source. Mastodon has no URL search at
// all. Both arrive through webmentions instead; see TODO.md.
//
// The endpoint map follows Backchannel, a userscript that does the same
// lookup with extension privileges: github.com/twalichiewicz/Backchannel,
// MIT.

const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "twclid", "igshid", "mc_cid", "mc_eid",
  "ref", "ref_src", "ref_url", "source", "s", "si", "feature", "yclid", "_hsenc",
  "_hsmi", "hsctatracking", "mkt_tok", "oly_anon_id", "oly_enc_id", "vero_id",
  "wickedid", "trk", "trkcampaign", "sc_channel", "sc_campaign", "cmpid", "ncid",
]);
const TRACKING_PATTERNS = [/^utm_/, /^pk_/, /^mtm_/, /^matomo_/, /^piwik_/, /^hsa_/, /^ga_/, /^_ga/, /^oly_/, /^vero_/];

export function isTrackingParam(key) {
  const name = String(key || "").toLowerCase();
  return TRACKING_PARAMS.has(name) || TRACKING_PATTERNS.some((p) => p.test(name));
}

// Comparison key for "the same article": lower-case host without www., no
// trailing slash, no fragment, tracking parameters dropped, scheme ignored.
export function normalizeURL(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  for (const key of [...u.searchParams.keys()]) if (isTrackingParam(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  return host + u.pathname.replace(/\/+$/, "") + (u.searchParams.size ? "?" + u.searchParams : "");
}

// The address as submitted elsewhere: same URL without fragment or trackers.
export function cleanURL(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  for (const key of [...u.searchParams.keys()]) if (isTrackingParam(key)) u.searchParams.delete(key);
  u.hash = "";
  return u.href;
}

const withSlash = (href) => (href.endsWith("/") ? href : href + "/");
const withoutSlash = (href) => href.replace(/\/+$/, "");
const slashVariants = (href) => [...new Set([href, withSlash(href), withoutSlash(href)])];

// A discussion: { source, label, url, title, comments, score, date, posts }.
// `label` names the venue as it should be printed ("Reddit r/linux");
// `comments` and `score` are numbers; `date` an ISO string or null; `posts`
// the number of submissions folded into the entry (Bluesky groups all posts
// sharing the link into one line).
const discussion = (fields) => ({ title: "", comments: 0, score: 0, date: null, posts: 1, ...fields });

export const sources = {
  hn: {
    id: "hn",
    label: "Hacker News",
    hosts: ["https://hn.algolia.com"],
    async lookup(url, ctx) {
      const target = normalizeURL(url);
      // Algolia matches URL tokens, not the exact string: a query for the home
      // page returns every story from the domain, hence the exact filter.
      const res = await ctx.json(
        "https://hn.algolia.com/api/v1/search?tags=story&restrictSearchableAttributes=url&hitsPerPage=20&query=" +
          encodeURIComponent(cleanURL(url)),
      );
      return (res?.hits || [])
        .filter((hit) => normalizeURL(hit.url) === target)
        .map((hit) =>
          discussion({
            source: "hn",
            label: "Hacker News",
            url: "https://news.ycombinator.com/item?id=" + encodeURIComponent(hit.objectID),
            title: hit.title || "",
            comments: hit.num_comments || 0,
            score: hit.points || 0,
            date: hit.created_at || null,
          }),
        );
    },
  },

  reddit: {
    id: "reddit",
    label: "Reddit",
    hosts: ["https://arctic-shift.photon-reddit.com"],
    async lookup(url, ctx) {
      const target = normalizeURL(url);
      // The archive matches the submitted string exactly, and submitters drop
      // or add the trailing slash, so ask for both spellings.
      const pages = await Promise.all(
        slashVariants(cleanURL(url)).map((href) =>
          ctx.json("https://arctic-shift.photon-reddit.com/api/posts/search?limit=25&url=" + encodeURIComponent(href)),
        ),
      );
      const seen = new Map();
      for (const page of pages) {
        for (const post of page?.data || []) {
          if (!post || seen.has(post.id) || normalizeURL(post.url) !== target) continue;
          if (post._meta?.removal_type || post.removed_by_category) continue;
          seen.set(
            post.id,
            discussion({
              source: "reddit",
              label: "Reddit r/" + post.subreddit,
              url: "https://www.reddit.com" + post.permalink,
              title: post.title || "",
              comments: post.num_comments || 0,
              score: post.score || 0,
              date: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
            }),
          );
        }
      }
      return [...seen.values()];
    },
  },

  bluesky: {
    id: "bluesky",
    label: "Bluesky",
    hosts: ["https://constellation.microcosm.blue", "https://public.api.bsky.app"],
    // Posts that link the article as an external card or as a link facet.
    // Bluesky's own search needs a login since 2026; Constellation is an
    // independent backlink index that is told the URL, Bluesky only the ids.
    async lookup(url, ctx, options) {
      const subject = encodeURIComponent(cleanURL(url));
      const paths = ["embed.external.uri", "facets[].features[].uri"];
      const pages = await Promise.all(
        paths.map((path) =>
          ctx.json(
            `https://constellation.microcosm.blue/xrpc/blue.microcosm.links.getBacklinks?subject=${subject}&source=${encodeURIComponent("app.bsky.feed.post:" + path)}&limit=100`,
          ),
        ),
      );
      const uris = new Set();
      for (const page of pages)
        for (const r of page?.records || []) if (r?.did && r?.rkey) uris.add(`at://${r.did}/app.bsky.feed.post/${r.rkey}`);
      if (!uris.size) return [];
      const list = [...uris];
      const posts = [];
      for (let i = 0; i < list.length; i += 25) {
        const query = list.slice(i, i + 25).map((uri) => "uris=" + encodeURIComponent(uri)).join("&");
        const batch = await ctx.json("https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?" + query);
        posts.push(...(batch?.posts || []));
      }
      const minEngagement = options?.bluesky?.minEngagement ?? 1;
      const engagement = (p) => (p.replyCount || 0) + (p.likeCount || 0) + (p.repostCount || 0) + (p.quoteCount || 0);
      const live = posts.filter((p) => engagement(p) >= minEngagement);
      if (!live.length) return [];
      live.sort((a, b) => (b.replyCount || 0) - (a.replyCount || 0) || engagement(b) - engagement(a));
      const top = live[0];
      const rkey = top.uri.split("/").pop();
      return [
        discussion({
          source: "bluesky",
          label: "Bluesky",
          url: `https://bsky.app/profile/${encodeURIComponent(top.author?.handle || top.author?.did)}/post/${encodeURIComponent(rkey)}`,
          title: top.record?.text || "",
          comments: live.reduce((n, p) => n + (p.replyCount || 0), 0),
          score: live.reduce((n, p) => n + (p.likeCount || 0), 0),
          date: top.record?.createdAt || top.indexedAt || null,
          posts: live.length,
        }),
      ];
    },
  },

  lemmy: {
    id: "lemmy",
    label: "Lemmy",
    hosts: ["https://lemmy.world"],
    async lookup(url, ctx, options) {
      const instance = (options?.lemmy?.instance || "lemmy.world").replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const target = normalizeURL(url);
      const res = await ctx.json(
        `https://${instance}/api/v3/search?q=${encodeURIComponent(cleanURL(url))}&type_=Url&listing_type=All&limit=20`,
      );
      return (res?.posts || [])
        .filter((view) => normalizeURL(view?.post?.url) === target && !view.post.deleted && !view.post.removed)
        .map((view) => {
          let home = instance;
          try {
            home = new URL(view.community?.actor_id).host;
          } catch {}
          return discussion({
            source: "lemmy",
            label: `Lemmy (${view.community?.name || "?"} on ${home})`,
            url: view.post.ap_id || `https://${instance}/post/${view.post.id}`,
            title: view.post.name || "",
            comments: view.counts?.comments || 0,
            score: view.counts?.score || 0,
            date: view.post.published || null,
          });
        });
    },
  },
};

export const DEFAULT_SOURCES = ["hn", "reddit", "bluesky", "lemmy"];

const anySignal = (signals) => {
  const list = signals.filter(Boolean);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(list);
  return list[0];
};

// Look the URL up on every source and gather the results. Options:
//   sources               source ids or source objects
//   timeout               per request, in ms; 5000 by default
//   signal                an AbortSignal
//   fetch                 defaults to globalThis.fetch
//   lemmy.instance        the Lemmy instance to ask
//   bluesky.minEngagement the least engagement a Bluesky post needs
// Returns { discussions, errors }. The discussions are sorted by comment
// count, then score; the errors are { source, error } for each source that
// failed.
export async function discover(url, options = {}) {
  // not a web address: nothing to ask, and no source could match it (a text
  // post with no URL normalizes to "" as well)
  if (!normalizeURL(url)) return { discussions: [], errors: [] };
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  const timeout = options.timeout ?? 5000;
  const ctx = {
    async json(target) {
      const timer = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeout) : undefined;
      const res = await fetcher(target, {
        credentials: "omit",
        mode: "cors",
        headers: { accept: "application/json" },
        priority: "low",
        signal: anySignal([timer, options.signal]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(target).host}`);
      return res.json();
    },
  };
  const chosen = (options.sources || DEFAULT_SOURCES).map((s) => (typeof s === "string" ? sources[s] : s)).filter(Boolean);
  const settled = await Promise.allSettled(chosen.map((source) => source.lookup(url, ctx, options)));
  const discussions = [];
  const errors = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") discussions.push(...result.value);
    else errors.push({ source: chosen[i].id, error: result.reason });
  });
  discussions.sort((a, b) => b.comments - a.comments || b.score - a.score || String(a.label).localeCompare(String(b.label)));
  return { discussions, errors };
}

// Hosts a page must allow in connect-src for the given sources.
export function connectSources(ids = DEFAULT_SOURCES, options = {}) {
  const hosts = new Set();
  for (const id of ids) {
    const source = typeof id === "string" ? sources[id] : id;
    if (!source) continue;
    if (source.id === "lemmy" && options.lemmy?.instance) hosts.add("https://" + options.lemmy.instance.replace(/^https?:\/\//, "").replace(/\/+$/, ""));
    else for (const host of source.hosts || []) hosts.add(host);
  }
  return [...hosts];
}

const DEFAULT_MESSAGES = {
  loading: "Looking up discussions…",
  empty: "No discussions found.",
  error: "Could not look up discussions.",
  comments: (n) => (n === 1 ? "1 comment" : `${n} comments`),
};

// Default renderer: a plain list in the element, with class hooks a stylesheet
// can pick up (.loading, .empty, .is-error, .comment-line, .platform, .count).
export function renderList(element, state, messages = DEFAULT_MESSAGES) {
  const doc = element.ownerDocument;
  const text = (tag, className, content) => {
    const node = doc.createElement(tag);
    node.className = className;
    node.textContent = content;
    return node;
  };
  element.replaceChildren();
  if (state.status === "loading") return element.append(text("p", "loading", messages.loading));
  if (state.status === "error") return element.append(text("p", "is-error", messages.error));
  if (!state.discussions.length) return element.append(text("p", "empty", messages.empty));
  const list = doc.createElement("ul");
  for (const d of state.discussions) {
    const item = doc.createElement("li");
    item.className = "comment-line";
    const link = doc.createElement("a");
    link.href = d.url;
    link.rel = "noopener";
    link.append(text("span", "platform", d.label), " (", text("span", "count", messages.comments(d.comments)), ")");
    item.append(link);
    list.append(item);
  }
  element.append(list);
}

// <discussed-elsewhere url="…">: the box as a custom element. It renders
// into its own light DOM, so the page's stylesheet styles the list. Like an
// <img> it looks the article up as soon as it is connected; with
// loading="lazy" it waits until it comes within root-margin of the viewport.
//
// Attributes:
//   url            the article; defaults to <link rel=canonical>, then the
//                  page address
//   sources        comma-separated source ids
//   loading        "eager" (default) or "lazy"
//   root-margin    the distance for loading="lazy"; "300px" by default
//   lemmy-instance the Lemmy instance to ask
//   timeout        per request, in ms
//   loading-text, empty-text, error-text
//                  the three status lines
//
// Properties, for what attributes cannot carry:
//   messages       see DEFAULT_MESSAGES
//   render         render(element, state, messages)
//   options        extra discover() options, such as a custom fetch
// A script may set them right after the element is parsed or defined,
// because the first lookup waits one microtask.
//
// Methods and events:
//   load()         runs the lookup now, once, and resolves to the settled
//                  { status, discussions, errors }; later calls return the
//                  same promise
//   cancel()       aborts the lookup and stops watching the viewport; a
//                  later load() starts afresh
//   "settled"      a bubbling event with { status, discussions, errors },
//                  dispatched after the final render
//
// A reader's data-saver setting (navigator.connection.saveData) skips the
// automatic lookup; load() still works.
const classes = new WeakMap();

export function elementClass(win = globalThis) {
  if (classes.has(win)) return classes.get(win);
  const Element = class DiscussedElsewhere extends win.HTMLElement {
    #controller = null;
    #observer = null;
    #promise = null;
    messages = null;
    render = null;
    options = null;

    get url() {
      return this.getAttribute("url") || this.ownerDocument.querySelector('link[rel~="canonical"]')?.href || this.ownerDocument.location?.href || win.location?.href || "";
    }

    connectedCallback() {
      queueMicrotask(() => {
        if (!this.isConnected || this.#promise || this.#observer) return;
        if (win.navigator?.connection?.saveData) return;
        if (this.getAttribute("loading") === "lazy" && typeof win.IntersectionObserver === "function") {
          this.#observer = new win.IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) this.load();
            },
            { rootMargin: this.getAttribute("root-margin") ?? "300px" },
          );
          this.#observer.observe(this);
        } else {
          this.load();
        }
      });
    }

    disconnectedCallback() {
      this.#observer?.disconnect();
      this.#observer = null;
    }

    load() {
      if (this.#promise) return this.#promise;
      this.#observer?.disconnect();
      this.#observer = null;
      const messages = { ...DEFAULT_MESSAGES, ...(this.messages || {}) };
      for (const [key, attr] of [["loading", "loading-text"], ["empty", "empty-text"], ["error", "error-text"]])
        if (this.hasAttribute(attr)) messages[key] = this.getAttribute(attr);
      const render = this.render || renderList;
      const options = { ...(this.options || {}) };
      if (this.hasAttribute("sources")) options.sources = this.getAttribute("sources").split(",").map((s) => s.trim()).filter(Boolean);
      if (this.hasAttribute("lemmy-instance")) options.lemmy = { ...(options.lemmy || {}), instance: this.getAttribute("lemmy-instance") };
      if (this.hasAttribute("timeout")) options.timeout = Number(this.getAttribute("timeout"));
      // this lookup's own controller: a cancelled lookup that settles later
      // must not render over the one that replaced it
      const controller = (this.#controller = new AbortController());
      options.signal = anySignal([controller.signal, options.signal]);
      const settle = (status, discussions, errors) => {
        const detail = { status, discussions, errors };
        if (controller.signal.aborted) return detail;
        for (const { source, error } of errors) win.console?.warn?.(`discussed-elsewhere: ${source} failed:`, error);
        render(this, detail, messages);
        this.dispatchEvent(new win.CustomEvent("settled", { bubbles: true, detail }));
        return detail;
      };
      render(this, { status: "loading", discussions: [], errors: [] }, messages);
      this.#promise = discover(this.url, options)
        .then(({ discussions, errors }) => settle(discussions.length || !errors.length ? "done" : "error", discussions, errors))
        .catch((error) => settle("error", [], [{ source: "*", error }]));
      return this.#promise;
    }

    cancel() {
      this.#observer?.disconnect();
      this.#observer = null;
      this.#controller?.abort();
      this.#promise = null; // a later load() starts afresh
    }
  };
  classes.set(win, Element);
  return Element;
}

// Register the element under `name`, once per registry. A registry accepts
// one name per constructor, so a second name gets a subclass.
export function define(name = "discussed-elsewhere", win = globalThis) {
  const registry = win.customElements;
  if (!registry || registry.get(name)) return name;
  const Base = elementClass(win);
  const taken = registry.getName ? registry.getName(Base) !== null : registered.has(Base);
  registry.define(name, taken ? class extends Base {} : Base);
  registered.add(Base);
  return name;
}
const registered = new WeakSet();

// In a browser, importing the module registers <discussed-elsewhere>.
if (typeof globalThis.HTMLElement === "function" && globalThis.customElements) define();
