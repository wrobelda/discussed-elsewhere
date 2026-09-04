# TODO

- [ ] **`webmention` source.** Reads `https://webmention.io/api/mentions.jf2?target=<url>`
      (keyless, `Access-Control-Allow-Origin: *`), so a site that registered
      at webmention.io and carries `<link rel="webmention">` gets mentions
      from anywhere that sends them: Lobsters (sends one per submission,
      five minutes after), Bridgy backfeed (Mastodon, Bluesky), other blogs.
      Shape: one discussion per source domain (`wm-source` host), label
      from the domain ("Lobsters", "mastodon.social", …), `comments` = count
      of `in-reply-to` items, `score` = likes + reposts, `url` = the mention
      with the most replies, `date` = newest `published`. Options:
      `webmention: { endpoint }` for a self-hosted receiver with the same
      API. Add the host to `connectSources()` and the README table.
- [ ] **Lobsters directly** is impossible from a browser (`/stories/url/all`
      sends no CORS headers, maintainers declined in lobsters#1029); the
      webmention source above is the way. Keep a note in the README.
- [ ] **Mastodon** has no URL search without a token; only via webmention
      (Bridgy) or a server-side proxy. Not planned.
- [ ] **Distribution.** Publish to npm (name is free), so a Hugo site can
      `npm install discussed-elsewhere` and `import { mount } from
      "discussed-elsewhere"` through `js.Build`; until then sites vendor
      `src/discussed-elsewhere.js`.
