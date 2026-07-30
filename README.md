# Conversio-Tracking

The Conversio runtime tag: a dataLayer-based tracking script pasted into a
client's GTM container (or served via the [self-hosted loader](self-hosted/README.md)),
plus the tooling around it.

- `conversio_runtime_tag_v*.js` - the tag itself, one file per version. Each
  is a self-contained, dependency-free IIFE written in ES5 (`var`/`function`,
  no arrow functions, `let`/`const`, optional chaining, `??`, `.at()`,
  template literals, or `Promise`), since a parse-time `SyntaxError` in this
  file breaks tracking entirely, not just the feature that introduced it.
- `self-hosted/` - a Cloudflare Worker that serves the same bundles from one
  hostname, gated by a per-client key. See its own README for setup and
  day-to-day client management.
- `test/` - a behavioural test suite for the runtime tag (below).

---

## Testing

`test/` contains a Node-based test suite that loads the actual tag source
into a minimal simulated browser (`test/harness.js` stubs just enough of
`window`, `document`, `performance`, `localStorage`/`sessionStorage`, and
`PerformanceObserver` to run it) and asserts on what the tag pushes to
`dataLayer` and what it writes to storage. No external dependencies or
installs are required, only Node itself.

Run the suite for the current version with:

```bash
node test/runtime-tag-2.3.test.js
```

This runs the same set of checks against both shipped copies of the 2.3 tag,
the GTM dev file (`conversio_runtime_tag_v2.3.js`) and the self-hosted bundle
(`self-hosted/public/runtime-tag.2.3.js`), so the two can't silently diverge.
A passing run looks like:

```
conversio_runtime_tag_v2.3.js: 77 passed, 0 failed
self-hosted/public/runtime-tag.2.3.js: 77 passed, 0 failed

TOTAL: 154 passed, 0 failed
```

It exits non-zero if anything fails, so it's safe to wire into CI.

### What it covers (2.3)

- `conversio_id` format (`con_<16-char random>.<microsecond timestamp>`) and
  that it lands only on the `conversio_data` event, not on
  `conversio_experience_session` or `conversio_event_instance`.
- The emission-consent gate: no id is minted or written to `localStorage`
  before emission is enabled, a visitor who never consents leaves nothing
  behind, and the id is resolved at flush time once consent arrives.
- `conversio_data` firing exactly once per page load regardless of Core Web
  Vitals outcome: success attaches `conversio_vitals`, failure or an
  unsupported browser still fires the event with `conversio_id` alone.
- Recovery from a malformed or tampered stored id, and from a blocked or
  absent `localStorage`.
- The single-event-per-page-load guarantee under the trickier orderings,
  including a stale payload left in `sessionStorage` by an earlier page load
  in the same session (must be discarded, not flushed alongside this page's
  own event), and a pending payload in the older 2.2 shape (must not leak
  into the new payload).

### Adding a new version

When a new tag version needs its own suite, copy the pattern in
`test/runtime-tag-2.3.test.js`: point `TAG_PATHS` at the new file(s) and reuse
`test/harness.js` as-is, since the harness itself is version-agnostic.
