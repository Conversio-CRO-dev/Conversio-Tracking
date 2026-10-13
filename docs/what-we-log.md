# What Conversio logs

A reference for answering client questions about what data the Conversio tag
sends to us, and what we record when it does. Everything below is taken from
the running code (`self-hosted/src/index.js`) rather than written from memory,
and the example log lines are real output from that Worker rather than
illustrations.

## The short answer

The tag sends us nothing. It makes no network requests to Conversio at all.
Everything it produces is handed to the client's own `dataLayer` and their own
Google Analytics property, which we never see.

The only thing that reaches us is the browser's request for the script file
itself, exactly as with any externally hosted script. We record nothing about
that request unless it fails, and when it does fail we record a reason code and
which client it concerned, never anything about the person browsing.

## What the tag sends to Conversio

Nothing. The runtime tag contains no `fetch`, no `XMLHttpRequest`, no
`navigator.sendBeacon` and no image beacon. Measurements, experiment data and
Core Web Vitals are pushed to `window.dataLayer` and sent to the **client's
own** GA4 property through the **client's own** `gtag` instance. That traffic
goes from the visitor's browser to Google, under the client's own tag
configuration and consent framework. It does not pass through Conversio.

## What else we log

The tag has the ability to send faluire logs to Cloudflare for stability monitoring on our end. 
A request that succeeds produces no log line from our code at
all. Every one of the log statements in the Worker sits on an error path, and
they exist so that a client's tracking breaking is something we find out about
rather than something they discover later from missing data.

Beyond these failure logs nothing else is logged in Cloudflare.

## Every field we can record

This is the complete list of details that are captured in our logs. Not client performance data or user behaviour data are captured as part of these logs: 

| Field | What it is | Example |
| --- | --- | --- |
| `event` | Always the same marker, so our lines can be filtered from platform noise | `conversio_loader` |
| `reason` | Which failure this was, from the fixed list below | `asset_missing` |
| `key` | The **first 12 characters** of the client's key, so a problem can be traced to a client | `cvo_7Hq2mNx9` |
| `client` | The client's own company name, as we hold it in their configuration | `Acme Co` |
| `version` | Which version of the tag bundle was involved | `2.6.4` |
| `hostname` | The **hostname only** of the site the request came from | `staging.someothersite.com` |
| `method` | The HTTP method, when it was one we do not serve | `POST` |

Note what is absent: no IP address, no visitor identifier, no cookie, no user
agent, no location, no page URL, no referring path.

Two of these are deliberately truncated:

- **`key`** is cut to 12 characters. The full key is the credential that
  authorises serving the tag, so a log holding it in full would be a log that
  could be used to impersonate a client. Twelve characters identify which
  client a problem belongs to without being usable as the credential.
- **`hostname`** discards the path. A request referred from
  `https://staging.someothersite.com/checkout` is logged as
  `staging.someothersite.com`. The hostname is the part that answers "which
  site", and the path is the part that could describe a person's session.

## The complete list of reason codes

Every line below is real output from the Worker.

### Access and configuration

```
{"event":"conversio_loader","reason":"unknown_key","key":"cvo_7Hq2mNx9"}
{"event":"conversio_loader","reason":"record_malformed","key":"cvo_7Hq2mNx9"}
{"event":"conversio_loader","reason":"revoked_key","key":"cvo_7Hq2mNx9","client":"Acme Co"}
{"event":"conversio_loader","reason":"domain_mismatch","key":"cvo_7Hq2mNx9","client":"Acme Co","hostname":"staging.someothersite.com"}
{"event":"conversio_loader","reason":"method_not_allowed","method":"POST"}
```

| Code | What happened |
| --- | --- |
| `unknown_key` | A request carrying a key that is not in our records |
| `record_malformed` | A configuration record that is not readable as a client record |
| `revoked_key` | A key we have withdrawn, still being requested by a site |
| `domain_mismatch` | A domain-locked key requested from a site not on its allow-list |
| `method_not_allowed` | Something other than a GET or HEAD against a tag URL |

