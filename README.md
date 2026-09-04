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

Not possible from a browser, and therefore not included: Lobsters (its URL
lookup sends no CORS headers), Mastodon (no URL search without a token),
Reddit's own API (OAuth only).

The module sends nothing else: no cookies (`credentials: "omit"`), no
identifiers, no telemetry.

## Use

```html
<div id="discussions" data-url="https://example.com/post/"></div>
<script type="module">
  import { mount } from "./discussed-elsewhere.js";
  mount(document.getElementById("discussions"));
</script>
```

`mount(element, options)` waits until the element comes within `rootMargin`
(300 px) of the viewport, then runs the lookup once and renders a list:

```html
<ul>
  <li class="comment-line"><a href="https://news.ycombinator.com/item?id=…"><span class="platform">Hacker News</span> (<span class="count">12 comments</span>)</a></li>
  <li class="comment-line"><a href="…"><span class="platform">Reddit r/linux</span> (<span class="count">3 comments</span>)</a></li>
</ul>
```

While waiting it shows `<p class="loading">`, with nothing found
`<p class="empty">`, and when every source failed `<p class="is-error">`.
Partial failures still render whatever was found.

Options (all optional):

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | `data-url`, else `<link rel=canonical>`, else the page address | the article to look up |
| `sources` | `["hn", "reddit", "bluesky", "lemmy"]` | ids from `sources`, or your own `{ id, label, hosts, lookup }` objects |
| `lemmy.instance` | `"lemmy.world"` | which Lemmy instance to ask |
| `bluesky.minEngagement` | `1` | ignore Bluesky posts with fewer replies + likes + reposts + quotes |
| `timeout` | `5000` | per-request timeout in ms |
| `rootMargin` | `"300px"` | how early before the box scrolls into view the lookup starts |
| `saveData` | `true` | skip the lookup when the browser reports `navigator.connection.saveData` |
| `messages` | English defaults | `loading`, `empty`, `error` strings and `comments(n)` |
| `render` | `renderList` | `(element, state, messages)` to draw it yourself |

`mount` returns `{ load, cancel, element, url }`. `load()` runs the lookup
right away (idempotent), which is what a screenshot test wants; `cancel()`
stops watching and aborts anything in flight. The element dispatches a
bubbling `discussed-elsewhere` event with `{ status, discussions, errors }`
when the lookup settles.

Without the DOM, `discover(url, options)` returns
`{ discussions, errors }`, each discussion being
`{ source, label, url, title, comments, score, date, posts }`, sorted by
comment count then score.

### Content-Security-Policy

`connectSources(ids, options)` returns the origins to allow, for the default
sources:

```
connect-src https://hn.algolia.com https://arctic-shift.photon-reddit.com https://constellation.microcosm.blue https://public.api.bsky.app https://lemmy.world
```

### Hugo

Copy `src/discussed-elsewhere.js` into `assets/js/vendor/`, write an entry
that imports it, and bundle with `js.Build`:

```go-html-template
{{ $js := resources.Get "js/discussions.js" | js.Build (dict "minify" true) }}
<script src="{{ $js.RelPermalink }}"></script>
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
