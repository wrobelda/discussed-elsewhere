# TODO

## `webmention` source

Read `https://webmention.io/api/mentions.jf2?target=<url>`. The endpoint is
keyless and answers with `Access-Control-Allow-Origin: *`, so a site that
registered at webmention.io and carries `<link rel="webmention">` gets
mentions from anywhere that sends them:

- Lobsters, which sends one per submission, five minutes after it;
- Bridgy backfeed, which covers Mastodon and Bluesky;
- other blogs.

Shape of the result, one discussion per source domain:

- `label`: from the `wm-source` host, for example "Lobsters" or
  "mastodon.social";
- `comments`: the count of `in-reply-to` items;
- `score`: likes plus reposts;
- `url`: the mention with the most replies;
- `date`: the newest `published`.

Add an option `webmention: { endpoint }` for a self-hosted receiver with the
same API. Add the host to `connectSources()` and to the README table.

## Lobsters directly

Not possible from a browser, because `/stories/url/all` sends no CORS
headers and the maintainers declined to add them (lobsters#1029). The
webmention source above is the way; keep the note in the README.

## Mastodon

No URL search without a token. It is reachable only through webmentions
(Bridgy) or a server-side proxy, so it is not planned.
