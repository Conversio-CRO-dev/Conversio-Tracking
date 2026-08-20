// Minimal browser stub for exercising a Conversio runtime tag file under
// Node. Loads the given tag source into a vm sandbox with just enough of
// window/document/performance/storage to drive it end to end, then exposes
// what landed in dataLayer and storage for assertions.
'use strict';

var fs = require('fs');
var vm = require('vm');
var crypto = require('crypto');

function makeStore(initial, opts) {
  opts = opts || {};
  var data = Object.assign({}, initial || {});
  return {
    _data: data,
    getItem: function (k) {
      if (opts.throwOnRead) throw new Error('storage blocked');
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
    },
    setItem: function (k, v) {
      if (opts.throwOnWrite) throw new Error('storage blocked');
      data[k] = String(v);
    }
  };
}

var VITALS_FIXTURE = [
  { entryType: 'largest-contentful-paint', name: '', startTime: 1234.5 },
  { entryType: 'paint', name: 'first-contentful-paint', startTime: 456.7 },
  { entryType: 'layout-shift', name: '', startTime: 100, value: 0.05, hadRecentInput: false },
  { entryType: 'layout-shift', name: '', startTime: 200, value: 0.02, hadRecentInput: false },
  { entryType: 'layout-shift', name: '', startTime: 300, value: 0.9, hadRecentInput: true },
  // Two interactions. The first is one tap, whose three events share an
  // interactionId and count as a single 40ms interaction (the longest of them,
  // not their sum); the second is a slower keypress, so the page's worst
  // interaction is 96ms. Measured by 2.4.1 as INP; kept here because 2.4.2,
  // which removed that, has to prove none of it reaches the vitals object.
  { entryType: 'event', name: 'pointerdown', interactionId: 101, startTime: 800, duration: 24 },
  { entryType: 'event', name: 'pointerup', interactionId: 101, startTime: 810, duration: 40 },
  { entryType: 'event', name: 'click', interactionId: 101, startTime: 820, duration: 32 },
  { entryType: 'event', name: 'keydown', interactionId: 202, startTime: 1200, duration: 96 },
  // Not an interaction at all (interactionId 0), and slow enough to dominate
  // INP if it were ever counted as one.
  { entryType: 'event', name: 'pointermove', interactionId: 0, startTime: 900, duration: 500 }
];

