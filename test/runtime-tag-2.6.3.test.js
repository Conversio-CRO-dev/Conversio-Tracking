// Behavioural checks for the 2.6.3 runtime tag: conversio_id minting and
// persistence, the emission-consent gate, CWV success/failure fallback, and
// the single-event-per-page-load guarantee - plus everything 2.4.1 introduced
// and 2.4.2 keeps, in sections 15, 16 and 18: conversio_vitals goes to GA on the
// experience send only, the conversio_id timestamp no longer ends in a fixed
// '00', and the GA4 string parameters are delimited rather than JSON.
//
// Section 17 covers the one thing 2.4.2 changes: INP, added to the vitals object
// by 2.4.1, is not collected. It measures the page's own main-thread work rather
// than anything an experience changes, so it never moved with our work; and the
// few seconds this tag collects for left it null on most pages anyway. The
// section is written as a rollback check rather than deleted with the code: the
// interaction fixtures stay in the harness and must reach nothing.
//
// Runs the same suite against both shipped copies of the tag (the GTM dev
// file and the self-hosted bundle) so the two can never silently diverge.
//
// Sections 20 to 23 cover what 2.5 adds: a second stream of the same machinery
// under client_ names, driven by the client's own dataLayer events, sharing no
// storage with ours and carrying neither the conversio_id nor the vitals. Since
// both streams are now driven by one set of functions taking a stream
// descriptor, sections 1 to 19 double as the regression check on that
// refactoring: every one of them describes the Conversio stream, and 2.5 must
// not have moved it.
//
// Section 24 covers what 2.5.1 changes, which is when collection closes and how
// a load nobody looked at is reported. A page loaded into a background tab does
// not paint until the visitor opens the tab, which can be after its load event,
// and 2.5 closed collection on the first idle period after load and reported
// lcp and fcp as null on a page that had not drawn a pixel. Collection now waits
// while nothing has painted, and a load that started hidden is marked vis:0,
// since no browser reports an LCP for one and its paint timings are anchored to
// the moment the visitor looked rather than to navigation.
//
// Section 25 covers the one thing 2.6 adds: conversioAbtastyTracking, a public
// function on the window that an AB Tasty test calls to report itself as a
// Conversio experience. It is the first entry point in this tag that a client's
// own JavaScript calls by name, so the section covers the contract as much as
// the derivation: that it is exposed, that it reads the sample flag off the
// window where the calling test sets it, that a name outside the convention is
// dropped rather than reported as 'undefined', and that what it pushes is
// processed by the same machinery as any other conversio_experience.
//
// Section 26 covers the other half of it: the conversio_experience flag, which
// chooses whether the helper reports to our stream or to the client's. It
// reaches the event name and the payload key and nothing else, so the section
// pins the envelope against the derivation, that the absent flag still reports
// to ours, and that the two streams stay as separate downstream of the helper
// as they are for any other experience.
//
// Section 27 covers the one thing 2.6.1 adds: the four payload fields now
// answer to a camelCase name as well as the snake_case one, so a legacy
// campaign pushing experienceAction reports what a current one pushing
// experience_action does. Sections 1 to 26 are the other half of that check.
// They describe the snake_case names throughout and must be untouched by it,
// which is what makes the normalisation a no-op for every container already
// pushing the current spelling.
//
// Section 28 covers the one thing 2.6.2 adds: the AB Tasty queue. A test
// snippet cannot call a function that does not exist yet, and AB Tasty runs
// early by design while this tag arrives through a container that is typically
// async, so a snippet guarding the call with a typeof check reports nothing at
// all on the loads where it loses that race. A test now pushes to an array
// instead, which the tag drains at init and then replaces with a live pusher,
// so neither order can lose. The section pins both orders, and that a queued
// item's flags travel with the item rather than being read off the window when
// the drain finally runs.
//
// Section 29 covers the one thing 2.6.3 adds: the consent queue. It is the same
// arrangement as section 28's, for the same reason, applied to the gate rather
// than to an AB Tasty test. The controls are assigned when this script executes
// and the loader delivers it through a container, so a consent platform that
// resolves stored consent early loses that race as the ordinary case, and a lost
// grant is not an error anywhere: it is a session that emits nothing while the
// loader serves a clean 200. The section covers both orders, the command
// vocabulary in the spellings a GTM variable is as likely to produce, the
// ordering a platform that changes its mind depends on, and the one branch that
// is a privacy requirement rather than a convenience: an unrecognised command is
// stepped over rather than falling back to the only useful default, a grant.
//
// Usage: node test/runtime-tag-2.6.3.test.js
'use strict';

var fs = require('fs');
var path = require('path');
var runTag = require('./harness').runTag;
var VITALS_FIXTURE = require('./harness').VITALS_FIXTURE;

var TAG_PATHS = [
  { label: 'conversio_runtime_tag_v2.6.3.js', path: path.join(__dirname, '..', 'conversio_runtime_tag_v2.6.3.js') },
  { label: 'self-hosted/public/runtime-tag.2.6.3.js', path: path.join(__dirname, '..', 'self-hosted', 'public', 'runtime-tag.2.6.3.js') }
];

var ID_RE = /^con_[a-z2-7]{16}\.[0-9]+$/;

// The slot the self-hosted loader substitutes the client's tracking ID into.
var TRACKING_SLOT = '@@CONVERSIO_TRACKING_ID@@';

function dataEvents(dl) {
  return dl.filter(function (e) { return e && e.event === 'conversio_data'; });
}

function isObject(value) {
  return !!value && typeof value === 'object';
}

// Reads the delimited form the conversio_vitals parameter now takes,
// 'lcp:1234.5,fcp:456.7,...', back into an object to assert on.
function parseVitalsParam(value) {
  var out = {};
  if (typeof value !== 'string' || !value) return out;
  value.split(',').forEach(function (pair) {
    var bits = pair.split(':');
    out[bits[0]] = Number(bits[1]);
  });
  return out;
}

