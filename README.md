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
  cd self-hosted && node scripts/build-bundle.mjs 2.6.2
  ```

  `--check` instead exits non-zero if the committed bundle is stale, so it can
  be wired into CI alongside the test suites. Bundles up to 2.4 predate this and
  are left as they were, comments included.
- `test/` - a behavioural test suite for the runtime tag (below).

## Trigger events

The tag is driven by dataLayer events the client's container pushes: an
experience (`experience_segment`, `experience_category`, `experience_action`,
`experience_label`) and an event (`event_segment` and the same three). From
2.6.1 each of those fields also answers to a camelCase name, so a legacy
campaign pushing `experienceAction` reports what a current one pushing
`experience_action` does (below).

From 2.5 there are **two independent streams of them**. The Conversio stream is
ours, reporting what our experiences do. The client stream is the client's own,
so they can report their experiences and events through the same tag and have
them arrive in GA4 shaped identically. Each stream has its own trigger names, its
own payload key, and its own storage:

| Pushes | Names accepted | Payload key |
| --- | --- | --- |
| a Conversio experience | `conversioExperience`, `conversio_experience` | `conversio` |
| a Conversio event | `conversioEvent`, `conversio_event` | `conversio` |
| a client experience | `client_experience` | `client` |
| a client event | `client_event` | `client` |

```js
// Conversio's own, either name
dataLayer.push({ event: 'conversio_experience', conversio: {
  experience_segment: 'homepage-hero-v2', experience_category: 'Homepage',
  experience_action: 'Hero test', experience_label: 'Variant B'
}});

