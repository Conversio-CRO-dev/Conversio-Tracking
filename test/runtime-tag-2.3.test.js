// Behavioural checks for the 2.3 runtime tag: conversio_id minting and
// persistence, the emission-consent gate, CWV success/failure fallback, and
// the single-event-per-page-load guarantee.
//
// Runs the same suite against both shipped copies of the tag (the GTM dev
// file and the self-hosted bundle) so the two can never silently diverge.
//
// Usage: node test/runtime-tag-2.3.test.js
'use strict';

var path = require('path');
var runTag = require('./harness').runTag;

var TAG_PATHS = [
  { label: 'conversio_runtime_tag_v2.3.js', path: path.join(__dirname, '..', 'conversio_runtime_tag_v2.3.js') },
  { label: 'self-hosted/public/runtime-tag.2.3.js', path: path.join(__dirname, '..', 'self-hosted', 'public', 'runtime-tag.2.3.js') }
];

var ID_RE = /^con_[a-z2-7]{16}\.[0-9]+$/;

function dataEvents(dl) {
  return dl.filter(function (e) { return e && e.event === 'conversio_data'; });
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
      '__conversioEnableEmission__', '__conversioFlushEmission__'
    ]), JSON.stringify(added));
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
