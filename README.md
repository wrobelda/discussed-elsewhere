# discussed-elsewhere

A small browser module that finds where an article is being discussed and
lists the threads under it: Hacker News, Reddit, Bluesky and Lemmy, with the
comment count of each thread. No build step, no dependencies, no API keys,
and no server: every lookup is a cross-origin JSON request the browser makes
itself, so the module works on a static site with a strict
Content-Security-Policy (no inline scripts, an explicit `connect-src`).

It replaces the "discussions around the web" box that discu.eu used to power
for static blogs; that service died in 2025.

## Sources

| Source | Endpoint the browser contacts | What it is told |
| --- | --- | --- |
| Hacker News | `hn.algolia.com` (HN's official search API) | the article URL |
| Reddit | `arctic-shift.photon-reddit.com` (a public archive mirror; reddit.com refuses unauthenticated JSON since 2026) | the article URL |
| Bluesky | `constellation.microcosm.blue` (an independent backlink index), then `public.api.bsky.app` | Constellation gets the URL; Bluesky only post ids |
| Lemmy | one instance, `lemmy.world` by default | the article URL |

Not reachable directly from a browser: Lobsters (its URL lookup sends no
CORS headers) and Mastodon (no URL search without a token). Both reach a
site through webmentions instead: Lobsters sends one for every submission,
and Bridgy backfeeds Mastodon and Bluesky replies; a `webmention` source
reading webmention.io is the next item in `TODO.md`. Reddit's own API is
OAuth-only, hence the archive mirror.

The module sends nothing else: no cookies (`credentials: "omit"`), no
identifiers, no telemetry.

## Use

```html
<script type="module" src="discussed-elsewhere.js"></script>

<discussed-elsewhere url="https://example.com/post/"></discussed-elsewhere>
```

Importing the module registers the element. It looks the article up as
soon as it is on the page, like an `<img>`, and renders a list into itself,
in the light DOM, so your stylesheet styles it:

```html
<ul>
  <li class="comment-line"><a href="https://news.ycombinator.com/item?id=…"><span class="platform">Hacker News</span> (<span class="count">12 comments</span>)</a></li>
  <li class="comment-line"><a href="…"><span class="platform">Reddit r/linux</span> (<span class="count">3 comments</span>)</a></li>
</ul>
```

While waiting it shows `<p class="loading">`, with nothing found
`<p class="empty">`, and when every source failed `<p class="is-error">`.
Partial failures still render whatever was found, and each failed source
is a console warning.

Attributes (all optional):

| Attribute | Default | Meaning |
| --- | --- | --- |
| `url` | `<link rel=canonical>`, else the page address | the article to look up |
| `sources` | `hn,reddit,bluesky,lemmy` | comma-separated source ids |
| `loading` | `eager` | `lazy` waits until the element comes within `root-margin` of the viewport, as `<img loading="lazy">` does |
| `root-margin` | `300px` | for `loading="lazy"` |
| `lemmy-instance` | `lemmy.world` | which Lemmy instance to ask |
| `timeout` | `5000` | per-request timeout in ms |
| `loading-text`, `empty-text`, `error-text` | English | the three status lines |

Properties, for what attributes cannot carry: `messages` (an object with
`loading`, `empty`, `error` and `comments(n)`), `render(element, state,
messages)` to draw it yourself, and `options`, extra `discover()` options
such as a custom `fetch`. Set them right after the element or the script,
the first lookup waits a microtask.

Methods and events: `load()` runs the lookup now, once, and returns the
same promise afterwards, which is what a screenshot test wants; `cancel()`
aborts it. A bubbling `settled` event with `{ status, discussions, errors }`
follows the final render. A reader's data-saver setting skips the automatic
lookup; `load()` still works.

Another tag name: `define("my-discussions")` before the default
registration runs, i.e. from a module that imports this one.

Without the DOM, `discover(url, options)` returns
`{ discussions, errors }`, each discussion being
`{ source, label, url, title, comments, score, date, posts }`, sorted by
comment count then score. Options: `sources`, `lemmy.instance`,
`bluesky.minEngagement` (ignore Bluesky posts with fewer replies + likes +
reposts + quotes, default 1), `timeout`, `signal`, `fetch`.

### Content-Security-Policy

`connectSources(ids, options)` returns the origins to allow, for the default
sources:

```
connect-src https://hn.algolia.com https://arctic-shift.photon-reddit.com https://constellation.microcosm.blue https://public.api.bsky.app https://lemmy.world
```

### Hugo

`npm install discussed-elsewhere`, then an entry that imports it, bundled
with `js.Build` (which resolves `node_modules`):

```js
// assets/js/discussions.js
import "discussed-elsewhere";
```

```go-html-template
{{ $js := resources.Get "js/discussions.js" | js.Build (dict "minify" true) }}
<script src="{{ $js.RelPermalink }}"></script>
```

```go-html-template
<discussed-elsewhere url="{{ .Permalink }}" loading-text="Looking up discussions…"></discussed-elsewhere>
```

## Why not a server

A same-origin aggregator (a Worker or function) would only repeat these
requests, add a cache to keep, and put a new failure mode in front of a box
that is decoration. The requests are cheap, keyless and cacheable by the
browser; the box asks for them only when a reader scrolls that far.

## Tests

```sh
npm install
npm test          # unit tests with a fake fetch
npm run smoke     # live lookup of a known URL against the real endpoints
```

## Credits

See `THIRD-PARTY.md`: the endpoint map follows Backchannel (MIT).