// the client's own
dataLayer.push({ event: 'client_event', client: {
  event_segment: 'newsletter-signup', event_category: 'Newsletter',
  event_action: 'Signup', event_label: 'Footer form'
}});
```

Either experience can also be pushed by the [AB Tasty helper](#the-ab-tasty-helper-26-queued-from-262)
rather than by the container, which derives the payload from the campaign instead
of being handed it.

The payload key is part of the match, so a `client_experience` carrying a
`conversio` payload is not a trigger, and neither is the reverse. The two streams
share no storage: a segment reported to one is invisible to the other, and each
keeps its own map, list, fired set and buffer. What the client stream does not
have is an identity of its own: there is no `client_id` and no `client_data`, and
a client send carries neither the `conversio_id` nor the vitals. See
[the self-hosted README](self-hosted/README.md) for what each stream sends to
GA4.

Consent is one signal for both streams: it is a fact about the visitor rather
than about a stream, so a consent platform needs no second call. The state is
stored per stream, so neither reads the other's key.

**From 2.6.3, push it to `conversioConsentQueue` rather than calling the control
directly.** The queue is the idiom to write against, and it exists for the reason
the AB Tasty one does: the controls are assigned when this tag executes, and the
loader delivers it through a container rather than inline, so a platform
resolving already-stored consent early in the page loses that race as the
ordinary case rather than the exception. A grant lost that way is not an error
anywhere. It is a session that emits nothing while the loader serves a clean 200
throughout.

```js
(window.conversioConsentQueue = window.conversioConsentQueue || []).push('granted');
```

Pushed before the tag, the command waits; pushed after, it applies on the push.
So the one line above is correct wherever it runs, which matters because it is
wired once per client by people who cannot know which order they will get.
Consent stays the client's to signal and theirs to decide: this changes only how
the signal arrives.

It reads `enable`, `enabled`, `grant`, `granted` and `true` as a grant, the
`disable`, `disabled`, `deny`, `denied` set and `false` as a withdrawal, and
`flush` as a release of whatever is buffered without moving the gate, in any
case. A GTM variable holding a consent state is as likely to resolve to a boolean
as to a word, so both read the same way and there is one rule rather than two.
Commands apply in the order they were pushed, so a platform that grants and then
withdraws within one page lands on the withdrawal.

Anything unrecognised is stepped over rather than falling back to a default,
because the only useful default here would be a grant, and a queue that reads a
typo as consent is worse than one that ignores it: the visitor never agreed, and
nothing downstream could tell the difference. One malformed item does not end the
drain, and a queue holding something that is not an array at all still leaves the
tag initialised.

`window.__conversioEnableEmission__()` and its two siblings stay and are
unchanged, so a client already calling them keeps working exactly as before.

The tag a client actually pastes for this is
[`conversio_session_initiator_v1.5.js`](conversio_session_initiator_v1.5.js), fired
on their own consent trigger. It pushes as above and then calls the control behind a
`typeof` guard, which is not belt and braces for its own sake: a client pinned to a
bundle older than 2.6.3 has no queue to drain, so the push alone would land in an
array nothing reads, and rolling a client back a version is a normal part of
releasing rather than only an un-migrated state. On 2.6.3 the guarded call is
redundant rather than harmful, granting twice being idempotent. Version 1.4 called
the control alone and loses the race described above whenever the loader serves the
tag.

On the Conversio names, the snake_case pair arrived in 2.4.2 and is where the
naming is heading; the camelCase pair is what every client pushes today and stays
supported. Nothing downstream of the match knows which name arrived, so a
container can move over whenever it does, and one part-way through the move can
push each. The client stream is new and accepts the snake_case name only.

The four payload fields have a legacy spelling of their own, accepted from
2.6.1. Each answers to the snake_case name above and to a camelCase one, nested
under the same payload key:

| Canonical | Also accepted |
| --- | --- |
| `experience_segment` | `experienceSegment` |
| `experience_category` | `experienceCategory` |
| `experience_action` | `experienceAction` |
| `experience_label` | `experienceLabel` |
| `event_segment` | `eventSegment` |
| `event_category` | `eventCategory` |
| `event_action` | `eventAction` |
| `event_label` | `eventLabel` |

```js
// a legacy campaign, reporting exactly what the snake_case push above reports
dataLayer.push({ event: 'conversioExperience', conversio: {
  experienceSegment: 'homepage-hero-v2', experienceCategory: 'Homepage',
  experienceAction: 'Hero test', experienceLabel: 'Variant B'
}});
```

This is what lets a campaign written years ago keep reporting through a tag
upgraded underneath it. A campaign live on a client's site is not something
anyone can go back and re-key: it is running, it is collecting, and rewriting its
snippet to take a tag version would risk the results it exists to produce.

The canonical name wins wherever it carries a value, and the legacy name is read
only where it does not, so a container part-way through a move can push each and
a payload carrying both spellings of one field has a defined answer. Only these
eight names are read; a camelCase key outside the list reaches nothing.

Normalisation happens once, where the pushed item is first read, so the outbound
shape is untouched: a legacy campaign's push is emitted under the snake_case
names, and a client's downstream tags keep reading the one spelling they read
today rather than gaining a second one to handle. Both streams normalise, though
only the Conversio one has legacy campaigns behind it.

What a container must not do is push two accepted names for the same occurrence.
Experiences would survive it, being de-duplicated by segment, but an event is one
instance per push and a second push is a second instance.

---

## The AB Tasty helper (2.6, queued from 2.6.2)

An AB Tasty test reports itself as a Conversio experience by handing the tag a
campaign id. From 2.6.2 the way to do that is a queue. This is the form to paste
into an AB Tasty test, with the three values to fill in named and on their own
lines at the top:

```js
var test_number         = '1577840';  // AB Tasty campaign ID
var is_sampled_test     = false;      // true only for a sampled run
var report_to_conversio = true;       // true = Conversio reporting, false = client's own

