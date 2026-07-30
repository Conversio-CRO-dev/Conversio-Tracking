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
  { entryType: 'layout-shift', name: '', startTime: 300, value: 0.9, hadRecentInput: true }
];

// opts:
//   tagPath: path to the tag source to load (required)
//   cwv: 'ok' | 'unsupported' | 'observer-throws' | 'empty'
//   localStorage: store or false (absent) or {throwOnRead/throwOnWrite}
//   emissionEnabled: bool
//   sessionInitial: seed object for sessionStorage
//   localInitial: seed object for localStorage
//   autoDrain: false leaves pending timers/callbacks undrained, so a test can
//     interleave consent with CWV collection finishing
function runTag(opts) {
  opts = opts || {};
  if (!opts.tagPath) throw new Error('runTag requires opts.tagPath');
  var cwv = opts.cwv || 'ok';

  var timers = [];
  var idleCallbacks = [];
  var loadListeners = [];

  var sessionInitial = Object.assign({}, opts.sessionInitial || {});
  if (opts.emissionEnabled) sessionInitial.conversioEmissionEnabled = 'true';

  var sessionStore = makeStore(sessionInitial);
  var localStore = opts.localStorage === false
    ? null
    : makeStore(opts.localInitial, opts.localStorageOpts);

  var entries = (cwv === 'ok') ? VITALS_FIXTURE.slice() : [];

  function FakePerformanceObserver(cb) {
    this._cb = cb;
  }
  FakePerformanceObserver.prototype.observe = function (spec) {
    if (cwv === 'observer-throws') throw new Error('observe unsupported');
    var self = this;
    var matching = entries.filter(function (e) { return e.entryType === spec.type; });
    if (!matching.length) return;
    // buffered:true delivers synchronously-ish; queue it as a timer.
    timers.push({ at: 0, fn: function () {
      self._cb({ getEntries: function () { return matching; } });
    } });
  };
  FakePerformanceObserver.prototype.disconnect = function () {};

  var performance = {
    timeOrigin: 1785492847123.456,
    now: function () { return 1500.25; },
    getEntries: function () { return entries; },
    getEntriesByType: function (t) {
      if (t === 'navigation') {
        return (cwv === 'ok') ? [{ loadEventEnd: 2000, startTime: 0 }] : [];
      }
      return entries.filter(function (e) { return e.entryType === t; });
    }
  };

  var dataLayer = [];

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
    setTimeout: function (fn, ms) { timers.push({ at: ms || 0, fn: fn }); return timers.length; },
    addEventListener: function (name, fn) { if (name === 'load') loadListeners.push(fn); },
    requestIdleCallback: function (fn) { idleCallbacks.push(fn); }
  };

  if (cwv !== 'unsupported') {
    window.PerformanceObserver = FakePerformanceObserver;
  }
  if (localStore) window.localStorage = localStore;

  sandbox.window = window;
  sandbox.document = { readyState: opts.readyState || 'complete' };
  sandbox.setTimeout = window.setTimeout;
  window.window = window;

  var context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(opts.tagPath, 'utf8'), context, { filename: opts.tagPath });

  function drain() {
    var guard = 0;
    while ((timers.length || idleCallbacks.length || loadListeners.length) && guard++ < 500) {
      var ls = loadListeners.splice(0, loadListeners.length);
      ls.forEach(function (fn) { try { fn(); } catch (e) {} });
      var ts = timers.splice(0, timers.length).sort(function (a, b) { return a.at - b.at; });
      ts.forEach(function (t) { try { t.fn(); } catch (e) {} });
      var ic = idleCallbacks.splice(0, idleCallbacks.length);
      ic.forEach(function (fn) { try { fn(); } catch (e) {} });
    }
  }

  if (opts.autoDrain !== false) drain();

  return {
    dataLayer: dataLayer,
    session: sessionStore._data,
    local: localStore ? localStore._data : null,
    window: window,
    drain: drain
  };
}

module.exports = { runTag: runTag, makeStore: makeStore };
