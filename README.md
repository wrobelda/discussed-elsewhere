# discussed-elsewhere

A browser module that finds where an article is being discussed and lists
the threads under it, with the comment count of each thread. It covers
Hacker News, Reddit, Bluesky and Lemmy.

It needs no build step, no dependencies, no API keys and no server, because
every lookup is a cross-origin JSON request that the browser makes itself.
So it works on a static site with a strict Content-Security-Policy: no
inline scripts, and an explicit `connect-src`.

It replaces the "discussions around the web" box that discu.eu used to
power for static blogs; that service died in 2025.

## Sources

| Source | Endpoint | Receives | Remarks |
| --- | --- | --- | --- |
| Hacker News | `hn.algolia.com`, the official search API | the article URL | |
| Reddit | `arctic-shift.photon-reddit.com`, a public archive mirror | the article URL | reddit.com refuses unauthenticated JSON since 2026, and its own API is OAuth-only, so the archive stands in |
| Bluesky | `constellation.microcosm.blue`, an independent backlink index, then `public.api.bsky.app` | Constellation gets the URL; Bluesky gets post ids only | |
| Lemmy | one instance, `lemmy.world` by default | the article URL | |
| Lobsters (via webmention.io) | `webmention.io`, planned, see `TODO.md` | the article URL | Lobsters' URL lookup sends no CORS headers, but Lobsters sends a webmention to the article for every submission |
| Mastodon (via webmention.io) | `webmention.io`, planned, see `TODO.md` | the article URL | Mastodon has no URL search without a token, but Bridgy forwards the replies as webmentions |

## Use

```html
<script type="module" src="discussed-elsewhere.js"></script>

<discussed-elsewhere url="https://example.com/post/"></discussed-elsewhere>
```

From npm, a bundled entry does the same with `import "discussed-elsewhere";`.
Importing the module registers the element. The element looks the article
up as soon as it is on the page, like an `<img>` does, and renders a list
into its own light DOM, so your stylesheet styles it:

```html
<ul>
  <li class="comment-line"><a href="https://news.ycombinator.com/item?id=…"><span class="platform">Hacker News</span> (<span class="count">12 comments</span>)</a></li>
  <li class="comment-line"><a href="…"><span class="platform">Reddit r/linux</span> (<span class="count">3 comments</span>)</a></li>
</ul>
```

Before the list, or instead of it, the element shows one of three status
lines:

- `<p class="loading">` while the lookup runs;
- `<p class="empty">` when nothing was found;
- `<p class="is-error">` when every source failed.

A partial failure still renders what was found, and each failed source
becomes a console warning.

### Attributes

All attributes are optional.

| Attribute | Default | Meaning |
| --- | --- | --- |
| `url` | the `<link rel=canonical>`, else the page address | the article to look up |
| `sources` | `hn,reddit,bluesky,lemmy` | comma-separated source ids |
| `loading` | `eager` | `lazy` waits until the element comes within `root-margin` of the viewport, like `<img loading="lazy">` |
| `root-margin` | `300px` | the distance for `loading="lazy"` |
| `lemmy-instance` | `lemmy.world` | the Lemmy instance to ask |
| `timeout` | `5000` | the per-request timeout in ms |
| `loading-text`, `empty-text`, `error-text` | "Looking up discussions…", "No discussions found.", "Could not look up discussions." | the three status lines |

### Properties

Properties carry what attributes cannot:

- `messages`: an object with `loading`, `empty`, `error` and `comments(n)`;
- `render(element, state, messages)`: a function that draws the state
  yourself;
- `options`: extra `discover()` options, such as a custom `fetch`.

Set them right after the element or the script, because the first lookup
waits one microtask before it starts.

### Methods and events

- `load()` runs the lookup now, once, and resolves to the settled
  `{ status, discussions, errors }`; later calls return the same promise.
  This is what a screenshot test wants.
- `cancel()` aborts the lookup and stops watching the viewport; a later
  `load()` starts afresh.
- A bubbling `settled` event with `{ status, discussions, errors }` follows
  the final render.

A reader's data-saver setting skips the automatic lookup; `load()` still
works.

To register the element under another tag name as well, call
`define("my-discussions")`.

### Without the DOM

`discover(url, options)` returns `{ discussions, errors }`. Each discussion
is `{ source, label, url, title, comments, score, date, posts }`, and the
list is sorted by comment count, then score. The options are:

- `sources`: source ids or source objects;
- `lemmy.instance`: the Lemmy instance;
- `bluesky.minEngagement`: ignore Bluesky posts with fewer replies, likes,
  reposts and quotes than this; the default is 1;
- `timeout`, `signal`, `fetch`.

### Content-Security-Policy

`connectSources(ids, options)` returns the origins to allow. For the
default sources:

```
connect-src https://hn.algolia.com https://arctic-shift.photon-reddit.com https://constellation.microcosm.blue https://public.api.bsky.app https://lemmy.world
```

## Tests

```sh
npm install
npm test          # unit tests with a fake fetch
npm run smoke     # live lookup of a known URL against the real endpoints
```

## Credits

See `THIRD-PARTY.md`: the endpoint map follows Backchannel (MIT).
