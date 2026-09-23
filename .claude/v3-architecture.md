# Conversio v3: audience-driven personalisation

What the optimal implementation looks like, and the architecture to get there.
Written from the end state backwards. Supersedes `v3-audience-infrastructure.md`,
which worked forwards from the existing tag and reached the wrong shape by doing
so.

Scope confirmed with Andy, September 2026:

- The Conversio tag stays a **GTM-delivered** tag. No request-path integration,
  no head snippet of our own.
- The target surface is **above the fold, first view**.
- Audiences come from **historical behaviour**, derived in GA4 / BigQuery.
- **Existing portfolio first**, Finisterre and Brakes UK.
- Every client is assumed to run **AB Tasty or equivalent**. Where that platform
  sits in the head, which is its vendor-recommended install and the common case,
  above-the-fold personalisation renders without a flash. Where a client deploys
  it through GTM instead, they get the same flash they already get from every
  campaign that platform runs for them today. That is a property of their install
  rather than of anything here, and nothing on our side changes either way.

---

## 1. The shape of it

```
  NIGHTLY, in GCP                  ONCE PER VISITOR PER DAY, in the browser
  ───────────────                  ────────────────────────────────────────

  GA4 export (BigQuery)
        │ scheduled SQL
        ▼
  audience_membership              Conversio tag, via GTM, late and unhurried
  conversio_id → codes                   │ reads conversio_id (localStorage)
        │ Cloud Run, deltas only         │ if the cookie is missing or stale:
        ▼                                │   GET /a/<clientKey>/<conversio_id>
  Cloudflare KV  ────────────────────────▶   writes the _cvo_aud cookie
  aud:<clientKey>:<id>                   │
                                         │
                            ══════ NEXT PAGE VIEW ══════
                                         │
                                         ▼
                              AB Tasty head snippet reads _cvo_aud at time
                              zero, targets on it, renders behind its own
                              anti-flicker. No lookup, no race, no flicker.
                                         │
                                         ▼
                              The test pushes conversioAbtastyQueue, the tag
                              reports the experience to GA4, and it lands back
                              in the BigQuery export for tomorrow's audiences.
```

The loop closes. What Conversio adds is the left-hand side and the cookie;
everything on the right already exists and already works.

---

## 2. Why this shape, and not the obvious one

Three facts decide the whole architecture. Each of them removes work.

### 2.1 GTM cannot render above the fold, and no amount of speed changes that

The GTM container snippet is `async` by design. It cannot block paint, and
nothing it delivers can run before the browser has begun painting. Changing
above-the-fold content without a visible flip requires hiding the region
synchronously, and the snippet that does the hiding has to be inline in the head
*ahead of* GTM: by the time GTM executes there is already something to hide.

This is not a property of our tag. It is why Optimizely, Adobe Target and AB
Tasty all require a head snippet and none of them ship as a GTM tag.

So the question is not how to make a GTM-delivered lookup fast enough. There is
no fast enough. The question is what already renders on the page and when, and
the answer is the client's experimentation platform.

**This is not a gate on which clients can be served.** A client running AB Tasty
from GTM rather than the head still gets everything below, and still personalises
above the fold. What they get with it is the flash, and they get that today on
every campaign that platform runs, for the same reason and to the same degree.
Nothing here makes it worse and nothing here can fix it, because the fix is where
their platform is installed, which is their decision and their vendor's
recommendation to make.

That indifference is worth stating as a property rather than a caveat. The last
mile is a cookie sitting on the visitor's machine before the page loads. Who
reads it, how early, and what they do with it is the client's own arrangement, so
an install we would not have chosen degrades their outcome without changing our
design, our delivery or our failure modes.

### 2.2 Historical audiences are not real-time data, so they need no real-time lookup

A nightly BigQuery job produces audiences that are up to 24 hours old the moment
they are written. Fetching one during the page load buys nothing that fetching it
yesterday would not have bought.

What is actually required is that the answer is **resident on the client before
the page that uses it**. A first-party cookie does that at zero latency, readable
synchronously at time zero by anything in the head.

So the lookup moves off the critical path entirely. The tag does it whenever it
happens to run, which under GTM is late, and late is fine because nothing on that
page depends on it. The next page view has the audience for free.

### 2.3 The chicken-and-egg resolves itself

A first-time visitor has no cookie. They also have no behavioural history, so
they are in no behavioural audience. The population that can be personalised is
exactly the returning population, which is exactly the population that already
has the cookie.

"First view" for anyone who can actually be targeted means the first view of a
returning session, and that works.

### 2.4 What follows from those three

The system we were heading towards is mostly unnecessary:

| Not needed | Because |
| --- | --- |
| Edge or server-side decisioning | AB Tasty already decides, in the head, before paint |
| A request-path integration | nothing of ours needs to be in it |
| A blocking or latency-bounded lookup | the answer is already on the client |
| Our own anti-flicker | AB Tasty's is better and already deployed |
| A rendering engine, variant DSL, QA and preview tooling | all of it exists in AB Tasty |
| An identity change | the cookie carries the *answer*, not the identifier, so `conversio_id` stays in localStorage exactly as it is |

