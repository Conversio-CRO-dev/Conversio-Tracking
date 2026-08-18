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
- From 2.4.1 on, the bundle in `self-hosted/public/` is **generated** from the
  GTM file by `self-hosted/scripts/build-bundle.mjs`, which strips the comments
  (keeping the licence header) so visitors download roughly half the bytes.
  Edit the GTM file, never the bundle, and rebuild:

  ```bash
  cd self-hosted && node scripts/build-bundle.mjs 2.4.2
  ```

  `--check` instead exits non-zero if the committed bundle is stale, so it can
  be wired into CI alongside the test suites. Bundles up to 2.4 predate this and
  are left as they were, comments included.
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
node test/runtime-tag-2.4.2.test.js
```

This runs the same set of checks against both shipped copies of the 2.4.2 tag,
the GTM dev file (`conversio_runtime_tag_v2.4.2.js`) and the self-hosted bundle
(`self-hosted/public/runtime-tag.2.4.2.js`), so the two can't silently diverge.
Since 2.4.1 the bundle is the comment-stripped build rather than a copy, which
means the suite is verifying the exact bytes clients receive. A passing run looks
like:

```
conversio_runtime_tag_v2.4.2.js: 172 passed, 0 failed
self-hosted/public/runtime-tag.2.4.2.js: 172 passed, 0 failed

TOTAL: 344 passed, 0 failed
```

There's a second suite for the self-hosted loader Worker, which runs it against
stubbed Cloudflare bindings and then feeds the bytes it serves through the same
browser harness, so the tracking ID substitution is verified by the tag
actually reading it back:

```bash
node test/loader.test.js
```

Both exit non-zero if anything fails, so they're safe to wire into CI. Earlier
versions keep their own suites (`test/runtime-tag-2.4.1.test.js`,
`test/runtime-tag-2.4.test.js`, `test/runtime-tag-2.3.test.js`), which still pass
and are worth keeping green while any client is pinned to those bundles.

### What it covers (2.4.2)

Everything in 2.4.1 below, minus INP. 2.4.1 added it to `conversio_vitals`;
2.4.2 takes it back out. It measures the page's own main-thread work rather than
anything an experience changes, so the figure moved with whatever else a client
shipped and never with us, and the few seconds this tag collects for left it
`null` on most page loads anyway. `conversio_vitals` is `{lcp, fcp, cls, ps}`
again.

The section is written as a rollback check rather than deleted alongside the
code, so the interaction fixtures stay in the harness and have to reach nothing:
that the vitals object holds exactly `lcp`, `fcp`, `cls` and `ps` and no `inp`
key at all; that neither of the fixture's interaction latencies turns up under
some other key; that no `PerformanceObserver` registers for the `event` entry
type or asks for a `durationThreshold`, so observing every interaction on the
page is a cost that is gone rather than merely unreported; and that an
interaction latency is no longer a successful collection on its own, a page whose
only measurable entries are interactions now sending no vitals block and writing
no snapshot.

Two of them are about the version boundary rather than the removal, since a
visitor can meet 2.4.2 mid-session with a 2.4.1 snapshot already in
`sessionStorage`: an `inp` left in that snapshot is not forwarded to GA, the
parameter being built from the vitals this version reports; and a snapshot whose
only successful measurement was the interaction sends no vitals parameter at all
rather than an `inp`-only one.

Everything else 2.4.1 introduced is unchanged and still covered below.

### What it covers (2.4.1)

Everything in 2.4 below, plus the four things 2.4.1 changes.

First, `conversio_vitals` in the GA4 payload now rides with the
`conversio_experience_session` send only: that the experience send still carries
the block; that the `conversio_event_instance` send no longer has the key at
all, while every other parameter it carried in 2.4 is untouched; that a page
with one experience and three events reports its vitals once rather than four
times; and that the same split holds on the buffer/flush path, where both sends
necessarily happen after collection has finished.

Then the `conversio_id` timestamp, which used to end in a fixed `00` because no
browser clock resolves microseconds. The suite simulates the clamped clock a
real browser exposes (`test/harness.js` takes `perfTimeOrigin`/`perfNow`, and
drops them entirely to exercise the `Date.now()` fallback): 200 ids minted on
that clock must vary in their last two digits rather than all ending the same
way, must stay inside the 100us window the clock reading actually points at, and
must still be safe-integer, microsecond-scale Unix times. The `Date.now()`
fallback gets the same treatment at its own millisecond granularity. A clock
resolving finer than the usual clamp keeps its real reading rather than having
those digits re-randomised, and the stored format is unchanged, so an id minted
by 2.4 is still valid and is reused on a visitor's first 2.4.1 page load.

Last, `inp` in the vitals object, so `conversio_vitals` is now
`{lcp, fcp, cls, inp, ps}`. The checks are mostly about what counts as one
interaction: that events sharing an `interactionId` are a single interaction
reported as the longest of them rather than their sum; that an `interactionId`
of 0 (a scroll, a mousemove) is never reported as an interaction latency; that
Google's rule of discounting one interaction per 50 is applied, so a 49
interaction page reports its worst and a 50 interaction page reports its second
worst; that a page nobody interacted with reports `null` rather than 0, which
would claim a perfect score for a page never put to the test; that an
interaction too fast to be reportable is indistinguishable from none; that an
interaction latency on its own is enough to make a vitals block worth sending
when every other measurement failed; and that `inp` reaches GA on the experience
send with the parameter still inside GA4's 100-character limit.

Finally the shape of the GA4 string parameters, which are delimited rather than
JSON from 2.4.1: that segment lists come out comma separated in the order they
were seen; that vitals come out as `key:value` pairs; that none of the three
carries a quote, bracket or brace any more; that each is shorter than the JSON it
replaces; that an empty list is an empty parameter rather than `[]`; that a
failed or non-finite measurement is left out rather than sent as `null` or
`NaN`; that a long float is rounded to what the clock could resolve; that a
non-string hand-edited into a stored list is dropped rather than reaching GA as
`[object Object]`; and that none of this touched the internal snapshot or the
dataLayer payload, which are still JSON and a full-precision object
respectively.

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
`test/runtime-tag-2.4.2.test.js`: point `TAG_PATHS` at the new file(s) and reuse
`test/harness.js` as-is, since the harness itself is version-agnostic. Bump
`BUNDLE_VERSION` in `test/loader.test.js` too, so the loader suite exercises
the current bundle.