(window.conversioAbtastyQueue = window.conversioAbtastyQueue || []).push({
  testId:     test_number,
  sample:     is_sampled_test,
  experience: report_to_conversio
});
```

Those three variable names are the test's own and the tag never sees them: only
the object keys `testId`, `sample` and `experience` are the contract, so name the
inputs whatever reads clearest to whoever fills them in. Two names are worth
avoiding, though, and they are the obvious ones: `conversio_sample` and
`conversio_experience` are what the [direct call](#the-direct-call-26) reads off
the window, and a global `var` of either name sets that window flag as a side
effect. Harmless for the queued push, which takes its flags from the item, but it
would divert any other test on the page still calling the function.

Wrapping the whole thing in an IIFE keeps all three names off the window and is
worth doing on a page that runs several tests, though since each push runs
synchronously straight after its own assignment the flat form above is fine in
practice.

Only `testId` is required. Both flags may be left out, and a bare id is the
shorthand for that, which covers most tests:

```js
(window.conversioAbtastyQueue = window.conversioAbtastyQueue || []).push('1577840');
```

It is written into an AB Tasty test's own script, and it does what that script
would otherwise do by hand: read the campaign off `ABTasty.getTestsOnPage()`,
derive the segment from the campaign and variation names, and push the
experience. What it saves is every test re-deriving the segment itself, which is
where the derivation and the naming drift apart.

### Why a queue (2.6.2)

Up to 2.6.1 the only entry point was a function on the window, and a test snippet
cannot call a function that does not exist yet. AB Tasty is built to run as early
as it can, usually synchronously in the head so a variation is painted rather than
flickering into place, while this tag arrives through a container that is
typically async. So the test winning that race is the ordinary case, not the
exception, and the only safe way to call a function that may be absent is to
guard it:

```js
// 2.6.1 and earlier: reports nothing at all when the test wins the race
if (typeof window.conversioAbtastyTracking === 'function') {
  window.conversioAbtastyTracking(testId);
}
```

That guard stops a crash and turns the race into silent data loss instead: no
error, no console output, one missing experience. The queue inverts it. The test
pushes to an array it creates if nobody has yet, the tag drains that array when
it initialises and then replaces it with something whose `push` reports
immediately. Pushed before the tag, an item waits; pushed after, it goes straight
through. It is the pattern `dataLayer` itself uses, and for the same reason.

A queued item's flags travel with the item rather than being read off the window
when it runs, and that is a correctness requirement rather than a preference. An
item may sit until init, so two tests queueing before the tag arrives are drained
in one pass: read off the window, both would get whichever value the window
happened to hold at drain time, and whatever the second test set would be
reported for the first.

### The direct call (2.6)

`window.conversioAbtastyTracking(testId)` is unchanged and still supported, so a
test already calling it keeps working. It executes immediately, so it reads both
flags off the window at call time, where the calling test sets them:

```js
window.conversio_sample = false;      // is this a sampled run?
window.conversio_experience = true;   // our stream, or false for the client's
window.conversioAbtastyTracking('1577840');
```

Note `window.` rather than a bare `var`. The tag reads `window.conversio_sample`
and `window.conversio_experience`, and if AB Tasty wraps the test code in a
function, which it commonly does, a `var` of that name is function-local and
never reaches the window. The flag is then silently ignored and the default
applies. The queue has no such trap, its flags being properties of the item.

The convention it reads is AB Tasty's own, and it belongs to whoever set the test
up rather than to this tag:

| Campaign name | Sampled | Variation name | Segment |
| --- | --- | --- | --- |
| `ABC \| Homepage hero` | `false` | `Variation 2 \| blue button` | `ABC.XV2` |
| `ABC \| Homepage hero` | `false` | `Original` | `ABC.XCO` |
| `ABC \| Homepage hero` | `false` | `Control` | `ABC.XCO` |
| `Sample \| ABC \| Homepage hero` | `true` | `Variation 2 \| blue button` | `ABC.XV2.S` |

The sample flag takes the string `'true'` as well as the boolean, since a value
arriving from a GTM variable is as likely to be one as the other, and anything
else reads as unsampled. The sampled form takes the code from the **second** name
segment, so a sampled campaign has to be named with three parts: named with two,
the test name becomes the code, which is the convention being wrong rather than
the tag guessing at it.

The experience flag chooses the stream:

| `experience` | Pushes | Payload key | `experience_category` |
| --- | --- | --- | --- |
| `true`, `'true'`, or absent | `conversio_experience` | `conversio` | `Conversio Experience` |
| `false` or `'false'` | `client_experience` | `client` | `Client Experience` |

Note the default runs the opposite way to the sample flag: each reads as its
own normal case, most tests not being sampled and most experiences being ours. So
a test that sets nothing still reports to the Conversio stream, and only an
explicit `false` diverts it, since an experience quietly landing in the client's
own reporting would sit there unnoticed until someone read the numbers.

Those three names are the whole of what the flag reaches, and they are written
out in the helper rather than derived from anything. The segment is worked out
before the flag is consulted, so the same test reports the same segment either
way, and everything downstream is that stream's own business: its storage, its
session event, its GA4 event name, and no `conversio_id` or vitals on a client
send. Reporting one test to both streams is therefore two experiences rather than
one, which is a thing to do deliberately and not by leaving the flag to chance.

The helper is only one of the ways an experience gets pushed, so it changes
nothing for the rest. The trigger names above are untouched by it: a container
pushing `conversioExperience` or `conversio_experience` reports exactly as it
did, and the stream flag has no bearing on either, being read only when a test
queues an item or calls the function.

The push is an ordinary experience for that stream from there on, so it is
de-duplicated by segment, held by the same consent gate, and sent to GA4
identically. Calling twice for one test is therefore harmless, and calling
before consent is fine: the experience is buffered and arrives when consent does.

The return value says whether an experience was reported. It comes back `false`,
rather than throwing into whatever ran the next line, when the campaign is not on
the page, when `getTestsOnPage()` fails, or when the campaign name carries no
code where the sample flag says to look, since an experience keyed on
`undefined` cannot be untangled downstream. Nothing is logged either way: this
tag writes nothing to a client's console.

The queue answers the same way, an unusable item being stepped over rather than
ending the drain: one test snippet pushing something malformed must not cost every
other test on the page its experience. The whole drain is guarded too, so whatever
a page has left in that array, the tag still initialises. The return value of a
queued push is deliberately not part of the contract, since before the tag loads
it is the array's new length and after it the boolean, and the two cannot be made
to agree without lying about one of them.

Two things follow from these being on the window. They are reachable by anything
on the page, so they validate what they are given and swallow their own failures;
and once a client's tests use them, the two names and their shapes are a contract,
unlike the internals around them. `window.__conversioEnableEmission__` and its two
siblings keep the `__conversio*__` spelling that marks a control a consent
platform calls; these are typed out by hand in a test, so they have the plain
names.

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
node test/runtime-tag-2.6.3.test.js
```