The last row corrects something I said earlier. Moving identity to a cookie is
not required here. It would be required to decide at the edge, and we are not
deciding at the edge.

---

## 3. What the tag does, and what it deliberately does not

The tag stays what it is: a measurement system delivered through a container,
ES5, dependency-free, failing silent. v3 adds one job to it.

**It does:** resolve the `conversio_id` it already resolves, and, when the
audience cookie is absent or stale, fetch the audience once and write the cookie.

**It does not:** render anything, block anything, delay `conversio_data`, or
carry a latency budget. A lookup that fails costs a stale cookie and nothing
else, and a stale cookie still targets.

**Rate.** The lookup is gated on cookie freshness, so it happens roughly once per
visitor per day rather than once per page view. At the 12M-users/month scale in
`wrangler.toml` that is order 400k requests a day rather than 40M, which is the
difference between a rounding error and a line item.

---

## 4. The cookie, which is the contract

This is the interface between Conversio and a platform we do not control, so it
is specified rather than left to emerge.

```
_cvo_aud = v1.1758585600.,lapsed,outerwear,high-aov,
           │  │           │
           │  │           └─ audience codes, comma-delimited, comma-wrapped
           │  └───────────── when the audience was COMPUTED, epoch seconds
           └──────────────── schema version
```

`Path=/; Max-Age=2592000; SameSite=Lax; Secure`, host-only unless the client
needs it across subdomains, and **not** `HttpOnly`, since AB Tasty reads it in
JavaScript.

Five things about that format are deliberate:

- **Delimited, not JSON.** AB Tasty targets a cookie by contains, equals or
  regex, and a JSON value would have to be URL-encoded before any of that works.
  The tag already made the same choice for its GA4 list parameters, for the same
  reason.
- **Leading and trailing commas**, so a target matches `,outerwear,` and cannot
  be satisfied by a longer code that merely contains it. Without them
  `,outerwear` also matches `winter-outerwear` and the audience quietly widens.
- **The timestamp is when the audience was computed, not when the cookie was
  written.** Those diverge exactly when the pipeline has stopped, which is the
  case worth being able to see. A write time would read as fresh forever while
  serving three-week-old audiences.
- **A schema version**, so a format change is detected rather than mis-parsed. An
  unrecognised version is treated as absent and refetched.
- **An empty audience is written, not omitted**: `v1.1758585600.,`. It says "we
  asked, the answer was nothing", which stops a re-lookup on every page view of
  a visitor who is in no audience. That is most first-time visitors, so it is
  most of the saving.

**Size.** Cookies ride every request to the domain, so the budget is about 200
bytes, or roughly 15 short codes. Codes are short slugs allocated centrally, not
human-readable audience names.

**Refresh** when the cookie is absent, its schema version is unknown, or
`now - computed_at` exceeds a threshold set a little above the derivation cadence.
Twelve hours against a nightly job gives one refresh per visitor per day with room
for the job to run late.

**Consent.** The cookie describes a person and derives from a persistent
identifier, so it sits behind the same gate as `conversio_id` and is written only
after consent. A withdrawal must clear it, which is a new requirement: the
existing `disableEmission` shuts the gate but has nothing to delete.

---

## 5. The four planes

Three of these are unchanged from the earlier assessment. Only the last mile is
different, and it is much smaller.

### 5.1 Derivation, in BigQuery

A scheduled query materialises `audience_membership`: one row per `conversio_id`,
an array of audience codes, a `computed_at`. Append-only with a view over the
latest, so a bad audience definition is recoverable rather than overwritten.
Audience definitions live in version control as SQL. They are the product.

### 5.2 Distribution, Cloud Run on a schedule

Reads the delta since the last run and bulk-writes to Cloudflare KV, 10,000 keys
per request. **Deltas only.** KV writes bill around $5 per million, so a million
IDs rewritten nightly is roughly $150 a month per client for data that mostly did
not change.

A failed run leaves yesterday's audiences in place and alerts. Stale is a much
smaller problem than absent, because absent is indistinguishable from "not in an
audience" at every layer downstream.

The job's Cloudflare token is scoped to the audience namespace and must not reach
`CLIENT_KEYS`.

### 5.3 Serving, a route on the existing Worker

`GET /a/<clientKey>/<conversio_id>` on `tag.conversio.dev`, inheriting the
per-client key model, the domain allow-list, the rate limiter and the logging
discipline. A separate `AUDIENCES` KV namespace, keys `aud:<clientKey>:<id>`, so
one client's key cannot read another's audiences.

Simple GET, no custom headers, so no CORS preflight. `Cache-Control: private`,
never edge-cached: this is per-visitor data and a shared cache has no purge story
for it.

The latency budget is now "within the page view" rather than a number in
milliseconds, which removes the only genuinely hard engineering constraint the
old design had.

### 5.4 Last mile, the cookie

Section 4. That is the whole of it.

---

## 6. What still blocks it

### 6.1 `conversio_id` barely reaches BigQuery, and this is still the gate

