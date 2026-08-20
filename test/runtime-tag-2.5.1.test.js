// Behavioural checks for the 2.5.1 runtime tag: conversio_id minting and
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
// Usage: node test/runtime-tag-2.5.1.test.js
'use strict';

var fs = require('fs');
var path = require('path');
var runTag = require('./harness').runTag;
var VITALS_FIXTURE = require('./harness').VITALS_FIXTURE;

var TAG_PATHS = [
  { label: 'conversio_runtime_tag_v2.5.1.js', path: path.join(__dirname, '..', 'conversio_runtime_tag_v2.5.1.js') },
  { label: 'self-hosted/public/runtime-tag.2.5.1.js', path: path.join(__dirname, '..', 'self-hosted', 'public', 'runtime-tag.2.5.1.js') }
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