This runs the same set of checks against both shipped copies of the 2.6.3 tag,
the GTM dev file (`conversio_runtime_tag_v2.6.3.js`) and the self-hosted bundle
(`self-hosted/public/runtime-tag.2.6.3.js`), so the two can't silently diverge.
Since 2.4.1 the bundle is the comment-stripped build rather than a copy, which
means the suite is verifying the exact bytes clients receive. A passing run looks
like:

```
conversio_runtime_tag_v2.6.3.js: 498 passed, 0 failed
self-hosted/public/runtime-tag.2.6.3.js: 498 passed, 0 failed

TOTAL: 996 passed, 0 failed
```

There's a second suite for the self-hosted loader Worker, which runs it against
stubbed Cloudflare bindings and then feeds the bytes it serves through the same
browser harness, so the tracking ID substitution is verified by the tag
actually reading it back:

```bash
node test/loader.test.js
```

Both exit non-zero if anything fails, so they're safe to wire into CI. Earlier
versions keep their own suites (`test/runtime-tag-2.6.2.test.js`,
`test/runtime-tag-2.6.1.test.js`,
`test/runtime-tag-2.6.test.js`,
`test/runtime-tag-2.5.1.test.js`, `test/runtime-tag-2.5.test.js`,
`test/runtime-tag-2.4.2.test.js`, `test/runtime-tag-2.4.1.test.js`,
`test/runtime-tag-2.4.test.js`, `test/runtime-tag-2.3.test.js`), which still pass
and are worth keeping green while any client is pinned to those bundles.

### What it covers (2.6.3)

Everything in 2.6.2 below, plus section 29: the consent queue. Same arrangement
as the AB Tasty queue and the same argument for it, applied to the gate rather
than to a test, so the section is written as a contract as much as a behaviour.

Both orders first, since that is the whole point: a grant queued before the tag
opens the gate, one pushed after opens it on the push, and the same one-line
snippet lands identically either side. Then that nothing queued opens nothing,
which is the check that would fail if the drain were wired but inert. Then the
vocabulary, one command at a time, in every spelling and in mixed case, with the
boolean forms read the same way as the words.

Then the branch that is a privacy requirement rather than a convenience. Eight
plausible near-misses (`yes`, `accept`, `allow`, `on`, `1`, the string `true`,
and the empty string) and four non-string literals must reach the gate as
nothing at all, because the only useful default would be a grant. A queue reading
a typo as consent is the one failure here that a visitor could reasonably object
to, so it is pinned rather than assumed.

Then order, which is what a platform that changes its mind depends on: grant then
withdraw lands shut, withdraw then grant lands open, and a withdrawal on its own
writes the shut state rather than leaving it unset. Then that one malformed item
is stepped over and the good command behind it still applies, three of them in a
row still do not end the drain, and five hostile queue values (a string, a
number, an object with a non-function push, a null-prototype object, and a getter
that throws) each leave the tag initialised with the controls exposed.