### Serving the tag

```
{"event":"conversio_loader","reason":"version_invalid","key":"cvo_7Hq2mNx9","client":"Acme Co","version":"latest"}
{"event":"conversio_loader","reason":"asset_missing","key":"cvo_7Hq2mNx9","version":"9.9"}
{"event":"conversio_loader","reason":"asset_error","key":"cvo_7Hq2mNx9","version":"2.6.4"}
{"event":"conversio_loader","reason":"asset_unreadable","key":"cvo_7Hq2mNx9","version":"2.6.4"}
{"event":"conversio_loader","reason":"tracking_id_rejected","key":"cvo_7Hq2mNx9"}
{"event":"conversio_loader","reason":"deployed_at_rejected","key":"cvo_7Hq2mNx9"}
```

| Code | What happened |
| --- | --- |
| `version_invalid` | A record naming a version that is not version-shaped |
| `asset_missing` | A client pinned to a bundle version nobody deployed |
| `asset_error` | The bundle store threw while being read |
| `asset_unreadable` | The bundle was found but could not be read to the end |
| `tracking_id_rejected` | A client's GA property ID failed our safety check and was dropped rather than injected |
| `deployed_at_rejected` | A client's deployment date was not a valid ISO date and was dropped |

### Capacity and dependencies

```
{"event":"conversio_loader","reason":"rate_limited","key":"cvo_7Hq2mNx9"}
{"event":"conversio_loader","reason":"rate_limiter_error","key":"cvo_7Hq2mNx9"}
{"event":"conversio_loader","reason":"key_lookup_error","key":"cvo_7Hq2mNx9"}
{"event":"conversio_loader","reason":"serve_error","key":"cvo_7Hq2mNx9"}
```

| Code | What happened |
| --- | --- |
| `rate_limited` | One key exceeded its per-location request cap |
| `rate_limiter_error` | The rate limiter was unavailable. We fail open, so the tag keeps working |
| `key_lookup_error` | Our configuration store was unreachable, or held invalid data |
| `serve_error` | A last-resort catch-all, so an unexpected fault cannot reach a client's page as an error |

### Audiences (v3, not currently enabled for any client)

```
{"event":"conversio_loader","reason":"audiences_not_enabled","key":"cvo_7Hq2mNx9","client":"Acme Co"}
{"event":"conversio_loader","reason":"audiences_unbound","key":"cvo_7Hq2mNx9"}
{"event":"conversio_loader","reason":"audience_lookup_error","key":"cvo_7Hq2mNx9"}
{"event":"conversio_loader","reason":"audience_id_invalid","key":"cvo_7Hq2mNx9"}
{"event":"conversio_loader","reason":"audience_endpoint_rejected","key":"cvo_7Hq2mNx9"}
{"event":"conversio_loader","reason":"audience_serve_error","key":"cvo_7Hq2mNx9"}
```

| Code | What happened |
| --- | --- |
| `audiences_not_enabled` | An audience lookup for a client without the feature on |
| `audiences_unbound` | An audience lookup before the audience store exists |
| `audience_lookup_error` | The audience store was unreachable |
| `audience_id_invalid` | A lookup whose visitor identifier was the wrong shape |
| `audience_endpoint_rejected` | The endpoint built for the tag failed its own safety check |
| `audience_serve_error` | A last-resort catch-all on the audience path |

Note that `audience_id_invalid` logs the **client key fingerprint**, not the
visitor identifier that was rejected.

## Where this is stored, and for how long

These lines are written to Cloudflare Workers Logs, retained for **7 days** and
then deleted. We hold no other copy and export them nowhere.

Separately, our configuration store holds one record per client: their name,
which tag version they are on, their GA property ID, their allowed domains and
the date they were moved to their current version. It holds no visitor data.