Unchanged and still first. `sendToGa` attaches `conversio_id` only from
`emitExperience` and the event emitter, and `conversio_data` never reaches GA4 at
all. So a visitor's ID lands in the export **only if they already triggered a
Conversio experience or a mapped event**.

Audiences derived from that cover only the people already experimented on, which
is circular and small. Fix by setting `conversio_id` as a **user-scoped custom
dimension** once per session, so it joins every subsequent hit. Not retroactive:
the dataset can only be built from the day it ships, which is the argument for
shipping it before anything else here is designed in detail.

### 6.2 Safari's storage cap applies to both halves

ITP caps script-written storage at seven days, and both the `conversio_id` in
localStorage and the `_cvo_aud` cookie are script-written. A Safari visitor
returning after more than a week is a new visitor with no audience. This is no
worse than today's identity behaviour, but it sets a ceiling on addressable
traffic that is worth measuring rather than assuming.

### 6.3 In-session intent is out of reach, and that is the real boundary

A cookie written on a previous page view cannot express "added to basket ninety
seconds ago". If the value turns out to be in in-session intent rather than
historical behaviour, this architecture does not serve it and we are back to the
request path and a different commercial conversation. Worth deciding deliberately
rather than discovering when the first campaign brief asks for it.

### 6.4 Who reads the cookie pre-consent

The cookie is written post-consent and persists. AB Tasty reading it on a later
visit is the client's own processing under their own consent framework, not ours,
but the two frameworks need to agree. A question for whoever owns the privacy
posture, not an engineering one.

---

## 7. Failure modes, and what each looks like

| Failure | Effect | Why it is acceptable |
| --- | --- | --- |
| Lookup route down | cookie not refreshed, stays stale | still targets, just on yesterday's audience |
| Distribution job fails | audiences age | `computed_at` makes it visible, and stale beats absent |
| Cookie cleared by the visitor | out of all audiences until the next lookup | one page view of default content |
| Schema change | unrecognised version treated as absent | refetched on the next page view |
| Pipeline silently stops | **the one that needs alerting** | cookies look valid and age invisibly, so alert on `computed_at` drift rather than on job success |

The last row is the only failure here that is quiet, and it is quiet in the
direction that matters, so it gets the alert.

---

## 8. What to build, in order

### Step 0, and it needs no engineering at all

**Prove the audiences separate behaviour, in BigQuery, before building anything
to deliver them.** Define three or four candidate audiences as SQL over a real
client's existing export and test whether they differ on conversion rate, AOV or
revenue per session by enough to be worth acting on.

If lapsed outerwear browsers convert the same as everyone else, no amount of
infrastructure makes that a product. This is a day of SQL against data that
already exists, it needs no deployment, no tag change and no client involvement,
and it is the only step that can tell you the idea is wrong cheaply.

### Step 1: make identity reach BigQuery

§6.1. Ship `conversio_id` as a user-scoped dimension and let it accrue. Nothing
downstream can be built on real data until it has.

Note this is partly circular with step 0, which can only use the IDs already
present. Run step 0 on the population that exists today, accepting it is
experiment-exposed and biased, and treat it as directional.

### Step 2: the pipeline, end to end, on synthetic scale

Derivation, distribution and serving (§5.1 to §5.3) with a synthetic dataset at
realistic cardinality: a million IDs, not a hundred. This proves the delta write
economics and the KV read path, which are the two things that behave differently
at scale, and it needs no site and no traffic.

### Step 3: the cookie, on conversio.com

Functional only. conversio.com is a low-traffic marketing site and will not tell
you anything about performance, but it will tell you the tag writes a
well-formed cookie, the refresh logic fires when it should, and a withdrawal
clears it.

### Step 4: one AB Tasty campaign targeting the cookie

Also on conversio.com, also functional. This is the step that proves the contract
in §4 survives contact with the platform: that AB Tasty can target the cookie the
way we think, that the comma-wrapping works as a match, and that the existing
`conversioAbtastyQueue` reporting still closes the loop.

### Step 5: one real client, one audience, one campaign

Finisterre or Brakes UK, the smallest interesting audience, one campaign, measured
properly. This is the first step that produces a number anyone should believe,
and everything before it exists to make this step cheap rather than to prove
anything on its own.

---

## 9. Open questions

1. **Does AB Tasty's plan on these accounts support cookie targeting**, and does
   it evaluate before its own anti-flicker releases the page? The architecture
   rests on both. Worth confirming with one test campaign before §4 is treated as
   settled.
2. **Who allocates audience codes**, and where does that registry live? It is a
   contract between a BigQuery job and a campaign configured by a human in
   another tool, which is exactly the kind of coupling that drifts.
3. **In-session intent**: in or out? §6.3.
4. **Refresh threshold**: twelve hours is a guess sized off a nightly job. It
   should be set once the derivation cadence is fixed.
5. **Erasure.** A DSAR has to reach BigQuery, the KV namespace and, through the
   next page view, the cookie. Cheaper designed in now than retrofitted across
   three stores later.
