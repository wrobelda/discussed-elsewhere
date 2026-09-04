// discussed-elsewhere: find where an article is being discussed and list the
// threads. Browser-only, dependency-free, keyless: every source below answers
// cross-origin JSON to an unauthenticated fetch, so the script runs under a
// strict Content-Security-Policy with connect-src limited to these hosts:
//
//   hn        https://hn.algolia.com
//   reddit    https://arctic-shift.photon-reddit.com   (archive mirror;
//             reddit.com itself refuses unauthenticated JSON since 2026)
//   bluesky   https://constellation.microcosm.blue     (backlink index) and
//             https://public.api.bsky.app              (post counts)
//   lemmy     https://<instance>                       (lemmy.world by default)
//
// Lobsters has a URL lookup (/stories/url/all) but sends no CORS headers, so
// it cannot be a browser source; Mastodon has no URL search at all.
//
// The endpoint map follows Backchannel (github.com/twalichiewicz/Backchannel,
// MIT), a userscript that does the same lookup with extension privileges.

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
            label: `Lemmy !${view.community?.name || "?"}@${home}`,
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

// Look the URL up on every source and gather the results.
// options: sources (ids or source objects), timeout (ms per request, 5000),
// signal, fetch (defaults to globalThis.fetch), lemmy: { instance },
// bluesky: { minEngagement }.
// Returns { discussions, errors }: discussions sorted by comment count then
// score, errors as { source, error } for each source that failed.
export async function discover(url, options = {}) {
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

// Attach to an element and look the article up once the element comes near
// the viewport. options: everything discover() takes, plus url (defaults to
// data-url, then <link rel=canonical>, then the page address), rootMargin
// ("300px"), render(element, state, messages), messages, saveData (skip the
// lookup when the reader asked for reduced data, true).
// Returns { load(), cancel(), element }: load() runs the lookup now (once; the
// same promise afterwards), cancel() stops watching and aborts a lookup in
// flight.
export function mount(element, options = {}) {
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  const url = options.url || element.dataset.url || doc.querySelector('link[rel~="canonical"]')?.href || win.location.href;
  const render = options.render || renderList;
  const messages = { ...DEFAULT_MESSAGES, ...(options.messages || {}) };
  const controller = new AbortController();
  let observer = null;
  let promise = null;

  const load = () => {
    if (promise) return promise;
    observer?.disconnect();
    observer = null;
    render(element, { status: "loading", discussions: [], errors: [] }, messages);
    promise = discover(url, { ...options, signal: anySignal([controller.signal, options.signal]) })
      .then(({ discussions, errors }) => {
        if (controller.signal.aborted) return;
        const status = discussions.length || !errors.length ? "done" : "error";
        render(element, { status, discussions, errors }, messages);
        element.dispatchEvent(new win.CustomEvent("discussed-elsewhere", { bubbles: true, detail: { status, discussions, errors } }));
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        render(element, { status: "error", discussions: [], errors: [{ source: "*", error }] }, messages);
      });
    return promise;
  };

  const cancel = () => {
    observer?.disconnect();
    observer = null;
    controller.abort();
  };

  const saveData = options.saveData ?? true;
  if (saveData && win.navigator?.connection?.saveData) return { load, cancel, element, url };

  if (typeof win.IntersectionObserver === "function") {
    observer = new win.IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
      },
      { rootMargin: options.rootMargin ?? "300px" },
    );
    observer.observe(element);
  } else {
    load();
  }
  return { load, cancel, element, url };
}
