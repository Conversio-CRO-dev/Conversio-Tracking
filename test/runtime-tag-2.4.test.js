// Behavioural checks for the 2.4 runtime tag: conversio_id minting and
// persistence, the emission-consent gate, CWV success/failure fallback, and
// the single-event-per-page-load guarantee.
//
// Runs the same suite against both shipped copies of the tag (the GTM dev
// file and the self-hosted bundle) so the two can never silently diverge.
//
// Usage: node test/runtime-tag-2.4.test.js
'use strict';

var fs = require('fs');
var path = require('path');
var runTag = require('./harness').runTag;

var TAG_PATHS = [
  { label: 'conversio_runtime_tag_v2.4.js', path: path.join(__dirname, '..', 'conversio_runtime_tag_v2.4.js') },
  { label: 'self-hosted/public/runtime-tag.2.4.js', path: path.join(__dirname, '..', 'self-hosted', 'public', 'runtime-tag.2.4.js') }
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
      p.conversio_experiences === '["s1"]', String(p.conversio_experiences));
    check('conversio_events holds event segments',
      p.conversio_events === '[]', String(p.conversio_events));

    var withEvent = gaRun({ cwv: 'ok', emissionEnabled: true });
    pushEvent(withEvent, 'e1');
    var ep = croCalls(withEvent.gtagCalls)[0].params;
    check('event sends conversio_cro', !!ep, 'none');
    check('event category mapped', ep.conversio_category === 'evt-cat', String(ep.conversio_category));
    check('event action mapped', ep.conversio_action === 'evt-act', String(ep.conversio_action));
    check('event label mapped', ep.conversio_label === 'evt-lab', String(ep.conversio_label));
    check('event segment mapped', ep.conversio_segment === 'e1', String(ep.conversio_segment));
    check('event conversio_events holds event segments',
      ep.conversio_events === '["e1"]', String(ep.conversio_events));
    check('event conversio_experiences stays empty',
      ep.conversio_experiences === '[]', String(ep.conversio_experiences));
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
      JSON.parse(lateParams.conversio_vitals).ps === 2000, String(lateParams.conversio_vitals));

    var seeded = gaRun({
      cwv: 'ok',
      emissionEnabled: true,
      sessionInitial: { conversio_vitals: '{"lcp":1234.5,"fcp":456.7,"cls":0.07,"ps":2000}' }
    });
    pushExperience(seeded, 's1');
    var sp = croCalls(seeded.gtagCalls)[0].params;
    check('collected vitals sent as a JSON string',
      typeof sp.conversio_vitals === 'string' &&
      JSON.parse(sp.conversio_vitals).lcp === 1234.5, String(sp.conversio_vitals));

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