function runSuite(tagPath, label) {
  var pass = 0;
  var fail = 0;

  function check(name, cond, detail) {
    if (cond) { pass++; }
    else {
      fail++;
      console.log('  FAIL  [' + label + '] ' + name + (detail ? '  -> ' + detail : ''));
    }
  }

  function tag(opts) {
    opts = opts || {};
    opts.tagPath = tagPath;
    return runTag(opts);
  }

  var source = fs.readFileSync(tagPath, 'utf8');

  // Stands in for what the self-hosted loader serves, which patches the
  // client's tracking ID into the bundle (see self-hosted/src/index.js).
  function tagWithTrackingId(value, opts) {
    opts = opts || {};
    opts.tagPath = tagPath;
    opts.tagSource = source.split(TRACKING_SLOT).join(value);
    return runTag(opts);
  }

  // A visitor who consented earlier in this session has both stream gates
  // open, the one control having written both keys. Seeding only the conversio
  // key, as emissionEnabled does on its own, is a state the tag never produces
  // itself: it is the mid-upgrade session, exercised deliberately in section 23.
  function consented(opts) {
    opts = opts || {};
    opts.emissionEnabled = true;
    opts.sessionInitial = Object.assign(
      { clientEmissionEnabled: 'true' },
      opts.sessionInitial || {}
    );
    return opts;
  }

  // 1. conversio_id format and placement
  (function () {
    var r = tag({ cwv: 'ok', emissionEnabled: true });
    var evs = dataEvents(r.dataLayer);
    check('exactly one conversio_data event', evs.length === 1, 'got ' + evs.length);
    var c = evs[0] && evs[0].conversio;
    check('conversio_id present', !!(c && c.conversio_id), JSON.stringify(c));
    check('matches con_<16>.<micros>', ID_RE.test(c.conversio_id), c.conversio_id);
    var micros = Number(c.conversio_id.split('.')[1]);
    check('timestamp is microsecond-scale Unix', micros > 1.7e15 && micros < 2.0e15, String(micros));
    check('timestamp is a safe integer', Number.isSafeInteger(micros), String(micros));
    check('persisted to localStorage', r.local.conversio_id === c.conversio_id, JSON.stringify(r.local));
    check('vitals attached on success', !!c.conversio_vitals, JSON.stringify(c));
    check('lcp captured', c.conversio_vitals.lcp === 1234.5, JSON.stringify(c.conversio_vitals));
    check('fcp captured', c.conversio_vitals.fcp === 456.7, JSON.stringify(c.conversio_vitals));
    check('cls excludes hadRecentInput', c.conversio_vitals.cls === 0.07, String(c.conversio_vitals.cls));
    check('ps captured', c.conversio_vitals.ps === 2000, String(c.conversio_vitals.ps));
    check('the object is exactly lcp, fcp, cls and ps',
      Object.keys(c.conversio_vitals).join(',') === 'lcp,fcp,cls,ps',
      JSON.stringify(c.conversio_vitals));
  })();

  // 2. conversio_id NOT added to experience/event pushes
  (function () {
    var r = tag({ cwv: 'ok', emissionEnabled: true });
    r.window.dataLayer.push({
      event: 'conversioExperience',
      conversio: { experience_segment: 's1', experience_category: 'c', experience_action: 'a', experience_label: 'l' }
    });
    r.window.dataLayer.push({
      event: 'conversioEvent',
      conversio: { event_segment: 'e1', event_category: 'c', event_action: 'a', event_label: 'l' }
    });
    var exp = r.dataLayer.filter(function (e) { return e.event === 'conversio_experience_session'; })[0];
    var evt = r.dataLayer.filter(function (e) { return e.event === 'conversio_event_instance'; })[0];
    check('experience emitted', !!exp);
    check('experience has no conversio_id', exp && !('conversio_id' in exp.conversio), JSON.stringify(exp && exp.conversio));
    check('event emitted', !!evt);
    check('event has no conversio_id', evt && !('conversio_id' in evt.conversio), JSON.stringify(evt && evt.conversio));
  })();

  // 3. conversio_data always fires when CWV fails
  [['unsupported', 'PerformanceObserver absent'],
   ['observer-throws', 'observe() throws'],
   ['empty', 'no entries at all']].forEach(function (pair) {
    var r = tag({ cwv: pair[0], emissionEnabled: true });
    var evs = dataEvents(r.dataLayer);
    var c = evs[0] && evs[0].conversio;
    check(pair[1] + ': event still fires', evs.length === 1, 'got ' + evs.length);
    check(pair[1] + ': has conversio_id', !!(c && ID_RE.test(c.conversio_id)), JSON.stringify(c));
    check(pair[1] + ': NO conversio_vitals key', !!c && !('conversio_vitals' in c), JSON.stringify(c));
    check(pair[1] + ': id is the only key', !!c && Object.keys(c).length === 1, JSON.stringify(Object.keys(c || {})));
  });

  // 4. id is stable across page loads (localStorage reuse)
  (function () {
    var first = tag({ cwv: 'ok', emissionEnabled: true });
    var id1 = dataEvents(first.dataLayer)[0].conversio.conversio_id;
    var second = tag({ cwv: 'ok', emissionEnabled: true, localInitial: { conversio_id: id1 } });
    var id2 = dataEvents(second.dataLayer)[0].conversio.conversio_id;
    check('same id reused on return visit', id1 === id2, id1 + ' vs ' + id2);
    var third = tag({ cwv: 'unsupported', emissionEnabled: true, localInitial: { conversio_id: id1 } });
    check('reused even when CWV fails', dataEvents(third.dataLayer)[0].conversio.conversio_id === id1);
    var fresh = tag({ cwv: 'ok', emissionEnabled: true });
    check('different browser gets different id',
      dataEvents(fresh.dataLayer)[0].conversio.conversio_id !== id1);
  })();

  // 5. malformed stored id is replaced, not propagated
  ['', 'garbage', 'con_SHORT.123', 'con_abcdefghijklmnop', 'con_abcdefghijklmnop.', '<script>x</script>']
    .forEach(function (bad) {
      var r = tag({ cwv: 'ok', emissionEnabled: true, localInitial: { conversio_id: bad } });
      var id = dataEvents(r.dataLayer)[0].conversio.conversio_id;
      check('rejected ' + JSON.stringify(bad), ID_RE.test(id) && id !== bad, id);
      check('  and rewrote storage', r.local.conversio_id === id);
    });

  // 6. emission gate is respected, and conversio_id sits behind it
  (function () {
    var r = tag({ cwv: 'ok', emissionEnabled: false });
    check('nothing pushed while gate closed', dataEvents(r.dataLayer).length === 0,
      JSON.stringify(r.dataLayer));
    var pending = JSON.parse(r.session.conversioVitalsPending || '{}');
    check('payload buffered', pending.conversio_pending === true, JSON.stringify(pending));
    check('buffered payload carries vitals', !!pending.conversio_vitals, JSON.stringify(pending));
    check('NO id in the buffered payload', !('conversio_id' in pending), JSON.stringify(pending));
    check('NOTHING written to localStorage pre-consent',
      Object.keys(r.local).length === 0, JSON.stringify(r.local));

    r.window.__conversioEnableEmission__();
    r.drain();
    var evs = dataEvents(r.dataLayer);
    check('flushed on enable', evs.length === 1, 'got ' + evs.length);
    check('id minted at flush time', ID_RE.test(evs[0].conversio.conversio_id),
      evs[0].conversio.conversio_id);
    check('id persisted only after consent', r.local.conversio_id === evs[0].conversio.conversio_id,
      JSON.stringify(r.local));
    check('flushed payload keeps its vitals', !!evs[0].conversio.conversio_vitals,
      JSON.stringify(evs[0].conversio));
    check('buffer cleared', !JSON.parse(r.session.conversioVitalsPending || '{}').conversio_pending);

    r.window.__conversioEnableEmission__();
    r.drain();
    check('no duplicate on second enable', dataEvents(r.dataLayer).length === 1,
      'got ' + dataEvents(r.dataLayer).length);
  })();

  // 7. gate closed + CWV failed still yields one id-only event on consent
  (function () {
    var r = tag({ cwv: 'unsupported', emissionEnabled: false });
    var pending = JSON.parse(r.session.conversioVitalsPending || '{}');
    check('marker-only payload buffered',
      pending.conversio_pending === true && !('conversio_vitals' in pending),
      JSON.stringify(pending));
    check('no id buffered', !('conversio_id' in pending), JSON.stringify(pending));
    check('nothing in localStorage pre-consent', Object.keys(r.local).length === 0,
      JSON.stringify(r.local));
    r.window.__conversioEnableEmission__();
    r.drain();
    var evs = dataEvents(r.dataLayer);
    check('flushes to one id-only event', evs.length === 1 && Object.keys(evs[0].conversio).length === 1,
      JSON.stringify(evs[0] && evs[0].conversio));
    check('and that event has a valid id', ID_RE.test(evs[0].conversio.conversio_id),
      evs[0].conversio.conversio_id);
  })();

  // 7b. a visitor who never consents leaves no identifier
  (function () {
    var r = tag({ cwv: 'ok', emissionEnabled: false });
    check('localStorage untouched', Object.keys(r.local).length === 0, JSON.stringify(r.local));
    check('no conversio_data pushed', dataEvents(r.dataLayer).length === 0);
    var i;
    for (i = 0; i < 5; i++) {
      var again = tag({ cwv: 'ok', emissionEnabled: false });
      if (Object.keys(again.local).length !== 0) break;
    }
    check('still nothing after 5 pre-consent page loads', i === 5, 'broke at ' + i);
  })();

  // 8. 2.2-shaped pending payload is discarded, never mis-attributed
  (function () {
    var legacy = JSON.stringify({ lcp: 111.1, fcp: 22.2, cls: 0.01, ps: 900 });
    var r = tag({
      cwv: 'unsupported',
      emissionEnabled: true,
      sessionInitial: { conversioVitalsPending: legacy }
    });
    r.window.__conversioFlushEmission__();
    r.drain();
    var evs = dataEvents(r.dataLayer);
    check('exactly one event, this page load only', evs.length === 1, 'got ' + evs.length);
    var leaked = evs.filter(function (e) {
      return e.conversio.conversio_vitals && e.conversio.conversio_vitals.ps === 900;
    });
    check('previous page load vitals not emitted', leaked.length === 0,
      JSON.stringify(evs.map(function (e) { return e.conversio; })));
    check('stale slot cleared', !JSON.parse(r.session.conversioVitalsPending || '{}').ps,
      r.session.conversioVitalsPending);
    check('no 2.2 keys spread into the payload', !('ps' in evs[0].conversio),
      JSON.stringify(evs[0].conversio));
  })();

  // 9. localStorage unavailable or blocked
  (function () {
    var r = tag({ cwv: 'ok', emissionEnabled: true, localStorage: false });
    var c = dataEvents(r.dataLayer)[0].conversio;
    check('absent localStorage: event still fires with id', ID_RE.test(c.conversio_id), c.conversio_id);

    var w = tag({ cwv: 'ok', emissionEnabled: true, localStorageOpts: { throwOnWrite: true } });
    var cw = dataEvents(w.dataLayer)[0].conversio;
    check('write-blocked: event still fires with id', ID_RE.test(cw.conversio_id), cw.conversio_id);

    var rd = tag({ cwv: 'ok', emissionEnabled: true, localStorageOpts: { throwOnRead: true } });
    var crd = dataEvents(rd.dataLayer)[0].conversio;
    check('read-blocked: event still fires with id', ID_RE.test(crd.conversio_id), crd.conversio_id);
  })();

  // 9b. cross-page-load carryover: can two events land on one page load?
  (function () {
    var benign = tag({
      cwv: 'ok',
      emissionEnabled: false,
      sessionInitial: { conversioVitalsPending: JSON.stringify({ conversio_pending: true,
        conversio_vitals: { lcp: 1, fcp: 2, cls: 0, ps: 3 } }) }
    });
    benign.window.__conversioEnableEmission__();
    benign.drain();
    check('consent after collection -> exactly one event',
      dataEvents(benign.dataLayer).length === 1, 'got ' + dataEvents(benign.dataLayer).length);

    var mid = tag({
      cwv: 'ok',
      emissionEnabled: false,
      autoDrain: false,
      sessionInitial: { conversioVitalsPending: JSON.stringify({ conversio_pending: true,
        conversio_vitals: { lcp: 999, fcp: 888, cls: 0.5, ps: 777 } }) }
    });
    mid.window.__conversioEnableEmission__();
    mid.drain();
    var evs = dataEvents(mid.dataLayer);
    check('consent mid-collection -> exactly one event', evs.length === 1, 'got ' + evs.length);
    check('and it is THIS page load, not the stale one',
      evs.length === 1 && evs[0].conversio.conversio_vitals.ps === 2000,
      JSON.stringify(evs[0] && evs[0].conversio.conversio_vitals));
    check('stale payload discarded from storage',
      !JSON.parse(mid.session.conversioVitalsPending || '{}').conversio_pending,
      mid.session.conversioVitalsPending);

    var openGate = tag({
      cwv: 'ok',
      emissionEnabled: true,
      sessionInitial: { conversioVitalsPending: JSON.stringify({ conversio_pending: true,
        conversio_vitals: { lcp: 1, fcp: 2, cls: 0, ps: 555 } }) }
    });
    openGate.window.__conversioFlushEmission__();
    openGate.drain();
    var oe = dataEvents(openGate.dataLayer);
    check('explicit flush does not resurrect a stale payload', oe.length === 1, 'got ' + oe.length);
    check('and reports this page load', oe.length === 1 && oe[0].conversio.conversio_vitals.ps === 2000,
      JSON.stringify(oe[0] && oe[0].conversio.conversio_vitals));
  })();

  // 10. single event per page load under repeated timer drains
  (function () {
    var r = tag({ cwv: 'ok', emissionEnabled: true, readyState: 'loading' });
    r.drain(); r.drain(); r.drain();
    check('still exactly one conversio_data', dataEvents(r.dataLayer).length === 1,
      'got ' + dataEvents(r.dataLayer).length);
  })();

  // 11. id uniqueness across many fresh browsers
  (function () {
    var seen = {};
    var dupes = 0;
    var i;
    for (i = 0; i < 300; i++) {
      var id = dataEvents(tag({ cwv: 'unsupported', emissionEnabled: true }).dataLayer)[0].conversio.conversio_id;
      if (seen[id]) dupes++;
      seen[id] = true;
    }
    check('300 fresh browsers, no collisions', dupes === 0, dupes + ' duplicates');
  })();

  // 12. no globals leaked beyond the documented gate controls
  (function () {
    var r = tag({ cwv: 'ok', emissionEnabled: true });
    var added = Object.keys(r.window).filter(function (k) {
      return k.indexOf('conversio') !== -1 || k.indexOf('CONVERSIO') !== -1;
    }).sort();
    check('only expected globals', JSON.stringify(added) === JSON.stringify([
      '__CONVERSIO_RUNTIME_INIT__', '__conversioDisableEmission__',
      '__conversioEnableEmission__', '__conversioFlushEmission__',
      'conversioAbtastyQueue', 'conversioAbtastyTracking', 'conversioConsentQueue',
      'conversioSettings'
    ]), JSON.stringify(added));
    // The client stream adds no controls of its own: one consent call covers
    // both, so there is nothing client-named on window to find.
    var clientGlobals = Object.keys(r.window).filter(function (k) {
      return k.toLowerCase().indexOf('client') !== -1;
    });
    check('and nothing client-named on window',
      clientGlobals.length === 0, JSON.stringify(clientGlobals));
  })();

  // 13. client settings: the tracking ID slot the loader substitutes
  (function () {
    // The shipped files are un-substituted, so they stand in for the GTM
    // paste-in copy and for a client whose KV record carries no trackingId.
    var r = tag({ cwv: 'ok', emissionEnabled: true });
    check('conversioSettings is exposed', isObject(r.window.conversioSettings),
      JSON.stringify(r.window.conversioSettings));
    check('un-substituted slot reads as not configured',
      r.window.conversioSettings.trackingId === null,
      JSON.stringify(r.window.conversioSettings.trackingId));

    // The whole point of the slot: it must not leak the placeholder text into
    // anything a later tag reads.
    check('placeholder text never surfaces',
      JSON.stringify(r.window.conversioSettings).indexOf('CONVERSIO_TRACKING_ID') === -1,
      JSON.stringify(r.window.conversioSettings));

    // Client config, not visitor data, so it must not wait on consent.
    var noConsent = tag({ cwv: 'ok' });
    check('settings exposed without emission consent',
      isObject(noConsent.window.conversioSettings), 'missing');
    check('and nothing was stored to earn it', noConsent.local === null || !noConsent.local.conversio_id,
      JSON.stringify(noConsent.local));

    // Substituted, as the loader serves it.
    var injected = tagWithTrackingId('G-J4EDMZMNY9', { cwv: 'ok', emissionEnabled: true });
    check('substituted slot is exposed',
      injected.window.conversioSettings.trackingId === 'G-J4EDMZMNY9',
      JSON.stringify(injected.window.conversioSettings.trackingId));

    // What the loader substitutes for a client with no trackingId set.
    var empty = tagWithTrackingId('', { cwv: 'ok', emissionEnabled: true });
    check('empty substitution reads as not configured',
      empty.window.conversioSettings.trackingId === null,
      JSON.stringify(empty.window.conversioSettings.trackingId));

    var blank = tagWithTrackingId('   ', { cwv: 'ok', emissionEnabled: true });
    check('whitespace substitution reads as not configured',
      blank.window.conversioSettings.trackingId === null,
      JSON.stringify(blank.window.conversioSettings.trackingId));

    // A later tag may have got there first; its keys must survive.
    var preset = runTag({
      tagPath: tagPath,
      tagSource: source.split(TRACKING_SLOT).join('G-J4EDMZMNY9'),
      cwv: 'ok',
      emissionEnabled: true,
      presetSettings: { ownKey: 'keep me' }
    });
    check('pre-existing conversioSettings keys are kept',
      preset.window.conversioSettings.ownKey === 'keep me' &&
      preset.window.conversioSettings.trackingId === 'G-J4EDMZMNY9',
      JSON.stringify(preset.window.conversioSettings));

    // Deliberately off the payload: conversio_data fires late and behind
    // consent, so nothing should start depending on finding it there.
    var payload = dataEvents(injected.dataLayer)[0].conversio;
    check('tracking ID stays off the conversio_data payload',
      JSON.stringify(payload).indexOf('G-J4EDMZMNY9') === -1, JSON.stringify(payload));

    // The loader replaces every occurrence and the tag detects a raw slot by
    // looking for '@@', so a second occurrence would break both. Keep it to one.
    var slotCount = source.split(TRACKING_SLOT).length - 1;
    check('slot appears exactly once in the shipped file', slotCount === 1, 'found ' + slotCount);

    // Cross-file drift: the loader substitutes a literal it defines itself.
    var loaderSrc = fs.readFileSync(
      path.join(__dirname, '..', 'self-hosted', 'src', 'index.js'), 'utf8');
    check('loader substitutes the same literal the tag declares',
      loaderSrc.indexOf("'" + TRACKING_SLOT + "'") !== -1, 'loader slot constant differs');
  })();

  // 14. GA4 delivery of conversio_cro alongside the dataLayer emits
  (function () {
    var GA_ID = 'G-J4EDMZMNY9';

    function gaRun(opts) {
      opts = opts || {};
      if (!opts.gtag) opts.gtag = 'spy';
      return tagWithTrackingId(GA_ID, opts);
    }

    function pushExperience(r, seg) {
      r.window.dataLayer.push({
        event: 'conversioExperience',
        conversio: {
          experience_segment: seg,
          experience_category: 'exp-cat',
          experience_action: 'exp-act',
          experience_label: 'exp-lab'
        }
      });
    }

    function pushEvent(r, seg) {
      r.window.dataLayer.push({
        event: 'conversioEvent',
        conversio: {
          event_segment: seg,
          event_category: 'evt-cat',
          event_action: 'evt-act',
          event_label: 'evt-lab'
        }
      });
    }

    function croCalls(calls) {
      return calls.filter(function (c) { return c.name === 'conversio_cro'; });
    }

    // An experience emit sends one conversio_cro, pinned to this client's
    // property so a site running several GA4 instances gets it in the right one.
    var r = gaRun({ cwv: 'ok', emissionEnabled: true });
    pushExperience(r, 's1');
    var calls = croCalls(r.gtagCalls);
    check('experience sends one conversio_cro', calls.length === 1, 'got ' + calls.length);
    check('sent as an event command', calls.length === 1 && calls[0].command === 'event',
      calls.length ? calls[0].command : 'none');
    check('pinned to the key-level property with send_to',
      calls.length === 1 && calls[0].params.send_to === GA_ID,
      calls.length ? String(calls[0].params.send_to) : 'none');

    var p = calls[0].params;
    check('experience category mapped', p.conversio_category === 'exp-cat', String(p.conversio_category));
    check('experience action mapped', p.conversio_action === 'exp-act', String(p.conversio_action));
    check('experience label mapped', p.conversio_label === 'exp-lab', String(p.conversio_label));
    check('experience segment mapped', p.conversio_segment === 's1', String(p.conversio_segment));
    check('conversio_id attached', ID_RE.test(p.conversio_id || ''), String(p.conversio_id));

    // The two lists must not be crossed: each carries what its name says.
    check('conversio_experiences holds experience segments',
      p.conversio_experiences === 's1', String(p.conversio_experiences));
    check('conversio_events holds event segments',
      p.conversio_events === '', String(p.conversio_events));

    var withEvent = gaRun({ cwv: 'ok', emissionEnabled: true });
    pushEvent(withEvent, 'e1');
    var ep = croCalls(withEvent.gtagCalls)[0].params;
    check('event sends conversio_cro', !!ep, 'none');
    check('event category mapped', ep.conversio_category === 'evt-cat', String(ep.conversio_category));
    check('event action mapped', ep.conversio_action === 'evt-act', String(ep.conversio_action));
    check('event label mapped', ep.conversio_label === 'evt-lab', String(ep.conversio_label));
    check('event segment mapped', ep.conversio_segment === 'e1', String(ep.conversio_segment));
    check('event conversio_events holds event segments',
      ep.conversio_events === 'e1', String(ep.conversio_events));
    check('event conversio_experiences stays empty',
      ep.conversio_experiences === '', String(ep.conversio_experiences));
    check('event carries conversio_id too', ID_RE.test(ep.conversio_id || ''), String(ep.conversio_id));

    // No tracking ID configured: GA delivery is simply off. The shipped files
    // are un-substituted, so plain tag() covers that case.
    var noId = tag({ cwv: 'ok', emissionEnabled: true, gtag: 'spy' });
    pushExperience(noId, 's1');
    pushEvent(noId, 'e1');
    check('no tracking ID sends nothing to GA', croCalls(noId.gtagCalls).length === 0,
      'got ' + croCalls(noId.gtagCalls).length);
    check('but the dataLayer emits still happen',
      noId.dataLayer.filter(function (e) { return e.event === 'conversio_experience_session'; }).length === 1,
      'experience emit missing');

    // Pre-consent nothing is emitted at all, so nothing reaches GA either.
    var preConsent = gaRun({ cwv: 'ok' });
    pushExperience(preConsent, 's1');
    pushEvent(preConsent, 'e1');
    check('no consent sends nothing to GA', croCalls(preConsent.gtagCalls).length === 0,
      'got ' + croCalls(preConsent.gtagCalls).length);

    // Whether vitals ride along depends purely on ordering: an experience that
    // fires before Core Web Vitals collection finishes has none to send, one
    // firing after it does. Both are normal.
    var early = gaRun({ cwv: 'ok', emissionEnabled: true, autoDrain: false });
    pushExperience(early, 's-early');
    var earlyParams = croCalls(early.gtagCalls)[0].params;
    check('an experience before CWV finishes sends no vitals',
      !('conversio_vitals' in earlyParams), String(earlyParams.conversio_vitals));

    early.drain();
    pushExperience(early, 's-late');
    var lateParams = croCalls(early.gtagCalls)[1].params;
    check('an experience after CWV finishes carries them',
      typeof lateParams.conversio_vitals === 'string' &&
      parseVitalsParam(lateParams.conversio_vitals).ps === 2000, String(lateParams.conversio_vitals));

    var seeded = gaRun({
      cwv: 'ok',
      emissionEnabled: true,
      sessionInitial: { conversio_vitals: '{"lcp":1234.5,"fcp":456.7,"cls":0.07,"ps":2000}' }
    });
    pushExperience(seeded, 's1');
    var sp = croCalls(seeded.gtagCalls)[0].params;
    check('collected vitals sent as a delimited string',
      typeof sp.conversio_vitals === 'string' &&
      parseVitalsParam(sp.conversio_vitals).lcp === 1234.5, String(sp.conversio_vitals));

    // With no window.gtag the command queues on dataLayer, which is what
    // gtag.js drains when it loads.
    var queued = tagWithTrackingId(GA_ID, { cwv: 'ok', emissionEnabled: true });
    pushExperience(queued, 's1');
    var q = croCalls(queued.queuedGtagCalls());
    check('queues onto dataLayer when gtag is absent', q.length === 1, 'got ' + q.length);
    check('queued command is a well-formed gtag tuple',
      q.length === 1 && q[0].command === 'event' && q[0].params.send_to === GA_ID,
      JSON.stringify(q[0] || null));

    // A broken gtag must not cost the dataLayer emit.
    var hostile = tagWithTrackingId(GA_ID, { cwv: 'ok', emissionEnabled: true, gtag: 'throws' });
    pushExperience(hostile, 's1');
    check('a throwing gtag leaves the dataLayer emit intact',
      hostile.dataLayer.filter(function (e) { return e.event === 'conversio_experience_session'; }).length === 1,
      'experience emit missing');
    check('and conversio_data still fires', dataEvents(hostile.dataLayer).length === 1,
      'got ' + dataEvents(hostile.dataLayer).length);

    // GA delivery inherits the dataLayer emit's de-duplication.
    var dupe = gaRun({ cwv: 'ok', emissionEnabled: true });
    pushExperience(dupe, 's1');
    pushExperience(dupe, 's1');
    check('a repeated experience sends once', croCalls(dupe.gtagCalls).length === 1,
      'got ' + croCalls(dupe.gtagCalls).length);

    // And it follows the buffer/flush path, so events captured pre-consent
    // reach GA when consent arrives rather than being lost.
    var buffered = gaRun({ cwv: 'ok' });
    pushEvent(buffered, 'e1');
    check('buffered event sends nothing yet', croCalls(buffered.gtagCalls).length === 0,
      'got ' + croCalls(buffered.gtagCalls).length);
    buffered.window.__conversioEnableEmission__();
    buffered.window.__conversioFlushEmission__();
    var flushed = croCalls(buffered.gtagCalls);
    check('flush delivers it to GA', flushed.length === 1, 'got ' + flushed.length);
    check('flushed send is still pinned to the right property',
      flushed.length === 1 && flushed[0].params.send_to === GA_ID,
      flushed.length ? String(flushed[0].params.send_to) : 'none');

    // The tag must never configure the client's property itself.
    var allCommands = gaRun({ cwv: 'ok', emissionEnabled: true });
    pushExperience(allCommands, 's1');
    check('never issues a gtag config or js command',
      allCommands.gtagCalls.filter(function (c) {
        return c.command === 'config' || c.command === 'js';
      }).length === 0,
      JSON.stringify(allCommands.gtagCalls.map(function (c) { return c.command; })));
  })();

  // 15. conversio_vitals goes to GA on the experience send only (2.4.1)
  (function () {
    var GA_ID = 'G-J4EDMZMNY9';
    // The snapshot in sessionStorage is still JSON: only what goes to GA4
    // changed shape.
    var VITALS_STORED = '{"lcp":1234.5,"fcp":456.7,"cls":0.07,"ps":2000}';
    var VITALS_PARAM = 'lcp:1234.5,fcp:456.7,cls:0.07,ps:2000';

    function croCalls(calls) {
      return calls.filter(function (c) { return c.name === 'conversio_cro'; });
    }

    function pushExperience(r, seg) {
      r.window.dataLayer.push({
        event: 'conversioExperience',
        conversio: {
          experience_segment: seg,
          experience_category: 'exp-cat',
          experience_action: 'exp-act',
          experience_label: 'exp-lab'
        }
      });
    }

    function pushEvent(r, seg) {
      r.window.dataLayer.push({
        event: 'conversioEvent',
        conversio: {
          event_segment: seg,
          event_category: 'evt-cat',
          event_action: 'evt-act',
          event_label: 'evt-lab'
        }
      });
    }

    // Vitals are seeded rather than collected, so both sends happen with a
    // vitals snapshot already in storage and the only thing separating them is
    // which emit they belong to.
    var r = tagWithTrackingId(GA_ID, {
      cwv: 'ok',
      emissionEnabled: true,
      gtag: 'spy',
      sessionInitial: { conversio_vitals: VITALS_STORED }
    });
    pushExperience(r, 's1');
    pushEvent(r, 'e1');

    var calls = croCalls(r.gtagCalls);
    check('both emits still reach GA', calls.length === 2, 'got ' + calls.length);

    var expParams = calls[0].params;
    var evtParams = calls[1].params;
    check('experience send carries conversio_vitals',
      expParams.conversio_vitals === VITALS_PARAM, String(expParams.conversio_vitals));
    check('event send has NO conversio_vitals key',
      !('conversio_vitals' in evtParams), JSON.stringify(evtParams));

    // Only the vitals were dropped: everything else an event send carried in
    // 2.4 is untouched.
    check('event send keeps its other parameters',
      evtParams.send_to === GA_ID &&
      evtParams.conversio_category === 'evt-cat' &&
      evtParams.conversio_action === 'evt-act' &&
      evtParams.conversio_label === 'evt-lab' &&
      evtParams.conversio_segment === 'e1' &&
      evtParams.conversio_events === 'e1' &&
      ID_RE.test(evtParams.conversio_id || ''), JSON.stringify(evtParams));

    // The dataLayer side of both emits never carried vitals and still doesn't,
    // while conversio_data keeps its own copy.
    var dlEvent = r.dataLayer.filter(function (e) { return e.event === 'conversio_event_instance'; })[0];
    check('the event dataLayer emit is unchanged',
      !!dlEvent && !('conversio_vitals' in dlEvent.conversio), JSON.stringify(dlEvent));
    check('conversio_data still carries its vitals',
      !!dataEvents(r.dataLayer)[0].conversio.conversio_vitals,
      JSON.stringify(dataEvents(r.dataLayer)[0].conversio));

    // A run with several events: the page's vitals are reported once, not once
    // per interaction, which is the whole point of the change.
    var many = tagWithTrackingId(GA_ID, {
      cwv: 'ok',
      emissionEnabled: true,
      gtag: 'spy',
      sessionInitial: { conversio_vitals: VITALS_STORED }
    });
    pushExperience(many, 's1');
    pushEvent(many, 'e1');
    pushEvent(many, 'e2');
    pushEvent(many, 'e3');
    var withVitals = croCalls(many.gtagCalls).filter(function (c) {
      return 'conversio_vitals' in c.params;
    });
    check('one experience and three events send vitals exactly once',
      croCalls(many.gtagCalls).length === 4 && withVitals.length === 1,
      croCalls(many.gtagCalls).length + ' sends, ' + withVitals.length + ' with vitals');

    // Same on the buffered path, where the flush necessarily happens after
    // collection has finished so vitals are certainly available to both sends.
    var buffered = tagWithTrackingId(GA_ID, { cwv: 'ok', gtag: 'spy' });
    pushEvent(buffered, 'e1');
    pushExperience(buffered, 's1');
    buffered.window.__conversioEnableEmission__();
    buffered.drain();
    var flushed = croCalls(buffered.gtagCalls);
    var flushedExp = flushed.filter(function (c) { return c.params.conversio_segment === 's1'; })[0];
    var flushedEvt = flushed.filter(function (c) { return c.params.conversio_segment === 'e1'; })[0];
    check('flush delivers both sends', flushed.length === 2, 'got ' + flushed.length);
    check('flushed experience carries vitals',
      !!flushedExp && typeof flushedExp.params.conversio_vitals === 'string',
      JSON.stringify(flushedExp && flushedExp.params));
    check('flushed event does not',
      !!flushedEvt && !('conversio_vitals' in flushedEvt.params),
      JSON.stringify(flushedEvt && flushedEvt.params));
  })();

  // 16. conversio_id timestamp: no fixed '00' tail (2.4.1)
  (function () {
    // A whole-millisecond timeOrigin plus a whole-millisecond now() is what the
    // browser clamp effectively produces: microseconds computed straight from it
    // land on a 100us boundary, which is where the constant '00' came from.
    var CLAMPED_ORIGIN = 1785492847000;
    var CLAMPED_NOW = 1500;
    var CLAMPED_BASE = 1785492848500000;

    function clampedOpts() {
      return {
        cwv: 'ok',
        emissionEnabled: true,
        perfTimeOrigin: CLAMPED_ORIGIN,
        perfNow: CLAMPED_NOW
      };
    }

    function micros(opts) {
      var id = dataEvents(tag(opts).dataLayer)[0].conversio.conversio_id;
      return Number(id.split('.')[1]);
    }

    var one = micros(clampedOpts());
    check('clamped clock: id timestamp is still a safe integer',
      Number.isSafeInteger(one), String(one));
    check('clamped clock: still microsecond-scale Unix',
      one > 1.7e15 && one < 2.0e15, String(one));
    // The filled digits are the ones the clock could not resolve, so the value
    // stays inside the 100us window the reading itself points at.
    check('clamped clock: stays within the clock grain of the real reading',
      one >= CLAMPED_BASE && one < CLAMPED_BASE + 100, String(one));

    var tails = {};
    var zeroTail = 0;
    var i;
    var m;
    for (i = 0; i < 200; i++) {
      m = micros(clampedOpts());
      tails[m % 100] = true;
      if (m % 100 === 0) zeroTail++;
    }
    // 2.4 produced exactly one possible tail here, 0, for all 200 ids.
    check('clamped clock: the tail varies between ids',
      Object.keys(tails).length > 30,
      Object.keys(tails).length + ' distinct tails in 200 ids');
    // It is random now rather than structural, so roughly 1 id in 100 still
    // ends in '00' by chance. What must not survive is it being the only ending.
    check('clamped clock: 00 is incidental, not the rule',
      zeroTail < 15, zeroTail + '/200 ended in 00');

    // A browser resolving finer than the usual clamp keeps its real reading
    // rather than having those digits discarded and re-randomised.
    var fine = micros({
      cwv: 'ok',
      emissionEnabled: true,
      perfTimeOrigin: 1785492847000.123,
      perfNow: CLAMPED_NOW
    });
    check('a finer clock reading is left untouched',
      fine === Math.round((1785492847000.123 + CLAMPED_NOW) * 1000), String(fine));

    // No high-resolution clock at all: Date.now() resolves milliseconds, so
    // this fallback used to end in three zeros rather than two.
    function fallbackOpts() {
      return { cwv: 'ok', emissionEnabled: true, perfTimeOrigin: false, perfNow: false };
    }

    var before = Date.now() * 1000;
    var first = micros(fallbackOpts());
    check('Date.now fallback: still the current time in microseconds',
      first >= before && first < Date.now() * 1000 + 1000, String(first));

    var fallbackTails = {};
    var fallbackZero = 0;
    for (i = 0; i < 200; i++) {
      m = micros(fallbackOpts());
      fallbackTails[m % 1000] = true;
      if (m % 1000 === 0) fallbackZero++;
    }
    check('Date.now fallback: the sub-millisecond tail varies',
      Object.keys(fallbackTails).length > 30,
      Object.keys(fallbackTails).length + ' distinct tails in 200 ids');
    check('Date.now fallback: 000 is incidental too',
      fallbackZero < 15, fallbackZero + '/200 ended in 000');

    // The stored format is unchanged, so an id minted by 2.4 is still valid on
    // a visitor's first 2.4.1 page load and is reused, not replaced.
    var legacy = 'con_abcdefghijklmnop.1785492848500000';
    var reused = dataEvents(
      tag({ cwv: 'ok', emissionEnabled: true, localInitial: { conversio_id: legacy } }).dataLayer
    )[0].conversio.conversio_id;
    check('a 2.4-minted id is still accepted and reused', reused === legacy, reused);
  })();

  // 17. INP is not collected (2.4.2 rolls back the 2.4.1 addition)
  (function () {
    var GA_ID = 'G-J4EDMZMNY9';

    function vitalsOf(opts) {
      var evs = dataEvents(tag(opts).dataLayer);
      return evs.length ? evs[0].conversio.conversio_vitals : null;
    }

    function eventEntries() {
      return VITALS_FIXTURE.filter(function (e) { return e.entryType === 'event'; });
    }

    function pushExperience(r) {
      r.window.dataLayer.push({
        event: 'conversioExperience',
        conversio: {
          experience_segment: 's1',
          experience_category: 'c',
          experience_action: 'a',
          experience_label: 'l'
        }
      });
    }

    function experienceVitals(r) {
      var calls = r.gtagCalls.filter(function (c) { return c.name === 'conversio_cro'; });
      return calls.length ? calls[0].params.conversio_vitals : null;
    }

    // The harness fixture still holds everything 2.4.1 measured as INP: a tap
    // whose three events share an interactionId, a 96ms keypress, and a 500ms
    // pointermove that was never an interaction. None of it may show up now.
    var v = vitalsOf({ cwv: 'ok', emissionEnabled: true });
    check('the vitals object has no inp key at all',
      !!v && !('inp' in v), JSON.stringify(v));
    check('the vitals object is exactly lcp, fcp, cls and ps',
      !!v && Object.keys(v).join(',') === 'lcp,fcp,cls,ps', JSON.stringify(v));
    check('no interaction latency reaches any vitals value',
      !!v && [v.lcp, v.fcp, v.cls, v.ps].indexOf(96) === -1 &&
        [v.lcp, v.fcp, v.cls, v.ps].indexOf(500) === -1, JSON.stringify(v));
    check('the measurements INP sat alongside are untouched',
      !!v && v.lcp === 1234.5 && v.fcp === 456.7 && v.cls === 0.07 && v.ps === 2000,
      JSON.stringify(v));

    // Nothing asks the browser for event timing any more, so observing every
    // interaction on the page is a cost that is gone rather than merely
    // unreported, and no observer carries the durationThreshold that only the
    // event type ever took.
    var observed = tag({ cwv: 'ok', emissionEnabled: true }).observedSpecs;
    check('the entry types observed are the three vitals types',
      observed.map(function (spec) { return spec.type; }).sort().join(',') ===
        'largest-contentful-paint,layout-shift,paint',
      JSON.stringify(observed.map(function (spec) { return spec.type; })));
    check('no observer registers for event timing',
      observed.filter(function (spec) { return spec.type === 'event'; }).length === 0,
      JSON.stringify(observed));
    check('no observer asks for a durationThreshold',
      observed.filter(function (spec) { return 'durationThreshold' in spec; }).length === 0,
      JSON.stringify(observed));

    // An interaction latency is no longer a successful collection on its own:
    // 2.4.1 would send a vitals block holding nothing else, and 2.4.2 has
    // nothing worth sending, so the block is dropped and the snapshot is not
    // written. conversio_data itself still fires, as it must whatever CWV does.
    var only = tag({ cwv: 'empty', emissionEnabled: true, entries: eventEntries() });
    var payload = dataEvents(only.dataLayer)[0].conversio;
    check('conversio_data still fires on an interactions-only page',
      !!payload.conversio_id, JSON.stringify(payload));
    check('a page whose only entries are interactions sends no vitals block',
      !('conversio_vitals' in payload), JSON.stringify(payload));
    check('and writes no vitals snapshot',
      !('conversio_vitals' in only.session), JSON.stringify(only.session));

    // The GA4 parameter built from a live collection.
    var ga = tagWithTrackingId(GA_ID, { cwv: 'ok', emissionEnabled: true, gtag: 'spy' });
    pushExperience(ga);
    var gaVitals = experienceVitals(ga);
    check('the GA vitals parameter carries no inp',
      gaVitals === 'lcp:1234.5,fcp:456.7,cls:0.07,ps:2000', String(gaVitals));
    check('so it is shorter than the 2.4.1 parameter, further inside the GA4 limit',
      typeof gaVitals === 'string' &&
        gaVitals.length < 'lcp:1234.5,fcp:456.7,cls:0.07,inp:96,ps:2000'.length,
      gaVitals.length + ' chars: ' + gaVitals);

    // A visitor whose earlier page load in this session ran 2.4.1 has an inp in
    // the stored snapshot. It stays there, a failed collection never
    // overwriting one, but the parameter is built from the vitals this version
    // reports, so the stale key is not forwarded to GA.
    var legacy = tagWithTrackingId(GA_ID, {
      cwv: 'empty',
      emissionEnabled: true,
      gtag: 'spy',
      sessionInitial: { conversio_vitals: '{"lcp":1234.5,"fcp":456.7,"cls":0.07,"inp":96,"ps":2000}' }
    });
    pushExperience(legacy);
    check('an inp left in a 2.4.1 snapshot is not forwarded to GA',
      experienceVitals(legacy) === 'lcp:1234.5,fcp:456.7,cls:0.07,ps:2000',
      String(experienceVitals(legacy)));

    // A 2.4.1 snapshot whose only successful measurement was the interaction is
    // a snapshot with nothing left to report, so it produces no parameter rather
    // than an empty-looking one.
    var legacyInpOnly = tagWithTrackingId(GA_ID, {
      cwv: 'empty',
      emissionEnabled: true,
      gtag: 'spy',
      sessionInitial: { conversio_vitals: '{"lcp":null,"fcp":null,"cls":0,"inp":96,"ps":null}' }
    });
    pushExperience(legacyInpOnly);
    var calls = legacyInpOnly.gtagCalls.filter(function (c) { return c.name === 'conversio_cro'; });
    check('an inp-only 2.4.1 snapshot sends no vitals parameter',
      calls.length === 1 && !('conversio_vitals' in calls[0].params),
      JSON.stringify(calls.length ? calls[0].params : null));
  })();

  // 18. GA4 string parameters are delimited, not JSON (2.4.1)
  (function () {
    var GA_ID = 'G-J4EDMZMNY9';

    function gaRun(opts) {
      opts = opts || {};
      opts.gtag = 'spy';
      return tagWithTrackingId(GA_ID, opts);
    }

    function croCalls(r) {
      return r.gtagCalls.filter(function (c) { return c.name === 'conversio_cro'; });
    }

    function lastParams(r) {
      var calls = croCalls(r);
      return calls.length ? calls[calls.length - 1].params : null;
    }

    function pushExperience(r, seg) {
      r.window.dataLayer.push({
        event: 'conversioExperience',
        conversio: {
          experience_segment: seg,
          experience_category: 'c',
          experience_action: 'a',
          experience_label: 'l'
        }
      });
    }

    function pushEvent(r, seg) {
      r.window.dataLayer.push({
        event: 'conversioEvent',
        conversio: { event_segment: seg, event_category: 'c', event_action: 'a', event_label: 'l' }
      });
    }

    var r = gaRun({ cwv: 'ok', emissionEnabled: true });
    pushExperience(r, 'homepage-hero');
    pushEvent(r, 'cta-click');
    pushEvent(r, 'scroll-50');
    pushExperience(r, 'pricing-table');

    var last = lastParams(r);
    check('experience segments are comma separated, in the order seen',
      last.conversio_experiences === 'homepage-hero,pricing-table',
      String(last.conversio_experiences));
    check('event segments are comma separated, in the order seen',
      last.conversio_events === 'cta-click,scroll-50', String(last.conversio_events));
    check('vitals are key:value pairs',
      last.conversio_vitals === 'lcp:1234.5,fcp:456.7,cls:0.07,ps:2000',
      String(last.conversio_vitals));

    // The point of the change: none of the three carries JSON punctuation any
    // more, so nothing reading them in GA4 sees escaped quotes.
    var joined = [last.conversio_experiences, last.conversio_events, last.conversio_vitals].join('|');
    check('no quotes, brackets or braces in any of the three',
      !/["'{}\[\]]/.test(joined), joined);

    // And they are shorter, which is the character-limit half of the reason.
    check('the list parameter is shorter than the JSON it replaces',
      last.conversio_experiences.length < JSON.stringify(['homepage-hero', 'pricing-table']).length,
      last.conversio_experiences.length + ' vs ' +
        JSON.stringify(['homepage-hero', 'pricing-table']).length);
    check('the vitals parameter is shorter than the JSON it replaces',
      last.conversio_vitals.length <
        '{"lcp":1234.5,"fcp":456.7,"cls":0.07,"ps":2000}'.length,
      String(last.conversio_vitals.length));

    // An empty list is an empty parameter rather than the two characters '[]'.
    var fresh = gaRun({ cwv: 'ok', emissionEnabled: true });
    pushExperience(fresh, 's1');
    check('an empty list is an empty string', lastParams(fresh).conversio_events === '',
      String(lastParams(fresh).conversio_events));

    // A failed measurement is left out rather than sent as a null. cwv 'empty'
    // leaves a seeded snapshot in place, since a failed collection never
    // overwrites one.
    var partial = gaRun({
      cwv: 'empty',
      emissionEnabled: true,
      sessionInitial: { conversio_vitals: '{"lcp":1234.5,"fcp":null,"cls":0.07,"ps":null}' }
    });
    pushExperience(partial, 's1');
    check('null measurements are left out of the parameter',
      lastParams(partial).conversio_vitals === 'lcp:1234.5,cls:0.07',
      String(lastParams(partial).conversio_vitals));

    // A tampered snapshot must not put 'lcp:NaN' into the parameter.
    var nonFinite = gaRun({
      cwv: 'empty',
      emissionEnabled: true,
      sessionInitial: { conversio_vitals: '{"lcp":1e999,"fcp":456.7,"cls":0,"ps":null}' }
    });
    pushExperience(nonFinite, 's1');
    check('non-finite measurements are left out too',
      lastParams(nonFinite).conversio_vitals === 'fcp:456.7,cls:0',
      String(lastParams(nonFinite).conversio_vitals));

    // Unrounded paint timings run to sixteen digits, which would spend a fifth
    // of the budget on precision the clamped clock never had.
    var longFloats = gaRun({
      cwv: 'empty',
      emissionEnabled: true,
      sessionInitial: { conversio_vitals: JSON.stringify({
        lcp: 1234.5999999046326,
        fcp: 456.70000004768372,
        cls: 0.07123456,
        ps: 2000
      }) }
    });
    pushExperience(longFloats, 's1');
    var rounded = lastParams(longFloats).conversio_vitals;
    check('long floats are rounded to what the clock could resolve',
      rounded === 'lcp:1234.6,fcp:456.7,cls:0.071,ps:2000', String(rounded));
    check('so the vitals parameter stays well inside 100 characters',
      rounded.length <= 100, rounded.length + ' chars');

    // Only the GA4 channel changed shape.
    check('the stored vitals snapshot is still JSON',
      r.session.conversio_vitals.charAt(0) === '{', String(r.session.conversio_vitals));
    var payload = dataEvents(r.dataLayer)[0].conversio.conversio_vitals;
    check('conversio_data still carries an object, at full precision',
      isObject(payload) && payload.lcp === 1234.5 && payload.fcp === 456.7,
      JSON.stringify(payload));
    var dlExperience = r.dataLayer.filter(function (e) {
      return e.event === 'conversio_experience_session';
    })[0];
    check('the dataLayer emits still carry no lists at all',
      !!dlExperience && !('conversio_experiences' in dlExperience.conversio),
      JSON.stringify(dlExperience && dlExperience.conversio));

    // A hand-edited list entry that is not a string must not reach the parameter.
    var hostile = gaRun({
      cwv: 'ok',
      emissionEnabled: true,
      sessionInitial: { conversioExperienceList: '["kept",{"a":1},null,42,""]' }
    });
    pushExperience(hostile, 'kept');
    check('non-string list entries are dropped',
      lastParams(hostile).conversio_experiences === 'kept',
      String(lastParams(hostile).conversio_experiences));
  })();

  // 19. Both trigger name conventions are accepted (2.4.2)
  (function () {
    var GA_ID = 'G-J4EDMZMNY9';

    function push(r, name, payload) {
      r.window.dataLayer.push({ event: name, conversio: payload });
    }

    function experiencePayload(seg) {
      return {
        experience_segment: seg,
        experience_category: 'exp-cat',
        experience_action: 'exp-act',
        experience_label: 'exp-lab'
      };
    }

    function eventPayload(seg) {
      return {
        event_segment: seg,
        event_category: 'evt-cat',
        event_action: 'evt-act',
        event_label: 'evt-lab'
      };
    }

    function emitsOf(r, name) {
      return r.dataLayer.filter(function (e) { return e && e.event === name; });
    }

    // Two runs differing only in which name the container pushed. Everything
    // downstream of the match is shared code, so the way to check that is to
    // compare the two runs rather than to re-asssert the payload shape here:
    // the emits and the storage they leave behind must be identical.
    var camel = tag({ cwv: 'ok', emissionEnabled: true });
    push(camel, 'conversioExperience', experiencePayload('s1'));
    push(camel, 'conversioEvent', eventPayload('e1'));

    var snake = tag({ cwv: 'ok', emissionEnabled: true });
    push(snake, 'conversio_experience', experiencePayload('s1'));
    push(snake, 'conversio_event', eventPayload('e1'));

    check('conversio_experience emits one experience session',
      emitsOf(snake, 'conversio_experience_session').length === 1,
      'got ' + emitsOf(snake, 'conversio_experience_session').length);
    check('conversio_event emits one event instance',
      emitsOf(snake, 'conversio_event_instance').length === 1,
      'got ' + emitsOf(snake, 'conversio_event_instance').length);
    check('the experience emit matches the camelCase run field for field',
      JSON.stringify(emitsOf(snake, 'conversio_experience_session')[0]) ===
        JSON.stringify(emitsOf(camel, 'conversio_experience_session')[0]),
      JSON.stringify(emitsOf(snake, 'conversio_experience_session')[0]));
    check('the event emit matches the camelCase run field for field',
      JSON.stringify(emitsOf(snake, 'conversio_event_instance')[0]) ===
        JSON.stringify(emitsOf(camel, 'conversio_event_instance')[0]),
      JSON.stringify(emitsOf(snake, 'conversio_event_instance')[0]));
    check('and both runs leave identical sessionStorage behind',
      JSON.stringify(snake.session) === JSON.stringify(camel.session),
      JSON.stringify(snake.session));

    // A container part-way through the move can push each name, so the two have
    // to share the per-segment state rather than each keeping their own: a
    // segment already reported under one name is not reported again under the
    // other, which would double-count the same experience.
    var mixed = tag({ cwv: 'ok', emissionEnabled: true });
    push(mixed, 'conversioExperience', experiencePayload('s1'));
    push(mixed, 'conversio_experience', experiencePayload('s1'));
    push(mixed, 'conversio_experience', experiencePayload('s2'));
    check('a segment seen under one name is not re-emitted under the other',
      emitsOf(mixed, 'conversio_experience_session').length === 2,
      'got ' + emitsOf(mixed, 'conversio_experience_session').length);
    check('the two segment lists are one list, in the order seen',
      mixed.session.conversioExperienceList === '["s1","s2"]',
      String(mixed.session.conversioExperienceList));

    // Events are one instance per push under either name, since an event is an
    // occurrence rather than a state. A container must not push both names for
    // the same interaction, and the tag reports what it is given.
    var events = tag({ cwv: 'ok', emissionEnabled: true });
    push(events, 'conversioEvent', eventPayload('e1'));
    push(events, 'conversio_event', eventPayload('e1'));
    check('each event push is its own instance, whichever name it used',
      emitsOf(events, 'conversio_event_instance').length === 2,
      'got ' + emitsOf(events, 'conversio_event_instance').length);
    check('and the segment appears once in the event list',
      events.session.conversioEventList === '["e1"]',
      String(events.session.conversioEventList));

    // The pre-load path: items already sitting in the dataLayer when the tag
    // initialises are swept by processExistingDataLayer, which uses the same
    // matcher as the push hook.
    var preloaded = tag({
      cwv: 'ok',
      emissionEnabled: true,
      dataLayerInitial: [
        { event: 'conversio_experience', conversio: experiencePayload('s1') },
        { event: 'conversio_event', conversio: eventPayload('e1') }
      ]
    });
    check('a snake_case experience already in the dataLayer is picked up',
      emitsOf(preloaded, 'conversio_experience_session').length === 1,
      'got ' + emitsOf(preloaded, 'conversio_experience_session').length);
    check('a snake_case event already in the dataLayer is picked up',
      emitsOf(preloaded, 'conversio_event_instance').length === 1,
      'got ' + emitsOf(preloaded, 'conversio_event_instance').length);

    // The consent gate sits downstream of the match, so a snake_case event
    // pushed before consent is buffered and delivered on flush, exactly as the
    // camelCase one is.
    var gated = tag({ cwv: 'ok' });
    push(gated, 'conversio_event', eventPayload('e1'));
    push(gated, 'conversio_experience', experiencePayload('s1'));
    check('nothing is emitted before consent',
      emitsOf(gated, 'conversio_event_instance').length === 0 &&
        emitsOf(gated, 'conversio_experience_session').length === 0,
      JSON.stringify(gated.dataLayer.map(function (e) { return e && e.event; })));
    gated.window.__conversioEnableEmission__();
    gated.drain();
    check('and both arrive on consent',
      emitsOf(gated, 'conversio_event_instance').length === 1 &&
        emitsOf(gated, 'conversio_experience_session').length === 1,
      JSON.stringify(gated.dataLayer.map(function (e) { return e && e.event; })));

    // GA4 delivery is downstream too: a snake_case trigger sends the same
    // conversio_cro, its parameters differing only in the random conversio_id.
    function croParams(r) {
      var calls = r.gtagCalls.filter(function (c) { return c.name === 'conversio_cro'; });
      return calls.map(function (c) {
        var copy = Object.assign({}, c.params);
        delete copy.conversio_id;
        return copy;
      });
    }

    var gaCamel = tagWithTrackingId(GA_ID, { cwv: 'ok', emissionEnabled: true, gtag: 'spy' });
    push(gaCamel, 'conversioExperience', experiencePayload('s1'));
    push(gaCamel, 'conversioEvent', eventPayload('e1'));

    var gaSnake = tagWithTrackingId(GA_ID, { cwv: 'ok', emissionEnabled: true, gtag: 'spy' });
    push(gaSnake, 'conversio_experience', experiencePayload('s1'));
    push(gaSnake, 'conversio_event', eventPayload('e1'));

    check('a snake_case trigger sends the same two conversio_cro events',
      croParams(gaSnake).length === 2 &&
        JSON.stringify(croParams(gaSnake)) === JSON.stringify(croParams(gaCamel)),
      JSON.stringify(croParams(gaSnake)));

    // Neither name is a trigger on its own: the payload object is still
    // required, and no other event name became one by being close to these.
    var ignored = tag({ cwv: 'ok', emissionEnabled: true });
    ignored.window.dataLayer.push({ event: 'conversio_experience' });
    ignored.window.dataLayer.push({ event: 'conversio_event', conversio: 'not-an-object' });
    push(ignored, 'conversio_experiences', experiencePayload('s1'));
    push(ignored, 'Conversio_Event', eventPayload('e1'));
    push(ignored, 'conversio_experience_v2', experiencePayload('s2'));
    check('a trigger name with no usable conversio payload is ignored',
      emitsOf(ignored, 'conversio_event_instance').length === 0,
      JSON.stringify(ignored.dataLayer.map(function (e) { return e && e.event; })));
    check('a near-miss name is not a trigger, and the match is case sensitive',
      emitsOf(ignored, 'conversio_experience_session').length === 0 &&
        !ignored.session.conversioExperienceList && !ignored.session.conversioEventList,
      JSON.stringify(ignored.session));
  })();

  // 20. The client stream: the same machinery under client_ names (2.5)
  (function () {
    var GA_ID = 'G-J4EDMZMNY9';

    function pushClientExperience(r, seg) {
      r.window.dataLayer.push({
        event: 'client_experience',
        client: {
          experience_segment: seg,
          experience_category: 'c-exp-cat',
          experience_action: 'c-exp-act',
          experience_label: 'c-exp-lab'
        }
      });
    }

    function pushClientEvent(r, seg) {
      r.window.dataLayer.push({
        event: 'client_event',
        client: {
          event_segment: seg,
          event_category: 'c-evt-cat',
          event_action: 'c-evt-act',
          event_label: 'c-evt-lab'
        }
      });
    }

    function emitsOf(r, name) {
      return r.dataLayer.filter(function (e) { return e && e.event === name; });
    }

    function callsOf(r, name) {
      return r.gtagCalls.filter(function (c) { return c.name === name; });
    }

    var r = tagWithTrackingId(GA_ID, consented({ cwv: 'ok', gtag: 'spy' }));
    pushClientExperience(r, 'cs1');
    pushClientEvent(r, 'ce1');

    // The dataLayer emits: our shape, under the client's names and payload key.
    var exp = emitsOf(r, 'client_experience_session')[0];
    var evt = emitsOf(r, 'client_event_instance')[0];
    check('a client_experience emits one client_experience_session',
      emitsOf(r, 'client_experience_session').length === 1,
      'got ' + emitsOf(r, 'client_experience_session').length);
    check('a client_event emits one client_event_instance',
      emitsOf(r, 'client_event_instance').length === 1,
      'got ' + emitsOf(r, 'client_event_instance').length);
    check('the experience emit carries its payload under a client key',
      !!exp && !('conversio' in exp) && JSON.stringify(exp.client) === JSON.stringify({
        experience_segment: 'cs1',
        experience_category: 'c-exp-cat',
        experience_action: 'c-exp-act',
        experience_label: 'c-exp-lab'
      }), JSON.stringify(exp));
    check('the event emit carries its payload under a client key',
      !!evt && !('conversio' in evt) && JSON.stringify(evt.client) === JSON.stringify({
        event_category: 'c-evt-cat',
        event_action: 'c-evt-act',
        event_label: 'c-evt-lab',
        event_segment: 'ce1'
      }), JSON.stringify(evt));

    // GA4: client_cro, client_ parameters, pinned to the same property. The
    // whole parameter object is compared, so an extra key appearing here fails
    // rather than passing unnoticed.
    var calls = callsOf(r, 'client_cro');
    check('each client emit sends one client_cro', calls.length === 2, 'got ' + calls.length);
    check('the experience send carries exactly the client_ parameters',
      calls.length === 2 && JSON.stringify(calls[0].params) === JSON.stringify({
        client_category: 'c-exp-cat',
        client_action: 'c-exp-act',
        client_label: 'c-exp-lab',
        client_segment: 'cs1',
        client_experiences: 'cs1',
        client_events: '',
        send_to: GA_ID
      }), JSON.stringify(calls.length ? calls[0].params : null));
    check('the event send carries exactly the client_ parameters',
      calls.length === 2 && JSON.stringify(calls[1].params) === JSON.stringify({
        client_category: 'c-evt-cat',
        client_action: 'c-evt-act',
        client_label: 'c-evt-lab',
        client_segment: 'ce1',
        client_experiences: 'cs1',
        client_events: 'ce1',
        send_to: GA_ID
      }), JSON.stringify(calls.length > 1 ? calls[1].params : null));
    check('a client push sends no conversio_cro',
      callsOf(r, 'conversio_cro').length === 0,
      JSON.stringify(callsOf(r, 'conversio_cro')));

    // The de-duplication rules are the ones our own stream follows, because it
    // is the same code: an experience is a state reported once per segment, an
    // event is an occurrence reported once per push.
    var repeat = tagWithTrackingId(GA_ID, consented({ cwv: 'ok', gtag: 'spy' }));
    pushClientExperience(repeat, 'cs1');
    pushClientExperience(repeat, 'cs1');
    pushClientEvent(repeat, 'ce1');
    pushClientEvent(repeat, 'ce1');
    check('a repeated client experience segment emits once',
      emitsOf(repeat, 'client_experience_session').length === 1,
      'got ' + emitsOf(repeat, 'client_experience_session').length);
    check('a repeated client event emits once per push',
      emitsOf(repeat, 'client_event_instance').length === 2,
      'got ' + emitsOf(repeat, 'client_event_instance').length);
    check('and the client event segment is listed once',
      repeat.session.clientEventList === '["ce1"]',
      String(repeat.session.clientEventList));

    // A client experience with no segment is ignored rather than emitted under
    // an empty one, as ours is.
    var noSeg = tag(consented({ cwv: 'ok' }));
    noSeg.window.dataLayer.push({ event: 'client_experience', client: { experience_category: 'c' } });
    check('a client experience with no segment is ignored',
      emitsOf(noSeg, 'client_experience_session').length === 0 &&
        !noSeg.session.clientExperienceList,
      JSON.stringify(noSeg.session));

    // The init sweep of what is already on the dataLayer matches client
    // triggers too, since it runs the same matcher as the push hook.
    var preloaded = tag(consented({
      cwv: 'ok',
      dataLayerInitial: [
        { event: 'client_experience', client: { experience_segment: 'cs1' } },
        { event: 'client_event', client: { event_segment: 'ce1' } }
      ]
    }));
    check('client triggers already on the dataLayer are picked up',
      emitsOf(preloaded, 'client_experience_session').length === 1 &&
        emitsOf(preloaded, 'client_event_instance').length === 1,
      JSON.stringify(preloaded.dataLayer.map(function (e) { return e && e.event; })));

    // The payload key is part of the match, so the streams cannot be crossed by
    // pushing one stream's name with the other's payload object.
    var crossed = tag(consented({ cwv: 'ok' }));
    crossed.window.dataLayer.push({
      event: 'client_experience',
      conversio: { experience_segment: 'x1' }
    });
    crossed.window.dataLayer.push({
      event: 'conversio_experience',
      client: { experience_segment: 'x2' }
    });
    check('a client_experience carrying a conversio payload is not a trigger',
      emitsOf(crossed, 'client_experience_session').length === 0,
      JSON.stringify(crossed.session));
    check('a conversio_experience carrying a client payload is not a trigger',
      emitsOf(crossed, 'conversio_experience_session').length === 0,
      JSON.stringify(crossed.session));
    check('and neither wrote anything to storage',
      !crossed.session.clientExperienceList && !crossed.session.conversioExperienceList,
      JSON.stringify(crossed.session));

    // The client stream has no legacy name: only the snake_case pair is
    // accepted, there being no container pushing anything else yet.
    var camel = tag(consented({ cwv: 'ok' }));
    camel.window.dataLayer.push({
      event: 'clientExperience',
      client: { experience_segment: 'cs1' }
    });
    camel.window.dataLayer.push({ event: 'clientEvent', client: { event_segment: 'ce1' } });
    check('camelCase client names are not triggers',
      emitsOf(camel, 'client_experience_session').length === 0 &&
        emitsOf(camel, 'client_event_instance').length === 0,
      JSON.stringify(camel.dataLayer.map(function (e) { return e && e.event; })));
  })();

  // 21. The two streams share nothing (2.5)
  (function () {
    var GA_ID = 'G-J4EDMZMNY9';

    function pushConversioExperience(r, seg) {
      r.window.dataLayer.push({
        event: 'conversio_experience',
        conversio: {
          experience_segment: seg,
          experience_category: 'exp-cat',
          experience_action: 'exp-act',
          experience_label: 'exp-lab'
        }
      });
    }

    function pushConversioEvent(r, seg) {
      r.window.dataLayer.push({
        event: 'conversio_event',
        conversio: { event_segment: seg, event_category: 'evt-cat' }
      });
    }

    function pushClientExperience(r, seg) {
      r.window.dataLayer.push({
        event: 'client_experience',
        client: {
          experience_segment: seg,
          experience_category: 'c-exp-cat',
          experience_action: 'c-exp-act',
          experience_label: 'c-exp-lab'
        }
      });
    }

    function pushClientEvent(r, seg) {
      r.window.dataLayer.push({
        event: 'client_event',
        client: { event_segment: seg, event_category: 'c-evt-cat' }
      });
    }

    function paramsOf(r, name) {
      return r.gtagCalls
        .filter(function (c) { return c.name === name; })
        .map(function (c) { return c.params; });
    }

    function keysNamed(session, needle) {
      return Object.keys(session).filter(function (k) {
        return k.toLowerCase().indexOf(needle) !== -1;
      }).sort();
    }

    function subsetNamed(session, needle) {
      var out = {};
      keysNamed(session, needle).forEach(function (k) { out[k] = session[k]; });
      return out;
    }

    // The comparison run: the same Conversio pushes with no client pushes at
    // all. Adding the client stream to a page must leave our own side of the
    // storage and our own emits exactly as they were.
    var ours = tagWithTrackingId(GA_ID, consented({ cwv: 'ok', gtag: 'spy' }));
    pushConversioExperience(ours, 's1');
    pushConversioEvent(ours, 'e1');

    var both = tagWithTrackingId(GA_ID, consented({ cwv: 'ok', gtag: 'spy' }));
    pushConversioExperience(both, 's1');
    pushClientExperience(both, 'cs1');
    pushConversioEvent(both, 'e1');
    pushClientEvent(both, 'ce1');

    check('the conversio storage is identical with and without client pushes',
      JSON.stringify(subsetNamed(both.session, 'conversio')) ===
        JSON.stringify(subsetNamed(ours.session, 'conversio')),
      JSON.stringify(subsetNamed(both.session, 'conversio')));
    check('and so are the conversio_cro sends, bar the random id',
      JSON.stringify(paramsOf(both, 'conversio_cro').map(function (p) {
        p = Object.assign({}, p);
        delete p.conversio_id;
        return p;
      })) === JSON.stringify(paramsOf(ours, 'conversio_cro').map(function (p) {
        p = Object.assign({}, p);
        delete p.conversio_id;
        return p;
      })),
      JSON.stringify(paramsOf(both, 'conversio_cro')));

    check('each experience list holds only its own stream\'s segments',
      both.session.conversioExperienceList === '["s1"]' &&
        both.session.clientExperienceList === '["cs1"]',
      JSON.stringify(both.session));
    check('each event list holds only its own stream\'s segments',
      both.session.conversioEventList === '["e1"]' &&
        both.session.clientEventList === '["ce1"]',
      JSON.stringify(both.session));
    check('the client storage keys are exactly the five expected',
      JSON.stringify(keysNamed(both.session, 'client')) === JSON.stringify([
        'clientEmissionEnabled', 'clientEventList', 'clientExperienceFired',
        'clientExperienceList', 'clientExperienceMap'
      ]), JSON.stringify(keysNamed(both.session, 'client')));
    check('and no key belongs to both namespaces at once',
      Object.keys(both.session).filter(function (k) {
        var lower = k.toLowerCase();
        return lower.indexOf('client') !== -1 && lower.indexOf('conversio') !== -1;
      }).length === 0, JSON.stringify(Object.keys(both.session)));

    // The segment lists reach GA4 per stream: a client's own reporting never
    // shows our segments and ours never shows theirs.
    var clientParams = paramsOf(both, 'client_cro');
    var ourParams = paramsOf(both, 'conversio_cro');
    check('our sends carry no client segments',
      ourParams.length === 2 &&
        ourParams[1].conversio_experiences === 's1' &&
        ourParams[1].conversio_events === 'e1',
      JSON.stringify(ourParams));
    check('their sends carry no conversio segments',
      clientParams.length === 2 &&
        clientParams[1].client_experiences === 'cs1' &&
        clientParams[1].client_events === 'ce1',
      JSON.stringify(clientParams));

    // One segment name used by both streams is two separate reports: neither
    // de-duplicates against the other's state.
    var sameName = tagWithTrackingId(GA_ID, consented({ cwv: 'ok', gtag: 'spy' }));
    pushConversioExperience(sameName, 'shared');
    pushClientExperience(sameName, 'shared');
    check('the same segment name reported to both streams emits on both',
      sameName.dataLayer.filter(function (e) {
        return e && e.event === 'conversio_experience_session';
      }).length === 1 &&
      sameName.dataLayer.filter(function (e) {
        return e && e.event === 'client_experience_session';
      }).length === 1,
      JSON.stringify(sameName.dataLayer.map(function (e) { return e && e.event; })));

    // Neither stream reads the other's fired set, so a segment already reported
    // on one side does not silence the other.
    var crossFired = tag(consented({
      cwv: 'ok',
      sessionInitial: { clientExperienceFired: '{"shared":true}' }
    }));
    pushConversioExperience(crossFired, 'shared');
    pushClientExperience(crossFired, 'shared');
    check('a fired client segment does not silence the conversio one',
      crossFired.dataLayer.filter(function (e) {
        return e && e.event === 'conversio_experience_session';
      }).length === 1, JSON.stringify(crossFired.session));
    check('while the client one is correctly suppressed by its own fired set',
      crossFired.dataLayer.filter(function (e) {
        return e && e.event === 'client_experience_session';
      }).length === 0, JSON.stringify(crossFired.session));
  })();

  // 22. The client stream carries no identity and no vitals (2.5)
  (function () {
    var GA_ID = 'G-J4EDMZMNY9';
    var VITALS_STORED = '{"lcp":1234.5,"fcp":456.7,"cls":0.07,"ps":2000}';

    function pushClientExperience(r, seg) {
      r.window.dataLayer.push({
        event: 'client_experience',
        client: { experience_segment: seg, experience_category: 'c' }
      });
    }

    function pushClientEvent(r, seg) {
      r.window.dataLayer.push({
        event: 'client_event',
        client: { event_segment: seg, event_category: 'c' }
      });
    }

    // Vitals are seeded as well as collected, so the experience send is made
    // with a snapshot definitely in storage: the parameter is absent because the
    // stream does not carry it, not because there was nothing to carry.
    var r = tagWithTrackingId(GA_ID, consented({
      cwv: 'ok',
      gtag: 'spy',
      sessionInitial: { conversio_vitals: VITALS_STORED }
    }));
    pushClientExperience(r, 'cs1');
    pushClientEvent(r, 'ce1');

    var calls = r.gtagCalls.filter(function (c) { return c.name === 'client_cro'; });
    var keys = calls.reduce(function (all, c) { return all.concat(Object.keys(c.params)); }, []);
    check('no client send carries a conversio_id',
      calls.length === 2 && keys.indexOf('conversio_id') === -1, JSON.stringify(keys));
    check('nor a client_id, there being no such identifier',
      keys.indexOf('client_id') === -1, JSON.stringify(keys));
    check('nor any identifier under another name',
      keys.filter(function (k) { return /_id$/.test(k); }).length === 0, JSON.stringify(keys));
    check('no client send carries vitals, with a snapshot in storage to carry',
      keys.indexOf('client_vitals') === -1 && keys.indexOf('conversio_vitals') === -1,
      JSON.stringify(keys));
    check('the snapshot was there to be carried',
      r.session.conversio_vitals === VITALS_STORED, String(r.session.conversio_vitals));

    // Nothing client-shaped is produced once per page load: there is one data
    // event, ours, and the client stream neither duplicates nor disturbs it.
    check('no client_data event is emitted',
      r.dataLayer.filter(function (e) { return e && e.event === 'client_data'; }).length === 0,
      JSON.stringify(r.dataLayer.map(function (e) { return e && e.event; })));
    check('conversio_data still fires exactly once',
      dataEvents(r.dataLayer).length === 1, 'got ' + dataEvents(r.dataLayer).length);
    check('and still carries the id and the vitals',
      !!dataEvents(r.dataLayer)[0].conversio.conversio_id &&
        !!dataEvents(r.dataLayer)[0].conversio.conversio_vitals,
      JSON.stringify(dataEvents(r.dataLayer)[0].conversio));

    // No identifier is minted or persisted for the client stream, so a page
    // whose only pushes are client ones leaves localStorage holding the one id
    // conversio_data already needed.
    check('localStorage holds the conversio_id and nothing else',
      JSON.stringify(Object.keys(r.local).sort()) === JSON.stringify(['conversio_id']),
      JSON.stringify(r.local));

    // And with no localStorage at all, the client stream is unaffected: it never
    // touches it, so there is nothing for a blocked store to cost it.
    var noStore = tagWithTrackingId(GA_ID, consented({
      cwv: 'ok',
      gtag: 'spy',
      localStorage: false
    }));
    pushClientExperience(noStore, 'cs1');
    var noStoreCalls = noStore.gtagCalls.filter(function (c) { return c.name === 'client_cro'; });
    check('a client send still goes out with no localStorage',
      noStoreCalls.length === 1 && noStoreCalls[0].params.client_segment === 'cs1',
      JSON.stringify(noStoreCalls));
  })();

  // 23. One consent control, two gates (2.5)
  (function () {
    var GA_ID = 'G-J4EDMZMNY9';

    function pushConversioExperience(r, seg) {
      r.window.dataLayer.push({
        event: 'conversio_experience',
        conversio: { experience_segment: seg, experience_category: 'c' }
      });
    }

    function pushClientExperience(r, seg) {
      r.window.dataLayer.push({
        event: 'client_experience',
        client: { experience_segment: seg, experience_category: 'c' }
      });
    }

    function pushClientEvent(r, seg) {
      r.window.dataLayer.push({
        event: 'client_event',
        client: { event_segment: seg, event_category: 'c' }
      });
    }

    function emitsOf(r, name) {
      return r.dataLayer.filter(function (e) { return e && e.event === name; });
    }

    // A visitor who has not consented: the client stream is gated exactly as
    // ours is, and for the same reason.
    var gated = tagWithTrackingId(GA_ID, { cwv: 'ok', gtag: 'spy' });
    pushClientExperience(gated, 'cs1');
    pushClientEvent(gated, 'ce1');
    check('nothing client-shaped is emitted before consent',
      emitsOf(gated, 'client_experience_session').length === 0 &&
        emitsOf(gated, 'client_event_instance').length === 0,
      JSON.stringify(gated.dataLayer.map(function (e) { return e && e.event; })));
    check('and nothing reaches GA either',
      gated.gtagCalls.filter(function (c) { return c.name === 'client_cro'; }).length === 0,
      JSON.stringify(gated.gtagCalls));
    check('the client event is buffered against its own key',
      !!gated.session.clientEventBuffer &&
        gated.session.clientEventBuffer.indexOf('ce1') !== -1 &&
        !gated.session.conversioEventBuffer,
      JSON.stringify(gated.session));
    check('and the client experience is recorded, waiting to be flushed',
      gated.session.clientExperienceList === '["cs1"]' &&
        !gated.session.clientExperienceFired,
      JSON.stringify(gated.session));

    // The one control opens both gates, so a consent platform calling what it
    // calls today does not leave the client stream shut.
    gated.window.__conversioEnableEmission__();
    gated.drain();
    check('one enable call writes both gate keys',
      gated.session.conversioEmissionEnabled === 'true' &&
        gated.session.clientEmissionEnabled === 'true',
      JSON.stringify(gated.session));
    check('the buffered client experience arrives on consent',
      emitsOf(gated, 'client_experience_session').length === 1,
      'got ' + emitsOf(gated, 'client_experience_session').length);
    check('the buffered client event arrives on consent',
      emitsOf(gated, 'client_event_instance').length === 1,
      'got ' + emitsOf(gated, 'client_event_instance').length);
    check('and both reach GA',
      gated.gtagCalls.filter(function (c) { return c.name === 'client_cro'; }).length === 2,
      JSON.stringify(gated.gtagCalls.map(function (c) { return c.name; })));

    // Flushing again must not double-report: the fired set and the emptied
    // buffer are what stop it, per stream.
    gated.window.__conversioFlushEmission__();
    gated.drain();
    check('a second flush emits nothing further',
      emitsOf(gated, 'client_experience_session').length === 1 &&
        emitsOf(gated, 'client_event_instance').length === 1,
      JSON.stringify(gated.dataLayer.map(function (e) { return e && e.event; })));

    // Disabling closes both, and a client push after it is buffered rather than
    // emitted, exactly as ours would be.
    gated.window.__conversioDisableEmission__();
    check('one disable call closes both gates',
      gated.session.conversioEmissionEnabled === 'false' &&
        gated.session.clientEmissionEnabled === 'false',
      JSON.stringify(gated.session));
    pushClientEvent(gated, 'ce2');
    check('a client event pushed after consent is withdrawn is not emitted',
      emitsOf(gated, 'client_event_instance').length === 1,
      'got ' + emitsOf(gated, 'client_event_instance').length);

    // The version boundary: a visitor who consented earlier in this session, on
    // a page served 2.4.2, has the conversio key set and no client key at all.
    // Our stream carries on; theirs holds its events until consent is signalled
    // again, which costs a delay rather than the data.
    var midUpgrade = tagWithTrackingId(GA_ID, {
      cwv: 'ok',
      gtag: 'spy',
      sessionInitial: { conversioEmissionEnabled: 'true' }
    });
    pushConversioExperience(midUpgrade, 's1');
    pushClientExperience(midUpgrade, 'cs1');
    pushClientEvent(midUpgrade, 'ce1');
    check('our stream emits as usual on a mid-upgrade session',
      emitsOf(midUpgrade, 'conversio_experience_session').length === 1,
      'got ' + emitsOf(midUpgrade, 'conversio_experience_session').length);
    check('the client stream holds until consent is signalled again',
      emitsOf(midUpgrade, 'client_experience_session').length === 0 &&
        emitsOf(midUpgrade, 'client_event_instance').length === 0,
      JSON.stringify(midUpgrade.dataLayer.map(function (e) { return e && e.event; })));
    midUpgrade.window.__conversioEnableEmission__();
    midUpgrade.drain();
    check('and arrives in full once it is, nothing having been dropped',
      emitsOf(midUpgrade, 'client_experience_session').length === 1 &&
        emitsOf(midUpgrade, 'client_event_instance').length === 1,
      JSON.stringify(midUpgrade.dataLayer.map(function (e) { return e && e.event; })));
    check('without re-emitting the experience our stream already reported',
      emitsOf(midUpgrade, 'conversio_experience_session').length === 1,
      'got ' + emitsOf(midUpgrade, 'conversio_experience_session').length);
  })();

  // 24. Collection waits for the paint, and marks a load nobody looked at (2.5.1)
  (function () {
    var GA_ID = 'G-J4EDMZMNY9';

    // The load this exists for, taken from a real one. The tab starts hidden, so
    // the browser defers painting entirely; load fires with nothing drawn; the
    // visitor looks at the tab at 1682ms and the first contentful paint lands at
    // 1864ms, long after the idle period that used to close collection. No
    // largest-contentful-paint entry is produced for such a load at all, which is
    // the browser's rule rather than something a tag can work around, so the
    // fixture has none to find.
    var BACKGROUND_LOAD = [
      { entryType: 'visibility-state', name: 'hidden', startTime: 0 },
      { entryType: 'visibility-state', name: 'visible', startTime: 1682 },
      { entryType: 'paint', name: 'first-paint', startTime: 1864 },
      { entryType: 'paint', name: 'first-contentful-paint', startTime: 1864 },
      { entryType: 'layout-shift', name: '', startTime: 1900, value: 0.04, hadRecentInput: false }
    ];
    var ARRIVES_AT = { paint: 1864, 'layout-shift': 1900 };

    function vitalsOf(r) {
      var evs = dataEvents(r.dataLayer);
      return evs.length ? evs[0].conversio.conversio_vitals : null;
    }

    var late = tag({
      cwv: 'ok',
      emissionEnabled: true,
      entries: BACKGROUND_LOAD,
      entryDelays: ARRIVES_AT,
      autoDrain: false
    });

    // A second in, the page still has not painted, so there is nothing worth
    // reporting and collection is still open. This is the check 2.5 fails: it
    // closes on the first idle period and reports the nulls it has.
    late.drain({ until: 1000 });
    check('conversio_data waits while the page has painted nothing',
      dataEvents(late.dataLayer).length === 0,
      JSON.stringify(late.dataLayer.map(function (e) { return e && e.event; })));

    late.drain();
    var v = vitalsOf(late);
    check('and fires once the paint arrives',
      dataEvents(late.dataLayer).length === 1, 'got ' + dataEvents(late.dataLayer).length);
    check('reporting the real fcp rather than null', !!v && v.fcp === 1864, JSON.stringify(v));
    check('with lcp null, no browser reporting one for such a load',
      !!v && v.lcp === null, JSON.stringify(v));
    check('and vis marking why that null is there', !!v && v.vis === 0, JSON.stringify(v));
    check('the page load time is unaffected by the wait',
      !!v && v.ps === 2000, JSON.stringify(v));
    check('as is the layout shift, which arrived later still',
      !!v && v.cls === 0.04, JSON.stringify(v));

    // The wait costs nothing on a page that had already painted when the tag
    // looked, which is the normal case: the event is out at the first
    // opportunity, exactly as in 2.5.
    var prompt = tag({ cwv: 'ok', emissionEnabled: true, autoDrain: false });
    prompt.drain({ until: 0 });
    check('a page that has painted reports without waiting',
      dataEvents(prompt.dataLayer).length === 1,
      'got ' + dataEvents(prompt.dataLayer).length);

    // A background tab the visitor never opens paints nothing at all. The
    // retries run out, the hard timeout closes collection, and the nulls that
    // are genuinely all there is get reported rather than the event being held
    // for ever: a deferred close must never become a lost one.
    var never = tag({
      cwv: 'ok',
      emissionEnabled: true,
      entries: [
        { entryType: 'visibility-state', name: 'hidden', startTime: 0 },
        { entryType: 'layout-shift', name: '', startTime: 100, value: 0.02, hadRecentInput: false }
      ]
    });
    var nv = vitalsOf(never);
    check('a page that never paints still reports',
      dataEvents(never.dataLayer).length === 1, 'got ' + dataEvents(never.dataLayer).length);
    check('with both paint timings null and the marker set',
      !!nv && nv.lcp === null && nv.fcp === null && nv.vis === 0, JSON.stringify(nv));
    check('and the conversio_id present as always',
      !!dataEvents(never.dataLayer)[0].conversio.conversio_id,
      JSON.stringify(dataEvents(never.dataLayer)[0].conversio));

    // The marker follows the visibility at navigation rather than at the moment
    // the tag happened to look, so the load above stays marked even though it
    // was visible again by the time collection closed.
    check('a load visible again by the close is still marked',
      !!v && v.vis === 0, JSON.stringify(v));

    // A load that started visible carries no marker, being the norm.
    var normal = tag({ cwv: 'ok', emissionEnabled: true });
    check('a load that started visible carries no vis key',
      !!vitalsOf(normal) && !('vis' in vitalsOf(normal)), JSON.stringify(vitalsOf(normal)));

    // Nor does one the visitor hid later: that is a visitor leaving a tab, not a
    // load nobody watched.
    var hiddenLater = tag({
      cwv: 'ok',
      emissionEnabled: true,
      entries: VITALS_FIXTURE.concat([
        { entryType: 'visibility-state', name: 'visible', startTime: 0 },
        { entryType: 'visibility-state', name: 'hidden', startTime: 3000 }
      ])
    });
    check('nor does one hidden only later',
      !('vis' in vitalsOf(hiddenLater)), JSON.stringify(vitalsOf(hiddenLater)));

    // Where a browser keeps no visibility-state entries, the reading taken when
    // collection started is what answers the question.
    var noEntries = tag({
      cwv: 'ok',
      emissionEnabled: true,
      visibilityState: 'hidden',
      entries: VITALS_FIXTURE
    });
    check('with no visibility entries, document.visibilityState answers',
      vitalsOf(noEntries).vis === 0, JSON.stringify(vitalsOf(noEntries)));

    // vis is a marker rather than a measurement, so it cannot make an empty
    // collection worth reporting: a hidden load that measured nothing sends
    // nothing, as a failed collection always has.
    var nothing = tag({
      cwv: 'empty',
      emissionEnabled: true,
      visibilityState: 'hidden',
      entries: []
    });
    check('a hidden load that measured nothing sends no vitals block',
      !('conversio_vitals' in dataEvents(nothing.dataLayer)[0].conversio),
      JSON.stringify(dataEvents(nothing.dataLayer)[0].conversio));

    // The GA4 parameter: the marker last, the measurement that failed left out,
    // and the whole thing still inside the 100 characters GA4 allows.
    var ga = tagWithTrackingId(GA_ID, {
      cwv: 'ok',
      emissionEnabled: true,
      gtag: 'spy',
      entries: BACKGROUND_LOAD,
      entryDelays: ARRIVES_AT
    });
    ga.window.dataLayer.push({
      event: 'conversio_experience',
      conversio: { experience_segment: 's1', experience_category: 'c' }
    });
    var param = ga.gtagCalls.filter(function (c) {
      return c.name === 'conversio_cro';
    })[0].params.conversio_vitals;
    check('the parameter carries fcp and the marker, with lcp left out',
      param === 'fcp:1864,cls:0.04,ps:2000,vis:0', String(param));
    check('and stays inside the GA4 100-character limit',
      typeof param === 'string' && param.length <= 100, param.length + ' chars');

    // The fallback, for a measurement the observers never delivered. Which entry
    // types a browser exposes to a synchronous read differs between browsers and
    // the harness exposes both, so this covers the reading rather than that
    // difference: what it pins is that a dead observer still yields the
    // measurements the timeline holds.
    var noObservers = tag({
      cwv: 'observer-throws',
      emissionEnabled: true,
      entries: VITALS_FIXTURE
    });
    var nov = vitalsOf(noObservers);
    check('a failed observer still yields lcp and fcp from the entry types',
      !!nov && nov.lcp === 1234.5 && nov.fcp === 456.7, JSON.stringify(nov));
  })();

  // 25. conversioAbtastyTracking: the public AB Tasty helper
  //
  // ABTasty and conversio_sample are both set on the window after the tag has
  // run, which is where a real AB Tasty test sets them: the tag reads each one
  // at call time rather than at init, so a test's own script can define them
  // immediately before the call, as the convention has it.
  (function () {
    // One AB Tasty campaign, in the shape getTestsOnPage returns.
    function tests(name, variationName) {
      return { '12345': { name: name, variationName: variationName } };
    }

    // Runs the tag, installs an AB Tasty global and a sample flag, then makes
    // the call and hands back what the dataLayer received.
    function call(opts) {
      opts = opts || {};
      var r = tag(consented({}));
      var before = r.dataLayer.length;
      var returned;

      r.window.ABTasty = {
        getTestsOnPage: function () {
          if (opts.throws) throw new Error('ABTasty not ready');
          return opts.tests;
        }
      };
      if ('sample' in opts) r.window.conversio_sample = opts.sample;
      if ('stream' in opts) r.window.conversio_experience = opts.stream;

      returned = r.window.conversioAbtastyTracking(
        'testId' in opts ? opts.testId : '12345'
      );
      r.drain();

      return {
        returned: returned,
        pushed: r.dataLayer.slice(before).filter(function (e) {
          return e && (e.event === 'conversio_experience' || e.event === 'client_experience');
        }),
        emitted: r.dataLayer.slice(before).filter(function (e) {
          return e && (e.event === 'conversio_experience_session' ||
                       e.event === 'client_experience_session');
        }),
        session: r.session,
        window: r.window,
        dataLayer: r.dataLayer,
        drain: r.drain
      };
    }

    var exposed = tag(consented({}));
    check('conversioAbtastyTracking is exposed on the window',
      typeof exposed.window.conversioAbtastyTracking === 'function',
      typeof exposed.window.conversioAbtastyTracking);

    // The payload, off whichever key the stream it went to uses.
    function payload(r) {
      var item = r.pushed[0];
      if (!item) return null;
      return item.conversio || item.client || null;
    }

    // The unsampled path, end to end.
    (function () {
      var r = call({ tests: tests('ABC | Homepage hero', 'Variation 2 | blue button') });
      var p = payload(r);
      check('unsampled: returns true', r.returned === true, String(r.returned));
      check('unsampled: one conversio_experience pushed', r.pushed.length === 1, 'got ' + r.pushed.length);
      check('unsampled: segment is code plus variation number',
        !!p && p.experience_segment === 'ABC.XV2', JSON.stringify(p));
      check('unsampled: category is fixed for our stream',
        !!p && p.experience_category === 'Conversio Experience', JSON.stringify(p));
      check('unsampled: action is code, id and campaign name',
        !!p && p.experience_action === 'ABC | 12345 | ABC | Homepage hero', JSON.stringify(p));
      check('unsampled: label is id and variation name',
        !!p && p.experience_label === '12345 | Variation 2 | blue button', JSON.stringify(p));
    })();

    // What it pushes is an ordinary conversio_experience: the push hook picks
    // it up, so it is emitted and stored like any other.
    (function () {
      var r = call({ tests: tests('ABC | Homepage hero', 'Variation 2 | blue button') });
      var e = r.emitted[0] && r.emitted[0].conversio;
      check('the push is processed into a session emit', r.emitted.length === 1, 'got ' + r.emitted.length);
      check('the emit carries the derived segment',
        !!e && e.experience_segment === 'ABC.XV2', JSON.stringify(e));
      check('the segment is stored in the Conversio experience map',
        !!r.session.conversioExperienceMap &&
          r.session.conversioExperienceMap.indexOf('ABC.XV2') !== -1,
        r.session.conversioExperienceMap);
      check('nothing reached the client stream',
        !r.session.clientExperienceMap, r.session.clientExperienceMap);
    })();

    // Original and Control are the same segment; anything else outside the
    // convention leaves the code standing alone.
    [['Original', 'ABC.XCO'],
     ['Original | untouched', 'ABC.XCO'],
     ['Control', 'ABC.XCO'],
     ['Variation 1 | a', 'ABC.XV1'],
     ['Variation 10 | a', 'ABC.XV10'],
     ['Variation', 'ABC'],
     ['Some other name | a', 'ABC']].forEach(function (pair) {
      var r = call({ tests: tests('ABC | Homepage hero', pair[0]) });
      var p = payload(r);
      check("variation '" + pair[0] + "' gives segment " + pair[1],
        !!p && p.experience_segment === pair[1],
        p && p.experience_segment);
    });

    // The sampled path takes the code from the second name segment and marks
    // the result. Both the boolean and the string count as sampled.
    [true, 'true'].forEach(function (flag) {
      var r = call({
        sample: flag,
        tests: tests('Sample | ABC | Homepage hero', 'Variation 2 | blue button')
      });
      var p = payload(r);
      check('sample flag ' + JSON.stringify(flag) + ': code from the second segment, marked .S',
        !!p && p.experience_segment === 'ABC.XV2.S', JSON.stringify(p));
    });

    // Anything else reads as unsampled, so the code comes from the first
    // segment and nothing is marked.
    [false, 'false', undefined, null, 1, 'yes', {}].forEach(function (flag) {
      var r = call({
        sample: flag,
        tests: tests('ABC | Homepage hero', 'Original')
      });
      var p = payload(r);
      check('sample flag ' + JSON.stringify(flag) + ' reads as unsampled',
        !!p && p.experience_segment === 'ABC.XCO', p && p.experience_segment);
    });

    // A name that carries no code where the flag says to look is dropped: an
    // experience keyed on 'undefined' is worse than no experience at all.
    (function () {
      var r = call({ sample: true, tests: tests('ABC', 'Original') });
      check('sampled test whose name has no second segment is dropped',
        r.returned === false && r.pushed.length === 0,
        String(r.returned) + ' / ' + r.pushed.length);

      // The position is taken as given rather than sniffed: a sampled campaign
      // named with only two parts yields the test name as its code, which is
      // the convention being wrong rather than this function guessing at it.
      var twoPart = call({ sample: true, tests: tests('ABC | Homepage hero', 'Original') });
      var tp = payload(twoPart);
      check('sampled two-part name takes its second segment as the code',
        !!tp && tp.experience_segment === 'Homepage hero.XCO.S', JSON.stringify(tp));

      var empty = call({ tests: tests('', 'Original') });
      check('empty campaign name is dropped',
        empty.returned === false && empty.pushed.length === 0,
        String(empty.returned) + ' / ' + empty.pushed.length);
    })();

    // Misses and hostile inputs return false rather than throwing back into
    // whatever ran the line after the call.
    (function () {
      var unknown = call({ tests: tests('ABC | Homepage hero', 'Original'), testId: '99999' });
      check('an id with no campaign on the page returns false',
        unknown.returned === false && unknown.pushed.length === 0,
        String(unknown.returned) + ' / ' + unknown.pushed.length);

      var threw = call({ throws: true });
      check('a throwing getTestsOnPage returns false',
        threw.returned === false && threw.pushed.length === 0,
        String(threw.returned) + ' / ' + threw.pushed.length);

      var noTests = call({ tests: null });
      check('a null test set returns false',
        noTests.returned === false && noTests.pushed.length === 0,
        String(noTests.returned));

      var noNames = call({ tests: { '12345': { name: 'ABC | x' } } });
      check('a campaign with no variationName returns false',
        noNames.returned === false && noNames.pushed.length === 0,
        String(noNames.returned));

      var numericName = call({ tests: { '12345': { name: 12345, variationName: 'Original' } } });
      check('a non-string campaign name returns false',
        numericName.returned === false && numericName.pushed.length === 0,
        String(numericName.returned));
    })();

    // The tag never reads ABTasty until the call, so a page where it is absent
    // still loads and every other part of the tag still works.
    (function () {
      var r = tag(consented({}));
      check('the tag loads with no ABTasty on the page',
        dataEvents(r.dataLayer).length === 1, 'got ' + dataEvents(r.dataLayer).length);
      check('calling with no ABTasty returns false rather than throwing',
        r.window.conversioAbtastyTracking('12345') === false);
    })();

    // Called twice for the same test, as a test re-running its own script
    // would, the experience is de-duplicated by segment downstream.
    (function () {
      var r = tag(consented({}));
      r.window.ABTasty = {
        getTestsOnPage: function () {
          return tests('ABC | Homepage hero', 'Variation 2 | blue button');
        }
      };
      r.window.conversioAbtastyTracking('12345');
      r.window.conversioAbtastyTracking('12345');
      r.drain();

      var pushes = r.dataLayer.filter(function (e) { return e && e.event === 'conversio_experience'; });
      var emits = r.dataLayer.filter(function (e) { return e && e.event === 'conversio_experience_session'; });
      check('two calls push twice', pushes.length === 2, 'got ' + pushes.length);
      check('but emit one session, de-duplicated by segment',
        emits.length === 1, 'got ' + emits.length);
    })();

    // Before consent the push is held by the same gate as any other
    // experience, and arrives when consent does.
    (function () {
      var r = tag({ autoDrain: false });
      r.window.ABTasty = {
        getTestsOnPage: function () {
          return tests('ABC | Homepage hero', 'Original');
        }
      };
      check('pre-consent: the call still reports success',
        r.window.conversioAbtastyTracking('12345') === true);
      r.drain();
      check('pre-consent: nothing emitted',
        r.dataLayer.filter(function (e) { return e && e.event === 'conversio_experience_session'; }).length === 0);

      r.window.__conversioEnableEmission__();
      r.drain();
      check('post-consent: the held experience is emitted',
        r.dataLayer.filter(function (e) { return e && e.event === 'conversio_experience_session'; }).length === 1);
    })();
  })();

  // 26. conversioAbtastyTracking: which stream the experience is reported to
  //
  // The conversio_experience flag on the window chooses, and it reaches only the
  // event name and the payload key: the segment is derived before the stream is
  // consulted, so the same test reports the same segment either way.
  (function () {
    function tests(name, variationName) {
      return { '12345': { name: name, variationName: variationName } };
    }

    // Runs the tag, sets the flags a calling test would, and reports where the
    // experience landed.
    function route(opts) {
      opts = opts || {};
      var r = tag(consented({}));
      var before = r.dataLayer.length;

      r.window.ABTasty = {
        getTestsOnPage: function () {
          return tests('ABC | Homepage hero', 'Variation 2 | blue button');
        }
      };
      if ('stream' in opts) r.window.conversio_experience = opts.stream;
      if ('sample' in opts) r.window.conversio_sample = opts.sample;

      var returned = r.window.conversioAbtastyTracking('12345');
      r.drain();

      var fresh = r.dataLayer.slice(before);
      var pushed = fresh.filter(function (e) {
        return e && (e.event === 'conversio_experience' || e.event === 'client_experience');
      })[0];

      return {
        returned: returned,
        event: pushed && pushed.event,
        keys: pushed ? Object.keys(pushed).filter(function (k) {
          return k.indexOf('__') !== 0;
        }).sort() : [],
        marks: pushed ? Object.keys(pushed).filter(function (k) {
          return k.indexOf('__') === 0;
        }).sort() : [],
        payload: pushed && (pushed.conversio || pushed.client),
        emits: fresh.filter(function (e) {
          return e && (e.event === 'conversio_experience_session' ||
                       e.event === 'client_experience_session');
        }).map(function (e) { return e.event; }),
        session: r.session
      };
    }

    // Explicitly true, and every absent-or-not-false spelling, report to our own
    // stream. The absent case is the one that matters: a test written against
    // the helper before this flag existed must keep reporting where it did.
    [['flag absent', {}],
     ['flag true', { stream: true }],
     ['flag the string "true"', { stream: 'true' }],
     ['flag undefined', { stream: undefined }],
     ['flag null', { stream: null }],
     ['flag 0', { stream: 0 }],
     ['flag the empty string', { stream: '' }]].forEach(function (pair) {
      var r = route(pair[1]);
      check(pair[0] + ': pushes conversio_experience',
        r.event === 'conversio_experience', String(r.event));
      check(pair[0] + ': under the conversio payload key',
        JSON.stringify(r.keys) === JSON.stringify(['conversio', 'event']),
        JSON.stringify(r.keys));
      check(pair[0] + ': marked processed by our stream only',
        JSON.stringify(r.marks) === JSON.stringify(['__conversioExperienceRuntimeProcessed__']),
        JSON.stringify(r.marks));
      check(pair[0] + ': categorised Conversio Experience',
        r.payload && r.payload.experience_category === 'Conversio Experience',
        r.payload && r.payload.experience_category);
    });

    // Explicitly false, in either spelling, reports to the client's.
    [['flag false', { stream: false }],
     ['flag the string "false"', { stream: 'false' }]].forEach(function (pair) {
      var r = route(pair[1]);
      check(pair[0] + ': pushes client_experience',
        r.event === 'client_experience', String(r.event));
      check(pair[0] + ': under the client payload key',
        JSON.stringify(r.keys) === JSON.stringify(['client', 'event']),
        JSON.stringify(r.keys));
      check(pair[0] + ': and no conversio key alongside it',
        r.keys.indexOf('conversio') === -1, JSON.stringify(r.keys));
      check(pair[0] + ': marked processed by the client stream only',
        JSON.stringify(r.marks) === JSON.stringify(['__clientExperienceRuntimeProcessed__']),
        JSON.stringify(r.marks));
      check(pair[0] + ': categorised Client Experience',
        r.payload && r.payload.experience_category === 'Client Experience',
        r.payload && r.payload.experience_category);
    });

    // What the flag reaches is the envelope and the category, never the
    // derivation: strip the category and the two payloads are identical.
    (function () {
      var ours = route({ stream: true });
      var theirs = route({ stream: false });

      function withoutCategory(p) {
        var out = {};
        Object.keys(p).forEach(function (k) {
          if (k !== 'experience_category') out[k] = p[k];
        });
        return out;
      }

      check('the derived payload is identical across the two streams',
        JSON.stringify(withoutCategory(ours.payload)) ===
          JSON.stringify(withoutCategory(theirs.payload)),
        JSON.stringify(ours.payload) + ' vs ' + JSON.stringify(theirs.payload));
      check('and carries the derived segment either way',
        ours.payload.experience_segment === 'ABC.XV2' &&
          theirs.payload.experience_segment === 'ABC.XV2',
        JSON.stringify([ours.payload.experience_segment, theirs.payload.experience_segment]));

      // The one derived field that does differ, since a client experience
      // arriving in the client's own reporting should read as theirs.
      check('our stream is categorised Conversio Experience',
        ours.payload.experience_category === 'Conversio Experience',
        ours.payload.experience_category);
      check("the client's is categorised Client Experience",
        theirs.payload.experience_category === 'Client Experience',
        theirs.payload.experience_category);
    })();

    // Sampling composes with the routing rather than competing with it.
    (function () {
      var r = route({ stream: false, sample: true });
      check('a sampled client experience is marked .S like any other',
        r.payload && r.payload.experience_segment === 'Homepage hero.XV2.S',
        r.payload && r.payload.experience_segment);
    })();

    // From the push onwards it is that stream's own business: the matching
    // stream processes it, the other never sees it, and their storage is
    // separate as it is for any other experience.
    (function () {
      var ours = route({ stream: true });
      check('our stream emits the session event',
        JSON.stringify(ours.emits) === JSON.stringify(['conversio_experience_session']),
        JSON.stringify(ours.emits));
      check('and stores the segment in the Conversio map only',
        !!ours.session.conversioExperienceMap && !ours.session.clientExperienceMap,
        ours.session.conversioExperienceMap + ' / ' + ours.session.clientExperienceMap);

      var theirs = route({ stream: false });
      check('the client stream emits its own session event',
        JSON.stringify(theirs.emits) === JSON.stringify(['client_experience_session']),
        JSON.stringify(theirs.emits));
      check('and stores the segment in the client map only',
        !!theirs.session.clientExperienceMap && !theirs.session.conversioExperienceMap,
        theirs.session.clientExperienceMap + ' / ' + theirs.session.conversioExperienceMap);
    })();

    // A client experience carries no identity, as no client send does: the
    // helper cannot smuggle the conversio_id into the client's stream.
    (function () {
      var r = tag(consented({}));
      r.window.ABTasty = {
        getTestsOnPage: function () {
          return tests('ABC | Homepage hero', 'Original');
        }
      };
      r.window.conversio_experience = false;
      r.window.conversioAbtastyTracking('12345');
      r.drain();

      var emit = r.dataLayer.filter(function (e) {
        return e && e.event === 'client_experience_session';
      })[0];
      check('the client emit carries no conversio_id',
        !!emit && !('conversio_id' in emit.client), JSON.stringify(emit && emit.client));
      check('and no vitals',
        !!emit && !('conversio_vitals' in emit.client), JSON.stringify(emit && emit.client));
    })();

    // The same test reported to both streams is two experiences, not one
    // de-duplicated: the segment is shared but the storage is not.
    (function () {
      var r = tag(consented({}));
      r.window.ABTasty = {
        getTestsOnPage: function () {
          return tests('ABC | Homepage hero', 'Variation 2 | blue button');
        }
      };
      r.window.conversio_experience = true;
      r.window.conversioAbtastyTracking('12345');
      r.window.conversio_experience = false;
      r.window.conversioAbtastyTracking('12345');
      r.drain();

      var ours = r.dataLayer.filter(function (e) {
        return e && e.event === 'conversio_experience_session';
      });
      var theirs = r.dataLayer.filter(function (e) {
        return e && e.event === 'client_experience_session';
      });
      check('reported to both streams, each emits once',
        ours.length === 1 && theirs.length === 1,
        ours.length + ' / ' + theirs.length);
      check('and each stores the segment in its own map',
        r.session.conversioExperienceMap.indexOf('ABC.XV2') !== -1 &&
          r.session.clientExperienceMap.indexOf('ABC.XV2') !== -1,
        r.session.conversioExperienceMap + ' / ' + r.session.clientExperienceMap);
    })();

    // The helper pushes the snake_case name, but it is only one caller: a
    // container pushing either accepted name is unaffected by it existing, and
    // by the flag it reads. Section 20 covers the name pair itself; this is the
    // check that 2.6 left both alone.
    (function () {
      var r = tag(consented({}));
      r.window.conversio_experience = false;
      r.dataLayer.push({
        event: 'conversioExperience',
        conversio: {
          experience_segment: 'legacy-camel', experience_category: 'C',
          experience_action: 'A', experience_label: 'L'
        }
      });
      r.drain();
      check('a container pushing the camelCase name still reports to our stream',
        r.dataLayer.filter(function (e) {
          return e && e.event === 'conversio_experience_session';
        }).length === 1);
      check('and the AB Tasty stream flag does not divert it',
        !r.session.clientExperienceMap, r.session.clientExperienceMap);
    })();

    // A drop is a drop whichever stream was asked for: the guards run before
    // the stream is consulted, so nothing lands anywhere.
    (function () {
      var r = tag(consented({}));
      r.window.ABTasty = { getTestsOnPage: function () { return tests('ABC', 'Original'); } };
      r.window.conversio_experience = false;
      r.window.conversio_sample = true;

      check('a dropped call reports false with the client stream selected',
        r.window.conversioAbtastyTracking('12345') === false);
      r.drain();
      check('and pushes nothing to either stream',
        r.dataLayer.filter(function (e) {
          return e && (e.event === 'client_experience' || e.event === 'conversio_experience');
        }).length === 0);
    })();
  })();


  // 27. Legacy camelCase payload fields
  //
  // Each of the four fields a payload carries now answers to two names: the
  // snake_case one this tag has always read, and the camelCase one legacy
  // campaigns push, nested under the same payload key. What this section pins
  // is that the two spellings are the same push. Same segment, same storage,
  // same emit, same GA4 parameters, and no camelCase name anywhere on the way
  // back out, so a client's downstream tags keep reading the one spelling they
  // read today.
  (function () {
    var GA_ID = 'G-J4EDMZMNY9';

    var EXPERIENCE_MAP = [
      ['experienceSegment',  'experience_segment'],
      ['experienceCategory', 'experience_category'],
      ['experienceAction',   'experience_action'],
      ['experienceLabel',    'experience_label']
    ];

    var EVENT_MAP = [
      ['eventSegment',  'event_segment'],
      ['eventCategory', 'event_category'],
      ['eventAction',   'event_action'],
      ['eventLabel',    'event_label']
    ];

    function gaRun(opts) {
      opts = consented(opts || {});
      opts.gtag = 'spy';
      return tagWithTrackingId(GA_ID, opts);
    }

    function emitsOf(r, name) {
      return r.dataLayer.filter(function (e) { return e && e.event === name; });
    }

    // The conversio_id is minted per run and the vitals are measured per run,
    // so neither can be compared across two of them. Everything else in the
    // parameters is derived from the payload, which is the point of comparing.
    function croParams(r) {
      var call = r.gtagCalls.filter(function (c) { return c.name === 'conversio_cro'; })[0];
      var out;
      if (!call) return null;
      out = Object.assign({}, call.params);
      delete out.conversio_id;
      delete out.conversio_vitals;
      return out;
    }

    function pushTo(r, event, key, payload) {
      var item = { event: event };
      item[key] = payload;
      r.window.dataLayer.push(item);
      r.drain();
      return r;
    }

    // --- the mapping, one field at a time --------------------------------
    //
    // The payload is canonical except for the single field under test, which is
    // pushed under its legacy name alone. The value is one nothing else on the
    // payload carries, so a value arriving under the canonical name downstream
    // can only have come from the legacy key it was written to.
    EXPERIENCE_MAP.forEach(function (pair) {
      var legacy = pair[0];
      var canonical = pair[1];
      var payload = {
        experience_segment:  'seg-' + legacy,
        experience_category: 'canonical-cat',
        experience_action:   'canonical-act',
        experience_label:    'canonical-lab'
      };
      var emit;

      delete payload[canonical];
      payload[legacy] = 'legacy-value';

      emit = emitsOf(pushTo(gaRun({}), 'conversioExperience', 'conversio', payload),
        'conversio_experience_session')[0];

      check(legacy + ' is read as ' + canonical,
        !!emit && emit.conversio[canonical] === 'legacy-value',
        emit && JSON.stringify(emit.conversio));
      check(legacy + ': the emit carries no camelCase key of its own',
        !!emit && !(legacy in emit.conversio),
        emit && JSON.stringify(emit.conversio));
    });

    EVENT_MAP.forEach(function (pair) {
      var legacy = pair[0];
      var canonical = pair[1];
      var payload = {
        event_segment:  'seg-' + legacy,
        event_category: 'canonical-cat',
        event_action:   'canonical-act',
        event_label:    'canonical-lab'
      };
      var emit;

      delete payload[canonical];
      payload[legacy] = 'legacy-value';

      emit = emitsOf(pushTo(gaRun({}), 'conversioEvent', 'conversio', payload),
        'conversio_event_instance')[0];

      check(legacy + ' is read as ' + canonical,
        !!emit && emit.conversio[canonical] === 'legacy-value',
        emit && JSON.stringify(emit.conversio));
      check(legacy + ': the emit carries no camelCase key of its own',
        !!emit && !(legacy in emit.conversio),
        emit && JSON.stringify(emit.conversio));
    });

    // --- a wholly legacy push is the push it replaces ---------------------
    //
    // Field by field above; here the whole payload at once, asserted against
    // the snake_case push it stands in for rather than against a literal. What
    // makes this the load-bearing check of the section is that it compares
    // every channel the payload reaches: the dataLayer emit, the GA4
    // parameters and the stored map.
    (function () {
      var snake = pushTo(gaRun({}), 'conversioExperience', 'conversio', {
        experience_segment:  'hero-v2',
        experience_category: 'Homepage',
        experience_action:   'Hero test',
        experience_label:    'Variant B'
      });
      var camel = pushTo(gaRun({}), 'conversioExperience', 'conversio', {
        experienceSegment:  'hero-v2',
        experienceCategory: 'Homepage',
        experienceAction:   'Hero test',
        experienceLabel:    'Variant B'
      });

      check('a wholly camelCase experience emits what the snake_case one emits',
        JSON.stringify(emitsOf(camel, 'conversio_experience_session')[0]) ===
          JSON.stringify(emitsOf(snake, 'conversio_experience_session')[0]),
        JSON.stringify(emitsOf(camel, 'conversio_experience_session')[0]));

      check('and sends GA4 the same parameters',
        JSON.stringify(croParams(camel)) === JSON.stringify(croParams(snake)),
        JSON.stringify(croParams(camel)));

      check('and stores the same experience map',
        camel.session.conversioExperienceMap === snake.session.conversioExperienceMap,
        String(camel.session.conversioExperienceMap));

      check('and the same experience list',
        camel.session.conversioExperienceList === snake.session.conversioExperienceList,
        String(camel.session.conversioExperienceList));
    })();

    (function () {
      var snake = pushTo(gaRun({}), 'conversioEvent', 'conversio', {
        event_segment:  'newsletter-signup',
        event_category: 'Newsletter',
        event_action:   'Signup',
        event_label:    'Footer form'
      });
      var camel = pushTo(gaRun({}), 'conversioEvent', 'conversio', {
        eventSegment:  'newsletter-signup',
        eventCategory: 'Newsletter',
        eventAction:   'Signup',
        eventLabel:    'Footer form'
      });

      check('a wholly camelCase event emits what the snake_case one emits',
        JSON.stringify(emitsOf(camel, 'conversio_event_instance')[0]) ===
          JSON.stringify(emitsOf(snake, 'conversio_event_instance')[0]),
        JSON.stringify(emitsOf(camel, 'conversio_event_instance')[0]));

      check('and sends GA4 the same parameters',
        JSON.stringify(croParams(camel)) === JSON.stringify(croParams(snake)),
        JSON.stringify(croParams(camel)));

      check('and the same event list',
        camel.session.conversioEventList === snake.session.conversioEventList,
        String(camel.session.conversioEventList));
    })();

    // --- precedence -------------------------------------------------------
    //
    // A payload carrying both spellings of one field is a container mid-move or
    // a mistake, and either way it needs a defined answer. The canonical name
    // wins wherever it carries a value, which is the same fallback the rest of
    // the tag writes as `payload.experience_category || ''`: the legacy name is
    // read where the canonical one is absent, and where it is present but
    // empty, since an empty string reaches the emit as nothing either way.
    (function () {
      var p = emitsOf(pushTo(gaRun({}), 'conversioExperience', 'conversio', {
        experience_segment:  'precedence',
        experience_category: 'canonical-cat',
        experienceCategory:  'legacy-cat',
        experience_action:   '',
        experienceAction:    'legacy-act',
        experienceLabel:     'legacy-lab'
      }), 'conversio_experience_session')[0].conversio;

      check('the canonical name wins where it carries a value',
        p.experience_category === 'canonical-cat', p.experience_category);
      check('the legacy name is read where the canonical one is empty',
        p.experience_action === 'legacy-act', p.experience_action);
      check('and where the canonical one is absent entirely',
        p.experience_label === 'legacy-lab', p.experience_label);
      check('a mixed payload still reports one whole experience',
        p.experience_segment === 'precedence', p.experience_segment);
    })();

    // --- the two spellings are one experience -----------------------------
    //
    // De-duplication is by segment, and the segment is normalised before the
    // map is consulted, so a container pushing one occurrence under each
    // spelling costs one emit rather than reporting the same test twice.
    (function () {
      var r = gaRun({});

      pushTo(r, 'conversioExperience', 'conversio', {
        experience_segment: 'dedupe-me', experience_category: 'c',
        experience_action: 'a', experience_label: 'l'
      });
      pushTo(r, 'conversioExperience', 'conversio', {
        experienceSegment: 'dedupe-me', experienceCategory: 'c',
        experienceAction: 'a', experienceLabel: 'l'
      });

      check('the same segment under either spelling is one experience',
        emitsOf(r, 'conversio_experience_session').length === 1,
        'got ' + emitsOf(r, 'conversio_experience_session').length);
      check('and one entry in the experience list',
        r.session.conversioExperienceList === JSON.stringify(['dedupe-me']),
        String(r.session.conversioExperienceList));
    })();

    // --- storage holds the canonical names --------------------------------
    //
    // Normalisation happens where the item is first read, so what goes into
    // storage is already canonical and a payload restored on a later page needs
    // no second pass. Asserting on the stored string rather than only on the
    // emit is what pins that: a tag that normalised on the way out instead
    // would pass every check above and fail these two.
    (function () {
      var r = tag({});

      pushTo(r, 'conversioEvent', 'conversio', {
        eventSegment: 'buffered', eventCategory: 'bc',
        eventAction: 'ba', eventLabel: 'bl'
      });

      check('a legacy event pushed before consent emits nothing',
        emitsOf(r, 'conversio_event_instance').length === 0,
        'got ' + emitsOf(r, 'conversio_event_instance').length);
      check('and is buffered under the canonical names',
        String(r.session.conversioEventBuffer).indexOf('"event_segment"') !== -1,
        String(r.session.conversioEventBuffer));
      check('with no camelCase name in the buffer',
        String(r.session.conversioEventBuffer).indexOf('eventSegment') === -1,
        String(r.session.conversioEventBuffer));

      r.window.__conversioEnableEmission__();
      r.drain();

      check('post-consent the buffered event emits with the mapped names',
        !!emitsOf(r, 'conversio_event_instance')[0] &&
          emitsOf(r, 'conversio_event_instance')[0].conversio.event_segment === 'buffered' &&
          emitsOf(r, 'conversio_event_instance')[0].conversio.event_action === 'ba',
        JSON.stringify(emitsOf(r, 'conversio_event_instance')[0]));
    })();

    (function () {
      var r = tag({});

      pushTo(r, 'conversioExperience', 'conversio', {
        experienceSegment: 'held', experienceCategory: 'hc',
        experienceAction: 'ha', experienceLabel: 'hl'
      });

      check('a legacy experience pushed before consent is mapped into the map',
        String(r.session.conversioExperienceMap).indexOf('"experience_action":"ha"') !== -1,
        String(r.session.conversioExperienceMap));
      check('with no camelCase name in the map',
        String(r.session.conversioExperienceMap).indexOf('experienceAction') === -1,
        String(r.session.conversioExperienceMap));

      r.window.__conversioEnableEmission__();
      r.drain();

      check('post-consent it is flushed from storage with the mapped names',
        !!emitsOf(r, 'conversio_experience_session')[0] &&
          emitsOf(r, 'conversio_experience_session')[0].conversio.experience_action === 'ha',
        JSON.stringify(emitsOf(r, 'conversio_experience_session')[0]));
    })();

    // --- the client stream reads them too ---------------------------------
    //
    // Nothing has ever pushed camelCase at the client stream, which is new. It
    // normalises anyway, both streams being one code path taking a descriptor,
    // and the check is here so that stays true rather than being quietly
    // special-cased later.
    (function () {
      var r = pushTo(gaRun({}), 'client_experience', 'client', {
        experienceSegment: 'client-legacy', experienceCategory: 'cc',
        experienceAction: 'ca', experienceLabel: 'cl'
      });
      var emit = emitsOf(r, 'client_experience_session')[0];

      check('the client stream reads the legacy names as well',
        !!emit && emit.client.experience_segment === 'client-legacy' &&
          emit.client.experience_action === 'ca',
        emit && JSON.stringify(emit.client));
      check('and our own stream reports nothing for it',
        emitsOf(r, 'conversio_experience_session').length === 0,
        'got ' + emitsOf(r, 'conversio_experience_session').length);
      check('and our own storage is untouched',
        !r.session.conversioExperienceMap, String(r.session.conversioExperienceMap));
    })();

    (function () {
      var emit = emitsOf(pushTo(gaRun({}), 'client_event', 'client', {
        eventSegment: 'client-evt', eventCategory: 'ec',
        eventAction: 'ea', eventLabel: 'el'
      }), 'client_event_instance')[0];

      check('and the client stream reads the legacy event names',
        !!emit && emit.client.event_segment === 'client-evt' &&
          emit.client.event_label === 'el',
        emit && JSON.stringify(emit.client));
    })();

    // --- what is still dropped --------------------------------------------
    //
    // The segment decides whether an experience is reported at all, so learning
    // a second name for it must not turn a payload that was dropped into one
    // that is reported under a segment nobody can read.
    (function () {
      var noSeg = pushTo(gaRun({}), 'conversioExperience', 'conversio', {
        experienceCategory: 'c', experienceAction: 'a', experienceLabel: 'l'
      });
      check('a legacy payload carrying no segment at all is dropped',
        emitsOf(noSeg, 'conversio_experience_session').length === 0,
        'got ' + emitsOf(noSeg, 'conversio_experience_session').length);

      var emptySeg = pushTo(gaRun({}), 'conversioExperience', 'conversio', {
        experienceSegment: '', experienceCategory: 'c',
        experienceAction: 'a', experienceLabel: 'l'
      });
      check('an empty legacy segment is dropped',
        emitsOf(emptySeg, 'conversio_experience_session').length === 0,
        'got ' + emitsOf(emptySeg, 'conversio_experience_session').length);

      var badSeg = pushTo(gaRun({}), 'conversioExperience', 'conversio', {
        experienceSegment: 12345, experienceCategory: 'c',
        experienceAction: 'a', experienceLabel: 'l'
      });
      check('a legacy segment that is not a string is dropped',
        emitsOf(badSeg, 'conversio_experience_session').length === 0,
        'got ' + emitsOf(badSeg, 'conversio_experience_session').length);

      var bothEmpty = pushTo(gaRun({}), 'conversioExperience', 'conversio', {
        experience_segment: '', experienceSegment: '', experienceAction: 'a'
      });
      check('and neither spelling carrying a segment is dropped',
        emitsOf(bothEmpty, 'conversio_experience_session').length === 0,
        'got ' + emitsOf(bothEmpty, 'conversio_experience_session').length);
    })();

    // --- exactly four names, and no others --------------------------------
    //
    // The legacy names are a fixed list rather than a camelCase-to-snake_case
    // rule applied to whatever a payload happens to carry, so a key outside the
    // four reaches nothing and the emit is the same four fields it always was.
    (function () {
      var p = emitsOf(pushTo(gaRun({}), 'conversioExperience', 'conversio', {
        experience_segment: 'only-four',
        experienceValue:    'ignored',
        experience_Action:  'ignored too',
        experienceactionn:  'ignored as well'
      }), 'conversio_experience_session')[0].conversio;

      check('the emit carries exactly the four canonical fields',
        JSON.stringify(Object.keys(p).sort()) === JSON.stringify([
          'experience_action', 'experience_category',
          'experience_label', 'experience_segment'
        ]), JSON.stringify(Object.keys(p).sort()));
      check('a key outside the four is not read into any of them',
        p.experience_action === '' && p.experience_category === '' &&
          p.experience_label === '',
        JSON.stringify(p));
    })();
  })();

  // 28. The AB Tasty queue
  //
  // A test snippet cannot call a function that does not exist yet, and AB Tasty
  // runs early by design while this tag arrives through a container that is
  // typically async, so a snippet guarding the call with a typeof check reports
  // nothing at all on the loads where it loses that race. The queue inverts it:
  // a test pushes to an array, and this tag drains that array at init and then
  // replaces it with something whose push reports immediately.
  //
  // What the section pins is that neither order can lose, and that a queued
  // item's flags travel with the item. That second one is a correctness
  // requirement rather than a preference, and the reason the two entry points
  // differ at all: an item may sit until init, and two items queued before the
  // tag arrives must not both read whatever the window happened to hold when
  // the drain finally ran.
  (function () {
    var CAMPAIGNS =
      "window.ABTasty = { getTestsOnPage: function () { return {" +
      "'1577840': { name: 'HP Hero', variationName: 'Variation 2 | blue' }," +
      "'999': { name: 'Other', variationName: 'Original' }," +
      "'777': { name: 'ABC | XYZ | Sampled', variationName: 'Variation 3 | x' }" +
      "}; } };";

    var PUSH = '(window.conversioAbtastyQueue = window.conversioAbtastyQueue || []).push';

    // Runs the tag with `pre` executing BEFORE it, which is the losing order
    // for a direct call and the one the queue exists to survive.
    function queued(pre, opts) {
      opts = consented(opts || {});
      opts.tagPath = tagPath;
      opts.tagSource = CAMPAIGNS + '\n' + (pre || '') + '\n' + source;
      return runTag(opts);
    }

    function segsOf(r, event) {
      return r.dataLayer.filter(function (e) { return e && e.event === event; })
        .map(function (e) { return (e.conversio || e.client).experience_segment; });
    }

    function ours(r) { return segsOf(r, 'conversio_experience_session'); }
    function theirs(r) { return segsOf(r, 'client_experience_session'); }

    function drained(r) { r.drain(); return r; }

    // Pushes onto the live queue the tag installs. Returns false rather than
    // throwing when there is no queue, so this suite run against a build
    // without one reports failed checks instead of a stack trace.
    function pushLive(r, item) {
      var q = r.window.conversioAbtastyQueue;
      if (!q || typeof q.push !== 'function') return false;
      q.push(item);
      return true;
    }

    // --- neither order loses ---------------------------------------------
    (function () {
      var before = drained(queued(PUSH + "({ testId: '1577840' });"));
      check('an item queued before the tag loads is reported',
        JSON.stringify(ours(before)) === JSON.stringify(['HP Hero.XV2']),
        JSON.stringify(ours(before)));

      var after = queued('');
      pushLive(after, { testId: '1577840' });
      drained(after);
      check('and an item pushed after the tag has loaded is reported',
        JSON.stringify(ours(after)) === JSON.stringify(['HP Hero.XV2']),
        JSON.stringify(ours(after)));

      check('the queue is a live pusher once the tag has drained it',
        !!after.window.conversioAbtastyQueue &&
          typeof after.window.conversioAbtastyQueue.push === 'function' &&
          typeof after.window.conversioAbtastyQueue.length === 'undefined',
        typeof after.window.conversioAbtastyQueue);
    })();

    // The same one-line snippet, unchanged, either side of the tag. This is
    // the whole point of the arrangement, so it is asserted as one check
    // rather than inferred from the two above.
    (function () {
      var SNIPPET = PUSH + "({ testId: '1577840', experience: false });";
      var early = drained(queued(SNIPPET));
      var late = queued('');
      pushLive(late, { testId: '1577840', experience: false });
      drained(late);
      check('one snippet reports identically whichever side of the tag it runs',
        JSON.stringify(theirs(early)) === JSON.stringify(theirs(late)) &&
          JSON.stringify(theirs(early)) === JSON.stringify(['HP Hero.XV2']),
        JSON.stringify(theirs(early)) + ' vs ' + JSON.stringify(theirs(late)));
    })();

    // --- the item shapes --------------------------------------------------
    (function () {
      var bare = drained(queued(PUSH + "('1577840');"));
      check('a bare string id is the shorthand for both defaults',
        JSON.stringify(ours(bare)) === JSON.stringify(['HP Hero.XV2']) &&
          theirs(bare).length === 0,
        JSON.stringify(ours(bare)));

      var num = drained(queued(PUSH + '(1577840);'));
      check('a numeric id is accepted as the same shorthand',
        JSON.stringify(ours(num)) === JSON.stringify(['HP Hero.XV2']),
        JSON.stringify(ours(num)));

      var numProp = drained(queued(PUSH + '({ testId: 1577840 });'));
      check('and a numeric testId on an object is too',
        JSON.stringify(ours(numProp)) === JSON.stringify(['HP Hero.XV2']),
        JSON.stringify(ours(numProp)));
    })();

    // --- the flags, in both spellings and by default ----------------------
    (function () {
      [['experience absent', '{ testId: \'1577840\' }'],
       ['experience true', '{ testId: \'1577840\', experience: true }'],
       ['experience the string "true"', '{ testId: \'1577840\', experience: \'true\' }'],
       ['experience null', '{ testId: \'1577840\', experience: null }']
      ].forEach(function (pair) {
        var r = drained(queued(PUSH + '(' + pair[1] + ');'));
        check(pair[0] + ': reports to the Conversio stream',
          JSON.stringify(ours(r)) === JSON.stringify(['HP Hero.XV2']) && theirs(r).length === 0,
          JSON.stringify(ours(r)) + '/' + JSON.stringify(theirs(r)));
      });

      [['experience false', '{ testId: \'1577840\', experience: false }'],
       ['experience the string "false"', '{ testId: \'1577840\', experience: \'false\' }']
      ].forEach(function (pair) {
        var r = drained(queued(PUSH + '(' + pair[1] + ');'));
        check(pair[0] + ': reports to the client stream',
          JSON.stringify(theirs(r)) === JSON.stringify(['HP Hero.XV2']) && ours(r).length === 0,
          JSON.stringify(ours(r)) + '/' + JSON.stringify(theirs(r)));
      });

      // Sampled takes its code from the second name segment, so the campaign
      // pinned here is the three-part one the convention requires.
      [['sample true', 'true'], ['sample the string "true"', "'true'"]].forEach(function (pair) {
        var r = drained(queued(PUSH + "({ testId: '777', sample: " + pair[1] + ' });'));
        check(pair[0] + ': marks the segment sampled',
          JSON.stringify(ours(r)) === JSON.stringify(['XYZ.XV3.S']),
          JSON.stringify(ours(r)));
      });

      var unsampled = drained(queued(PUSH + "({ testId: '777' });"));
      check('sample absent: the segment is not marked',
        JSON.stringify(unsampled.dataLayer.filter(function (e) {
          return e && e.event === 'conversio_experience_session';
        }).map(function (e) { return e.conversio.experience_segment; })) ===
          JSON.stringify(['ABC.XV3']),
        JSON.stringify(ours(unsampled)));
    })();

    // --- the flags travel with the item -----------------------------------
    //
    // The reason the queued entry point does not read the window. Two items
    // queued before the tag arrives are drained in one pass, so a window read
    // would give both of them the same answer: whatever the second test set.
    (function () {
      var r = drained(queued(
        PUSH + "({ testId: '1577840', experience: true });" +
        PUSH + "({ testId: '999', experience: false });"
      ));
      check('two items drained together each keep their own stream',
        JSON.stringify(ours(r)) === JSON.stringify(['HP Hero.XV2']) &&
          JSON.stringify(theirs(r)) === JSON.stringify(['Other.XCO']),
        JSON.stringify(ours(r)) + ' / ' + JSON.stringify(theirs(r)));

      // And the window flags have no bearing on a queued item at all, which is
      // what stops a stray global from diverting one.
      var hostile = queued(
        'window.conversio_experience = false; window.conversio_sample = true;' +
        PUSH + "({ testId: '1577840' });"
      );
      drained(hostile);
      check('a window flag does not divert a queued item',
        JSON.stringify(ours(hostile)) === JSON.stringify(['HP Hero.XV2']) &&
          theirs(hostile).length === 0,
        JSON.stringify(ours(hostile)) + ' / ' + JSON.stringify(theirs(hostile)));
    })();

    // --- order, de-duplication and the consent gate -----------------------
    (function () {
      var ordered = drained(queued(
        PUSH + "({ testId: '1577840' });" + PUSH + "({ testId: '999' });"
      ));
      check('queued items are reported in the order they were pushed',
        JSON.stringify(ours(ordered)) === JSON.stringify(['HP Hero.XV2', 'Other.XCO']),
        JSON.stringify(ours(ordered)));

      var twice = drained(queued(
        PUSH + "({ testId: '1577840' });" + PUSH + "({ testId: '1577840' });"
      ));
      check('one test queued twice is de-duplicated to one experience',
        JSON.stringify(ours(twice)) === JSON.stringify(['HP Hero.XV2']),
        JSON.stringify(ours(twice)));

      // Nothing about the queue escapes the consent gate: it is an ordinary
      // experience from the push onwards, exactly as a direct call is.
      var gated = queued(PUSH + "({ testId: '1577840' });", { emissionEnabled: false });
      gated.session.conversioEmissionEnabled = 'false';
      gated.session.clientEmissionEnabled = 'false';
      var preConsent = runTag({
        tagPath: tagPath,
        tagSource: CAMPAIGNS + '\n' + PUSH + "({ testId: '1577840' });" + '\n' + source
      });
      preConsent.drain();
      check('a queued item is held by the consent gate',
        ours(preConsent).length === 0, JSON.stringify(ours(preConsent)));
      preConsent.window.__conversioEnableEmission__();
      preConsent.drain();
      check('and reported once consent arrives',
        JSON.stringify(ours(preConsent)) === JSON.stringify(['HP Hero.XV2']),
        JSON.stringify(ours(preConsent)));
    })();

    // --- what a bad queue must not do -------------------------------------
    //
    // The queue is a structure client code built, so init has to survive
    // whatever is in it, and one test snippet pushing something malformed must
    // not cost every other test on the page its experience.
    (function () {
      var mixed = drained(queued(
        PUSH + '(null);' + PUSH + '(undefined);' + PUSH + '({});' +
        PUSH + "({ testId: '' });" + PUSH + '({ testId: 12345 });' +
        PUSH + "({ testId: '1577840' });"
      ));
      check('a bad item is stepped over rather than ending the drain',
        JSON.stringify(ours(mixed)) === JSON.stringify(['HP Hero.XV2']),
        JSON.stringify(ours(mixed)));

      // An id that is a string but matches no campaign on the page is the
      // ordinary miss the direct call already returns false for.
      var miss = drained(queued(PUSH + "({ testId: 'not-a-campaign' });"));
      check('an id matching no campaign reports nothing',
        ours(miss).length === 0 && theirs(miss).length === 0,
        JSON.stringify(ours(miss)));

      [['a string', "window.conversioAbtastyQueue = 'nope';"],
       ['a number', 'window.conversioAbtastyQueue = 42;'],
       ['an object', 'window.conversioAbtastyQueue = { push: 1 };'],
       ['a throwing getter',
        "Object.defineProperty(window, 'conversioAbtastyQueue', " +
        '{ configurable: true, get: function () { throw new Error("x"); } });']
      ].forEach(function (pair) {
        var r = queued(pair[1]);
        r.drain();
        check('the tag still loads with the queue set to ' + pair[0],
          r.window.__CONVERSIO_RUNTIME_INIT__ === true,
          String(r.window.__CONVERSIO_RUNTIME_INIT__));
        check('and still fires conversio_data with the queue set to ' + pair[0],
          dataEvents(r.dataLayer).length === 1,
          'got ' + dataEvents(r.dataLayer).length);
      });
    })();

    // --- the direct entry point is untouched ------------------------------
    //
    // The queue exists alongside conversioAbtastyTracking, not instead of it,
    // so a test already calling the function by name keeps working: same
    // argument, same flags off the window, same return.
    (function () {
      var r = queued('');
      r.window.conversio_sample = false;
      r.window.conversio_experience = true;
      var returned = r.window.conversioAbtastyTracking('1577840');
      drained(r);
      check('the direct call still reports and still returns true',
        returned === true &&
          JSON.stringify(ours(r)) === JSON.stringify(['HP Hero.XV2']),
        String(returned) + ' ' + JSON.stringify(ours(r)));

      var client = queued('');
      client.window.conversio_experience = false;
      client.window.conversioAbtastyTracking('1577840');
      drained(client);
      check('and still reads its stream flag off the window',
        JSON.stringify(theirs(client)) === JSON.stringify(['HP Hero.XV2']),
        JSON.stringify(theirs(client)));

      var missed = queued('');
      check('and still returns false for an id with no campaign',
        missed.window.conversioAbtastyTracking('not-a-campaign') === false);
    })();
  })();

  // 29. The consent queue
  //
  // The one thing 2.6.3 adds, and the same argument section 28 makes for the AB
  // Tasty queue: a consent platform cannot call a function that does not exist
  // yet. The gate controls are assigned when this script executes, and the
  // loader delivers it through a container rather than inline, so a CMP that
  // resolves already-stored consent early in the page loses that race as the
  // ordinary case. What made it worth fixing rather than documenting is the
  // failure mode: a missed grant is not an error anywhere, it is a session that
  // emits nothing while the loader serves a clean 200 throughout.
  //
  // The gate starts shut in every check here. consented() is deliberately not
  // used: it pre-opens both keys, which is the one state that would make a
  // queue that does nothing at all look like it worked.
  (function () {
    var PUSH = '(window.conversioConsentQueue = window.conversioConsentQueue || []).push';
    var patched = source.split(TRACKING_SLOT).join('G-J4EDMZMNY9');

    // Runs the tag with `pre` executing BEFORE it, which is the losing order
    // for a direct call on the control and the one the queue exists to survive.
    function queued(pre, opts) {
      opts = opts || {};
      opts.tagPath = tagPath;
      opts.tagSource = (pre || '') + '\n' + patched;
      if (!('cwv' in opts)) opts.cwv = 'ok';
      return runTag(opts);
    }

    function gate(r) { return r.session.conversioEmissionEnabled; }
    function clientGate(r) { return r.session.clientEmissionEnabled; }

    // Pushes onto the live queue the tag installs. Returns false rather than
    // throwing when there is no queue, so this suite run against a build
    // without one reports failed checks instead of a stack trace.
    function pushLive(r, item) {
      var q = r.window.conversioConsentQueue;
      if (!q || typeof q.push !== 'function') return false;
      return q.push(item);
    }

    // Both orders, which is the whole point of the arrangement.
    check('a grant queued before the tag opens the gate',
      gate(queued(PUSH + "('enable');")) === 'true', String(gate(queued(PUSH + "('enable');"))));
    check('and opens the client stream with it',
      clientGate(queued(PUSH + "('enable');")) === 'true');
    check('a grant pushed after init opens the gate',
      (function () { var r = queued(''); pushLive(r, 'enable'); return gate(r) === 'true'; })());
    check('the same one-line snippet therefore works either side of the tag',
      gate(queued(PUSH + "('enable');")) === (function () { var r = queued(''); pushLive(r, 'enable'); return gate(r); })());

    // With nothing queued the tag must not open anything by itself.
    check('nothing queued leaves the gate untouched',
      gate(queued('')) === undefined, String(gate(queued(''))));
    check('nothing queued leaves the client gate untouched',
      clientGate(queued('')) === undefined);

    // The vocabulary. A GTM variable holding a consent state is as likely to
    // resolve to a boolean as to a word, so both read the same way.
    ['enable', 'enabled', 'grant', 'granted'].forEach(function (word) {
      check("'" + word + "' is a grant", gate(queued(PUSH + "('" + word + "');")) === 'true');
    });
    ['disable', 'disabled', 'deny', 'denied'].forEach(function (word) {
      check("'" + word + "' is a withdrawal",
        gate(queued(PUSH + "('enable');" + PUSH + "('" + word + "');")) === 'false');
    });
    check('true is a grant', gate(queued(PUSH + '(true);')) === 'true');
    check('false is a withdrawal', gate(queued(PUSH + "('enable');" + PUSH + '(false);')) === 'false');
    check('the words are case-insensitive, as a GTM variable is not case-stable',
      gate(queued(PUSH + "('GRANTED');")) === 'true');
    check('and mixed case reads the same',
      gate(queued(PUSH + "('Enable');")) === 'true');

    // The privacy check, and the reason there is no default branch: the only
    // useful default would be a grant, and a queue reading a typo as consent is
    // worse than one ignoring it.
    ['yes', 'yes-please', 'true', 'accept', 'allow', 'on', '1', ''].forEach(function (word) {
      check("'" + word + "' is not read as a grant",
        gate(queued(PUSH + "('" + word + "');")) === undefined, String(gate(queued(PUSH + "('" + word + "');"))));
    });
    [1, 0, '{}', 'null'].forEach(function (lit) {
      check('a ' + lit + ' literal is not read as a grant',
        gate(queued(PUSH + '(' + lit + ');')) === undefined);
    });
    check('an unrecognised command reports false rather than throwing',
      pushLive(queued(''), 'yes-please') === false);
    check('a recognised command reports true',
      pushLive(queued(''), 'enable') === true);

    // Order, which decides what a platform that changes its mind lands on.
    check('a grant then a withdrawal lands on the withdrawal',
      gate(queued(PUSH + "('enable');" + PUSH + "('deny');")) === 'false');
    check('a withdrawal then a grant lands on the grant',
      gate(queued(PUSH + "('deny');" + PUSH + "('enable');")) === 'true');
    check('a withdrawal alone writes the shut state rather than leaving it unset',
      gate(queued(PUSH + "('deny');")) === 'false');

    // One bad item is not the rest of them.
    check('a malformed item is stepped over and the good one behind it still applies',
      gate(queued(PUSH + '({});' + PUSH + "('enable');")) === 'true');
    check('and a malformed item ahead of a withdrawal does not cost it either',
      gate(queued(PUSH + '(function () {});' + PUSH + "('deny');")) === 'false');
    check('several malformed items do not end the drain',
      gate(queued(PUSH + '(null);' + PUSH + '(undefined);' + PUSH + '([]);' + PUSH + "('enable');")) === 'true');

    // The queue is a structure client code built, so whatever is in there, the
    // tag still initialises. Four hostile values, none of which is an array.
    ['"nope"', '42', '{ push: 1 }', 'Object.create(null)'].forEach(function (val) {
      var r = queued('window.conversioConsentQueue = ' + val + ';');
      check('a queue set to ' + val + ' still leaves the tag initialised',
        typeof r.window.__conversioEnableEmission__ === 'function');
      check('a queue set to ' + val + ' opens nothing',
        gate(r) === undefined);
    });
    check('a queue whose getter throws still leaves the tag initialised',
      (function () {
        var r = queued('Object.defineProperty(window, "conversioConsentQueue", ' +
          '{ configurable: true, get: function () { throw new Error("blocked"); } });');
        return typeof r.window.__conversioEnableEmission__ === 'function';
      })());

    // The drain runs after the settings and before any dataLayer processing, so
    // an experience already on the dataLayer emits on this page rather than
    // going into the buffer and straight back out of it.
    (function () {
      var r = queued(PUSH + "('enable');", {
        dataLayerInitial: [{
          event: 'conversio_experience',
          conversio: {
            experience_segment: 'homepage-hero-v2',
            experience_category: 'cat', experience_action: 'act', experience_label: 'lab'
          }
        }]
      });
      var emits = r.dataLayer.filter(function (e) { return e && e.event === 'conversio_experience_session'; });
      check('an experience already on the dataLayer emits under a queued grant',
        emits.length === 1, JSON.stringify(emits.length));
      check('and the tracking ID is on the window before any of it runs',
        r.window.conversioSettings.trackingId === 'G-J4EDMZMNY9');
    })();

    // flush moves nothing, which is what makes it safe for a platform that
    // re-signals an already-granted consent on every page.
    (function () {
      var r = queued(PUSH + "('flush');");
      check('flush alone does not open the gate', gate(r) === undefined, String(gate(r)));
      var after = queued(PUSH + "('enable');" + PUSH + "('flush');");
      check('flush after a grant leaves the gate open', gate(after) === 'true');
      check('flush reports true, being a recognised command',
        pushLive(queued(''), 'flush') === true);
    })();

    // Both entry points stay, exactly as 2.6 kept conversioAbtastyTracking
    // alongside its queue. A client already calling the control keeps working.
    check('the enable control is still exposed',
      typeof queued('').window.__conversioEnableEmission__ === 'function');
    check('the disable control is still exposed',
      typeof queued('').window.__conversioDisableEmission__ === 'function');
    check('the flush control is still exposed',
      typeof queued('').window.__conversioFlushEmission__ === 'function');
    check('calling the control directly still opens the gate',
      (function () { var r = queued(''); r.window.__conversioEnableEmission__(); return gate(r) === 'true'; })());
    check('and the two entry points agree',
      (function () {
        var viaFn = queued(''); viaFn.window.__conversioEnableEmission__();
        var viaQueue = queued(''); pushLive(viaQueue, 'enable');
        return gate(viaFn) === gate(viaQueue) && clientGate(viaFn) === clientGate(viaQueue);
      })());

    // The live queue replaces the array, so the buffer cannot be drained twice.
    check('the queue is an object with a push after init, not the array',
      (function () { var q = queued('').window.conversioConsentQueue; return !!q && typeof q.push === 'function' && !Array.isArray(q); })());
    check('a queued grant is not re-applied by a later push of its own',
      (function () {
        var r = queued(PUSH + "('enable');");
        pushLive(r, 'deny');
        return gate(r) === 'false';
      })());
  })();

  return { pass: pass, fail: fail };
}

var totalPass = 0;
var totalFail = 0;

TAG_PATHS.forEach(function (entry) {
  var result = runSuite(entry.path, entry.label);
  totalPass += result.pass;
  totalFail += result.fail;
  console.log(entry.label + ': ' + result.pass + ' passed, ' + result.fail + ' failed');
});

console.log('\nTOTAL: ' + totalPass + ' passed, ' + totalFail + ' failed\n');
process.exit(totalFail ? 1 : 0);