// opts:
//   tagPath: path to the tag source to load (required)
//   tagSource: source string to run instead of the file at tagPath, for
//     exercising a transform the loader applies at serve time. tagPath is
//     still required, as the script name in stack traces.
//   cwv: 'ok' | 'unsupported' | 'observer-throws' | 'empty'
//   visibilityState: what document.visibilityState reads, 'visible' by default.
//     Only consulted by a tag that has no visibility-state entry to go on, the
//     entries being the authoritative record where a browser keeps them.
//   entryDelays: { <entryType>: ms } holds a buffered observer delivery back
//     until that point in virtual time, for reproducing a measurement a real
//     browser would not have produced yet. Anything not listed is delivered
//     immediately, as before.
//   entries: performance entries to serve instead of VITALS_FIXTURE (exported
//     below, so a test can filter or extend it), for building a case the shared
//     fixture doesn't cover. Honoured whatever cwv says, since the two control
//     different things: cwv decides what the observer API does, this decides
//     what there is to observe.
//   perfTimeOrigin / perfNow: override the simulated high-resolution clock with
//     a fixed number, so a test can reproduce the 100us clamping real browsers
//     apply to it. Pass false to remove that property altogether, which is how
//     a browser offering no high-resolution clock at all is simulated (the tag
//     falls back to Date.now()); Core Web Vitals collection is unaffected
//     either way, since it reads performance entries rather than the clock.
//   localStorage: store or false (absent) or {throwOnRead/throwOnWrite}
//   emissionEnabled: bool
//   sessionInitial: seed object for sessionStorage
//   localInitial: seed object for localStorage
//   dataLayerInitial: items to place on the dataLayer before the tag runs, so
//     the sweep of what is already there is exercised rather than only the
//     push hook
//   autoDrain: false leaves pending timers/callbacks undrained, so a test can
//     interleave consent with CWV collection finishing. The returned drain also
//     takes { until: ms }, which stops at that point in virtual time rather than
//     running everything, for asking what the tag had reported by then.
//   presetSettings: seeds window.conversioSettings before the tag runs, as if
//     another tag on the page had got there first
//   gtag: 'spy' installs a window.gtag that records calls (the path taken when
//     the site has gtag.js loaded), 'throws' installs one that throws, and the
//     default of none leaves the tag to queue commands on dataLayer instead.
//     Recorded calls come back as gtagCalls, each { command, name, params }.
function runTag(opts) {
  opts = opts || {};
  if (!opts.tagPath) throw new Error('runTag requires opts.tagPath');
  var cwv = opts.cwv || 'ok';

  // Virtual time, in milliseconds since the tag ran. Timers carry the time they
  // are due and drain runs them in that order, advancing the clock, so a
  // callback that arms another timer is scheduled after the first rather than
  // alongside it. Sequence numbers keep two timers due at the same moment in the
  // order they were armed.
  var clock = 0;
  var timerSeq = 0;
  var timers = [];
  var idleCallbacks = [];
  var loadListeners = [];

  var sessionInitial = Object.assign({}, opts.sessionInitial || {});
  if (opts.emissionEnabled) sessionInitial.conversioEmissionEnabled = 'true';

  var sessionStore = makeStore(sessionInitial);
  var localStore = opts.localStorage === false
    ? null
    : makeStore(opts.localInitial, opts.localStorageOpts);

  var entries = opts.entries
    ? opts.entries.slice()
    : ((cwv === 'ok') ? VITALS_FIXTURE.slice() : []);

  // Every spec passed to observe(), in call order, so a test can assert on
  // which entry types the tag registers for and with what options. Recorded
  // before the unsupported-browser throw, since the tag asked either way.
  var observedSpecs = [];

  // When an entry type exists in the timeline. An entry a real browser has not
  // produced yet cannot be read synchronously either, so a delayed type is
  // absent from getEntries until the clock reaches it: without this, a page that
  // has not painted would still hand a paint entry to anything that asked.
  function entryAvailableAt(entry) {
    return (opts.entryDelays && opts.entryDelays[entry.entryType]) || 0;
  }

  function availableEntries() {
    return entries.filter(function (e) { return entryAvailableAt(e) <= clock; });
  }

  function FakePerformanceObserver(cb) {
    this._cb = cb;
  }
  FakePerformanceObserver.prototype.observe = function (spec) {
    observedSpecs.push(spec);
    if (cwv === 'observer-throws') throw new Error('observe unsupported');
    var self = this;
    var matching = entries.filter(function (e) { return e.entryType === spec.type; });
    // As a real observer does: an entry shorter than the requested threshold is
    // never delivered, which is what makes a fast interaction invisible.
    if (typeof spec.durationThreshold === 'number') {
      matching = matching.filter(function (e) { return e.duration >= spec.durationThreshold; });
    }
    if (!matching.length) return;
    // buffered:true delivers synchronously-ish, so the default is immediate.
    // entryDelays holds the delivery back for an entry type that a real browser
    // would not have produced yet, a paint on a page loaded in a background tab
    // being the case worth simulating.
    var delay = (opts.entryDelays && opts.entryDelays[spec.type]) || 0;
    timers.push({ due: clock + delay, seq: timerSeq++, fn: function () {
      self._cb({ getEntries: function () { return matching; } });
    } });
  };
  FakePerformanceObserver.prototype.disconnect = function () {};

  var performance = {
    timeOrigin: 1785492847123.456,
    now: function () { return 1500.25; },
    getEntries: function () { return availableEntries(); },
    getEntriesByType: function (t) {
      if (t === 'navigation') {
        return (cwv === 'ok') ? [{ loadEventEnd: 2000, startTime: 0 }] : [];
      }
      return availableEntries().filter(function (e) { return e.entryType === t; });
    }
  };

  if (typeof opts.perfTimeOrigin === 'number') performance.timeOrigin = opts.perfTimeOrigin;
  if (opts.perfTimeOrigin === false) delete performance.timeOrigin;

  if (typeof opts.perfNow === 'number') {
    performance.now = (function (fixed) {
      return function () { return fixed; };
    })(opts.perfNow);
  }
  if (opts.perfNow === false) delete performance.now;

  // Items already on the dataLayer when the tag loads, for the sweep it does at
  // init before hooking push(). Pushed emits land after them, as on a real page.
  var dataLayer = (opts.dataLayerInitial || []).slice();

  var sandbox = {
    console: console,
    JSON: JSON,
    Math: Math,
    Date: Date,
    Object: Object,
    isFinite: isFinite,
    RegExp: RegExp,
    String: String,
    Number: Number,
    Error: Error
  };

  var window = {
    dataLayer: dataLayer,
    sessionStorage: sessionStore,
    performance: performance,
    Uint8Array: Uint8Array,
    crypto: { getRandomValues: crypto.randomFillSync },
    setTimeout: function (fn, ms) {
      timers.push({ due: clock + (ms || 0), seq: timerSeq++, fn: fn });
      return timers.length;
    },
    addEventListener: function (name, fn) { if (name === 'load') loadListeners.push(fn); },
    requestIdleCallback: function (fn) { idleCallbacks.push(fn); }
  };

  if (cwv !== 'unsupported') {
    window.PerformanceObserver = FakePerformanceObserver;
  }
  if (localStore) window.localStorage = localStore;
  if (opts.presetSettings) window.conversioSettings = opts.presetSettings;

  var gtagCalls = [];
  if (opts.gtag === 'spy') {
    window.gtag = function (command, name, params) {
      gtagCalls.push({ command: command, name: name, params: params });
    };
  } else if (opts.gtag === 'throws') {
    window.gtag = function () { throw new Error('gtag blew up'); };
  }

  // The queued fallback: with no window.gtag the tag pushes gtag command
  // tuples onto dataLayer for gtag.js to pick up when it loads, so a test can
  // read them back the same way gtag.js would.
  function queuedGtagCalls() {
    return dataLayer
      .filter(function (e) {
        return e && typeof e.length === 'number' && typeof e.event === 'undefined';
      })
      .map(function (a) { return { command: a[0], name: a[1], params: a[2] }; });
  }

  sandbox.window = window;
  sandbox.document = {
    readyState: opts.readyState || 'complete',
    visibilityState: opts.visibilityState || 'visible'
  };
  sandbox.setTimeout = window.setTimeout;
  window.window = window;

  var source = (typeof opts.tagSource === 'string')
    ? opts.tagSource
    : fs.readFileSync(opts.tagPath, 'utf8');

  var context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: opts.tagPath });

  // The next timer due at or before the limit, earliest first.
  function nextDueTimer(limit) {
    var best = -1;
    var i;

    for (i = 0; i < timers.length; i++) {
      if (timers[i].due > limit) continue;
      if (best === -1 ||
          timers[i].due < timers[best].due ||
          (timers[i].due === timers[best].due && timers[i].seq < timers[best].seq)) {
        best = i;
      }
    }

    return best;
  }

  // Runs everything the page has waiting. An idle callback is treated as due
  // straight away, which is what a browser does with an idle main thread and is
  // what makes it beat a timer armed for seconds later.
  //
  // opts.until stops the drain at a point in virtual time, leaving anything due
  // after it queued, so a test can ask what the tag had reported by then.
  function drain(drainOpts) {
    var limit = (drainOpts && typeof drainOpts.until === 'number')
      ? drainOpts.until
      : Infinity;
    var guard = 0;
    var index;
    var timer;
    var ls;
    var ic;

    while (guard++ < 5000) {
      if (loadListeners.length) {
        ls = loadListeners.splice(0, loadListeners.length);
        ls.forEach(function (fn) { try { fn(); } catch (e) {} });
        continue;
      }

      // Anything already due runs before the main thread counts as idle, which
      // is the order a browser uses: an idle callback waits behind the tasks
      // that are queued, a buffered observer delivery among them.
      index = nextDueTimer(Math.min(clock, limit));
      if (index !== -1) {
        timer = timers.splice(index, 1)[0];
        try { timer.fn(); } catch (e) {}
        continue;
      }

      if (idleCallbacks.length) {
        ic = idleCallbacks.splice(0, idleCallbacks.length);
        ic.forEach(function (fn) { try { fn(); } catch (e) {} });
        continue;
      }

      // Nothing left to do at this instant, so move the clock on to whatever
      // is waiting next.
      index = nextDueTimer(limit);
      if (index === -1) return;

      timer = timers.splice(index, 1)[0];
      if (timer.due > clock) clock = timer.due;
      try { timer.fn(); } catch (e) {}
    }
  }

  if (opts.autoDrain !== false) drain();

  return {
    dataLayer: dataLayer,
    session: sessionStore._data,
    local: localStore ? localStore._data : null,
    window: window,
    drain: drain,
    observedSpecs: observedSpecs,
    gtagCalls: gtagCalls,
    queuedGtagCalls: queuedGtagCalls
  };
}

module.exports = { runTag: runTag, makeStore: makeStore, VITALS_FIXTURE: VITALS_FIXTURE };
