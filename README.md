# Conversio-Tracking

The Conversio runtime tag: a dataLayer-based tracking script pasted into a
client's GTM container (or served via the [self-hosted loader](self-hosted/README.md)),
plus the tooling around it.

- `conversio_runtime_tag_v*.js` - the tag itself, one file per version. Each
  is a self-contained, dependency-free IIFE written in ES5 (`var`/`function`,
  no arrow functions, `let`/`const`, optional chaining, `??`, `.at()`,
  template literals, or `Promise`), since a parse-time `SyntaxError` in this
  file breaks tracking entirely, not just the feature that introduced it.
- `self-hosted/` - a Cloudflare Worker that serves those bundles from one
  hostname, gated by a per-client key, and patches each client's own
  settings (currently a GA tracking ID) into the bundle as it serves it. See
  its own README for setup and day-to-day client management.
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
node test/runtime-tag-2.4.test.js
```

This runs the same set of checks against both shipped copies of the 2.4 tag,
the GTM dev file (`conversio_runtime_tag_v2.4.js`) and the self-hosted bundle
(`self-hosted/public/runtime-tag.2.4.js`), so the two can't silently diverge.
A passing run looks like:

```
conversio_runtime_tag_v2.4.js: 122 passed, 0 failed
self-hosted/public/runtime-tag.2.4.js: 122 passed, 0 failed

TOTAL: 244 passed, 0 failed
```

There's a second suite for the self-hosted loader Worker, which runs it against
stubbed Cloudflare bindings and then feeds the bytes it serves through the same
browser harness, so the tracking ID substitution is verified by the tag
actually reading it back:

```bash
node test/loader.test.js
```

Both exit non-zero if anything fails, so they're safe to wire into CI. Earlier
versions keep their own suites (`test/runtime-tag-2.3.test.js`), which still
pass and are worth keeping green while any client is pinned to that bundle.

### What it covers (2.4)

Everything in 2.3 below, plus the client-level tracking ID: that an
un-substituted slot, an empty substitution, and a whitespace one all read as
"not configured" rather than leaking the placeholder; that the value lands on
`window.conversioSettings` before any dataLayer processing and without waiting
on emission consent; that it stays off the `conversio_data` payload; and that
a pre-existing `window.conversioSettings` from another tag keeps its own keys.

Then the GA4 delivery built on it: that each experience and event emit sends
one `conversio_cro` pinned to the key's property with `send_to`; that the
parameters map to the right source fields and the two segment lists aren't
crossed; that a client with no tracking ID sends nothing while its dataLayer
emits carry on unaffected; that nothing is sent pre-consent and buffered events
reach GA on flush; that `conversio_vitals` rides along only when the emit
happens after Core Web Vitals collection finished; that the command queues on
`dataLayer` when `window.gtag` isn't there yet; that a throwing `gtag` costs
neither the dataLayer emit nor `conversio_data`; and that the tag never issues
a `config` or `js` command against the client's property.

`test/loader.test.js` covers the Worker half: substitution end to end, the
no-tracking-ID and pre-2.4-bundle cases, the access-control decisions, and
that a hostile value hand-edited into KV is dropped rather than spliced into
the JS served on every page of that client's site.

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
`test/runtime-tag-2.4.test.js`: point `TAG_PATHS` at the new file(s) and reuse
`test/harness.js` as-is, since the harness itself is version-agnostic. Bump
`BUNDLE_VERSION` in `test/loader.test.js` too, so the loader suite exercises
the current bundle.