Then the drain's position, which is the one thing here that is not local to the
queue: it runs after the settings and before any dataLayer processing, so an
experience already on the dataLayer emits under a queued grant rather than going
into the buffer and straight back out, and the tracking ID is on the window
before any of it runs, a flush being able to send to GA4. Then that `flush` moves
the gate in neither direction. Last, that both entry points stay and agree: the
three controls are still exposed, calling one directly still works, and the
function and the queue produce the same state on both stream keys.

Section 12's globals allow-list gained `conversioConsentQueue`, the tag now
installing a live pusher at init. That the allow-list caught it is the point of
having one.

### What it covers (2.6.2)

Everything in 2.6.1 below, plus the AB Tasty queue, described in full
[above](#why-a-queue-262). All 404 of the inherited checks pass unchanged except
one, deliberately: section 12's globals allow-list gained `conversioAbtastyQueue`,
the tag now installing a live pusher at init. That the allow-list caught it is
the point of having one.

Section 28 adds 35. Both orders first, since surviving either is the whole reason
the queue exists: an item queued before the tag loads is reported, an item pushed
after it has loaded is reported, and one snippet reports identically whichever
side of the tag it runs. Then the item shapes, a bare string id and a numeric one
being shorthand for both defaults, and a numeric `testId` on an object accepted
the same way.

Then the flags, in both spellings and by default, against the stream and the
sampled marker each should produce. Then the check the design exists for: two
items queued with different streams and drained together each keep their own,
and a window flag set to the opposite does not divert a queued item. Read off the
window at drain time both would have reported whatever the second test set, so
this is what pins the flags to the item rather than to the moment the drain ran.

Then that queued items report in the order they were pushed, that one test queued
twice de-duplicates to one experience, and that the consent gate holds a queued
item and releases it on consent exactly as it does a directly reported one.

Then what a bad queue must not do. Null, undefined, an empty object, an empty
`testId` and a numeric one are each stepped over without costing the good item
behind them, and an id matching no campaign reports nothing. The queue set to a
string, a number, an object with a non-function `push`, and a getter that throws
each still leave the tag initialised and still firing `conversio_data`, since the
queue is a structure client code built and init has to survive whatever is in it.

Last, that the direct entry point is untouched: `conversioAbtastyTracking` still
reports, still returns `true`, still reads its stream flag off the window, and
still returns `false` for an id with no campaign.

23 of the 35 fail against 2.6.1. The other 12 pin behaviour the direct call
already had, or pass trivially there because 2.6.1 ignores the queue entirely.
The suite reports a missing queue as failed checks rather than a stack trace, so
running it against a build without one lists what is absent.

The harness needed nothing. `tagSource` already allowed a script to be prepended
to the tag, which is how the losing race is reproduced: the snippet runs, then
the tag loads underneath it.

### What it covers (2.6.1)

Everything in 2.6 below, plus the legacy camelCase payload fields, described in
full [above](#trigger-events). Sections 1 to 26 are the other half of that
check: they describe the snake_case names throughout and must be untouched by
it, which is what makes the normalisation a no-op for every container already
pushing the current spelling. All 358 of them pass unchanged.

Section 27 adds 46. The mapping is table-driven, one field at a time: the
payload is canonical except for the single field under test, which is pushed
under its legacy name alone carrying a value nothing else on the payload
carries, so a value arriving under the canonical name downstream can only have
come from the legacy key it was written to. Then the same thing whole, asserted
against the snake_case push it stands in for rather than against a literal: a
wholly camelCase experience emits what the snake_case one emits, sends GA4 the
same parameters, and stores the same map and list, with the per-run
`conversio_id` and vitals stripped before the comparison since neither is
derived from the payload.

Then precedence, which a payload carrying both spellings of one field needs a
defined answer for: the canonical name wins where it carries a value, and the
legacy name is read where the canonical one is empty and where it is absent
entirely. Then that de-duplication sees through the spelling, the segment being
normalised before the map is consulted, so one occurrence pushed under each name
costs one emit and one list entry.

Then that storage holds the canonical names, asserted on the stored string
rather than only on the emit: a tag that normalised on the way out instead would
pass every check above and fail these. A legacy event held by the consent gate
is buffered under `event_segment` with no camelCase name anywhere in the buffer,
and emits with the mapped names once consent arrives; same for an experience
held in the map and flushed from it.

Then the drops, which matter because the segment decides whether an experience
is reported at all: learning a second name for it must not turn a payload that
was dropped into one reported under a segment nobody can read. No segment under
either spelling, an empty legacy segment, a legacy segment that is not a string,
and both spellings present but empty are each pinned to emit nothing.

Last, that the list is exactly eight names and not a camelCase-to-snake_case
rule applied to whatever a payload happens to carry: a payload carrying
`experienceValue`, `experience_Action` and `experienceactionn` reaches none of
the four fields, and the emit is the same four keys it always was. And that the
client stream reads them too, both streams being one code path taking a stream
descriptor, so that stays true rather than being quietly special-cased later.

23 of the 46 fail against 2.6. The other 23 pin behaviour that must not have
changed.

The harness needed nothing for this.

### What it covers (2.6)

Everything in 2.5.1 below, plus `conversioAbtastyTracking`, described in full
[above](#the-ab-tasty-helper-26-queued-from-262). It is the first entry point in this tag that a
client's own JavaScript calls by name, so sections 25 and 26 cover the contract
as much as the derivation.

The derivation is table-driven: every variation form against the segment it
should produce, both sampled spellings of the flag against the marked result, and
seven values that must read as unsampled. Then the drops, which are what stops
bad data reaching the experience map: an id with no campaign on the page, a
`getTestsOnPage()` that throws, a campaign missing either name or holding a
non-string one, and a name carrying no code where the flag says to look. Each
returns `false` and pushes nothing.

Section 26 is the stream flag. Every absent-or-not-false spelling reports to the
Conversio stream, both `false` spellings to the client's, each under its own
event name, payload key and category. Strip the category and the two payloads are
identical, which is what pins the flag to those three names rather than to the
derivation. Then that each push is processed by its own stream and marked by its
own processed flag, stored in its own map with the other's untouched, that a
client send still carries no `conversio_id` and no vitals, that one test reported
to both streams is two experiences and not one de-duplicated, and that a dropped
call with the client stream selected pushes to neither, the guards running before
the flag is consulted.

Last, that the helper existing changes nothing for a container: a
`conversioExperience` pushed the old way still reports to the Conversio stream
with the flag set to `false`, since the flag is read only when the helper is
called. The stream descriptors are byte-identical to 2.5.1's, which is what makes
that true by construction rather than by test.

The contract is the rest. That the function is on the window at all, section 12's
globals allow-list having gained it deliberately rather than by accident. That
`ABTasty` and `conversio_sample` are read at call time, so a page with no
`ABTasty` on it still loads the tag and still fires `conversio_data`, and a
call there returns `false` rather than throwing. That what it pushes is an
ordinary `conversio_experience`: processed by the push hook into a session
emit, stored in the Conversio map and not the client one, de-duplicated to one
emit across two calls, and held by the consent gate until consent arrives.

The harness needed nothing for this. Both globals are read at call time, so a
test sets them on the `window` the harness already returns and calls the
function through it, the same way an AB Tasty test would.

### What it covers (2.5.1)

Everything in 2.5 below, plus when collection closes and how a load nobody
watched is reported.

The load this was written for is a real one. A page opened into a background tab
is not painted until the visitor looks at it, so the browser produced its first
contentful paint at 1864ms, nearly a second *after* the load event at 920ms,
where 2.5 closed collection on the first idle period after load and reported
`lcp` and `fcp` as null on a page that had not drawn a pixel. `ps` was correct
throughout, which is the tell: the block was there, so something had measured.

Collection now waits while nothing has painted, re-trying ten times at 500ms
inside the existing 6s hard timeout, and the suite pins both halves of that: on
the background load, `conversio_data` has not fired a second in, and when it does
fire it carries `fcp: 1864` rather than a null. A page that had already painted
when the tag looked is not held up at all, and a page that never paints, a
background tab the visitor never opens, still reports on the hard timeout with
the nulls that are genuinely all there is, because a deferred close must never
become a lost one.

Then the `vis` marker, which is why a null paint timing can now be read. No
browser reports an LCP for a load that started hidden, so that null means
"could not be measured" where elsewhere it means "failed to measure", and the
timings that do arrive are anchored to the moment the visitor looked rather than
to navigation, which would skew any average they were included in. `vis:0` marks
such a load and nothing else does: a load that started visible carries no key at
all, nor does one the visitor hid later, the marker following the visibility at
navigation rather than at whenever the tag happened to look. The `visibility-state`
entries are consulted first as the authoritative record, with
`document.visibilityState` as the fallback where a browser keeps none, and both
paths are covered. `vis` is a marker rather than a measurement, so it cannot make
an empty collection worth reporting: a hidden load that measured nothing still
sends no vitals block.

Last, the fallback for a measurement the observers never delivered now asks for
each entry type directly rather than walking the whole timeline, since
`getEntries()` carries the paint entries but not the largest-contentful-paint
ones, so the old scan for the latter could never have found it. Which types a
browser exposes to a synchronous read differs between browsers, so what the suite
pins is that a dead observer still yields whatever the timeline holds.

The harness gained a virtual clock for this: a timer carries the time it is due
rather than a delay, an entry held back by `entryDelays` is absent from the
timeline until its moment arrives, and `drain({ until: ms })` stops at a point in
virtual time. Without it, every timer fired in one pass whatever its delay, so a
callback that waits and asks again could not be told apart from one that gives up
immediately. All five earlier suites pass against it unchanged.

### What it covers (2.5)

Everything in 2.4.2 below, which is the point of most of it: both streams are now
driven by one set of functions taking a stream descriptor rather than by a single
hard-coded path, so all 188 checks of the 2.4.2 suite are inherited unchanged and
double as the regression check on that refactoring. They all describe the
Conversio stream, and 2.5 must not have moved it. Two of them go further and
compare a page with client pushes against one without: our side of
`sessionStorage` and our `conversio_cro` sends must come out identical, bar the
random id.

Then the client stream itself. That it mirrors ours: a `client_experience` emits
one `client_experience_session` carrying its payload under a `client` key, a
`client_event` emits one `client_event_instance`, and each sends one `client_cro`
whose parameter object is compared in full, so a key appearing there that
shouldn't fails rather than passing unnoticed. That it inherits our
de-duplication, an experience reported once per segment and an event once per
push, because it is the same code. That a segment-less push is ignored, that the
init sweep of the dataLayer picks up client triggers as well as the push hook
does, and that the payload key is part of the match, so neither stream can be
triggered with the other's payload object. That camelCase client names are not
triggers, there being no legacy container to support.

That the two share nothing: a list holds only its own stream's segments, the
client keys are exactly the five expected, no key belongs to both namespaces, one
segment name reported to both streams is two separate reports, and a fired set on
one side does not silence the other.

That the client stream has no identity: no `conversio_id` and no `client_id` on a
client send, no parameter ending in `_id` at all, no vitals parameter even with a
snapshot sitting in storage to carry, no `client_data` event, `localStorage`
holding the one `conversio_id` and nothing else, and a client send still going out
when `localStorage` is missing entirely, since the stream never touches it.

And that consent is one control for two gates: nothing client-shaped emitted or
sent before consent, the event buffered against its own key meanwhile, one enable
call writing both keys and flushing both streams, a second flush emitting nothing
further, one disable call closing both. Last, the version boundary: a visitor who
consented on a 2.4.2 page earlier in the same session has our key set and no
client key, so their client events wait for consent to be signalled again rather
than being dropped, and arrive in full when it is, without re-emitting the
experience our stream already reported.

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

2.4.2 also accepts `conversio_experience` and `conversio_event` alongside the
camelCase names (above). Since everything downstream of the match is shared code,
most of the section compares two runs differing only in the name pushed: the
emits must match field for field and the `sessionStorage` they leave behind must
be identical. Then the cases a mixed container creates: a segment already
reported under one name is not reported again under the other and the two feed
one segment list, while an event stays one instance per push under either name;
the sweep of items already on the dataLayer at init picks up a snake_case trigger
as well as the push hook does; a pre-consent snake_case event is buffered and
arrives on flush; and the GA4 send is the same `conversio_cro` either way, its
parameters differing only in the random `conversio_id`. Last, that the widening
did not turn a near-miss into a trigger: the payload object is still required,
the match is still case sensitive, and a name merely close to these is still
ignored.

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
`test/runtime-tag-2.6.2.test.js`: point `TAG_PATHS` at the new file(s) and reuse
`test/harness.js` as-is, since the harness itself is version-agnostic. Bump
`BUNDLE_VERSION` in `test/loader.test.js` too, so the loader suite exercises
the current bundle.
