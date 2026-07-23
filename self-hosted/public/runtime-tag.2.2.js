// CONVERSIO TAG | Runtime bundle : version 2.2 - updated 21-07-2026
// Copyright Conversio Ltd. 2026 - Use permitted only under licence.
(function () {
  'use strict';

  // Prevent double initialisation
  var INIT_KEY = '__CONVERSIO_RUNTIME_INIT__';
  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  // Storage keys
  var KEY_EXPERIENCE_MAP        = 'conversioExperienceMap';
  var KEY_EXPERIENCE_LIST       = 'conversioExperienceList';
  var KEY_EXPERIENCE_FIRED      = 'conversioExperienceFired';
  var KEY_EVENT_LIST            = 'conversioEventList';
  var KEY_EVENT_BUFFER          = 'conversioEventBuffer';
  var KEY_EMISSION_ENABLED      = 'conversioEmissionEnabled';
  var KEY_VITALS_PENDING        = 'conversioVitalsPending';
  var KEY_VITALS_LATEST         = 'conversio_vitals';

  // Outbound emit event names
  var EXPERIENCE_EVENT_NAME     = 'conversio_experience_session';
  var CONVERSIO_EVENT_EMIT_NAME = 'conversio_event_instance';
  var VITALS_EVENT_NAME         = 'conversio_data';

  // Core Web Vitals collection tuning
  var VITALS_IDLE_TIMEOUT_MS    = 4000;
  var VITALS_HARD_TIMEOUT_MS    = 6000;

  // Internal per-object processed flags
  var EXPERIENCE_PROCESSED_FLAG = '__conversioExperienceRuntimeProcessed__';
  var EVENT_PROCESSED_FLAG      = '__conversioEventRuntimeProcessed__';

  var dl = window.dataLayer = window.dataLayer || [];

  function safeJsonParse(str, fallback) {
    try { return JSON.parse(str); } catch (e) { return fallback; }
  }

  function safeJsonStringify(obj, fallback) {
    try { return JSON.stringify(obj); } catch (e) { return fallback; }
  }

  function isArray(value) {
    return Object.prototype.toString.call(value) === '[object Array]';
  }

  function isObject(value) {
    return !!value && typeof value === 'object';
  }

  function loadJsonObject(key) {
    if (!window.sessionStorage) return {};
    var raw = window.sessionStorage.getItem(key);
    var obj = raw ? safeJsonParse(raw, {}) : {};
    if (!isObject(obj) || isArray(obj)) obj = {};
    return obj;
  }

  function saveJsonObject(key, obj) {
    if (!window.sessionStorage) return;
    window.sessionStorage.setItem(key, safeJsonStringify(obj, '{}'));
  }

  function loadJsonArray(key) {
    if (!window.sessionStorage) return [];
    var raw = window.sessionStorage.getItem(key);
    var arr = raw ? safeJsonParse(raw, []) : [];
    if (!isArray(arr)) arr = [];
    return arr;
  }

  function saveJsonArray(key, arr) {
    if (!window.sessionStorage) return;
    window.sessionStorage.setItem(key, safeJsonStringify(arr, '[]'));
  }

  function arrayHas(arr, value) {
    var i;
    for (i = 0; i < arr.length; i++) {
      if (arr[i] === value) return true;
    }
    return false;
  }

  function addUniqueStringToArrayStorage(key, value) {
    var list;
    if (!value || typeof value !== 'string') return false;

    list = loadJsonArray(key);
    if (arrayHas(list, value)) return false;

    list.push(value);
    saveJsonArray(key, list);
    return true;
  }

  function loadExperienceMap() {
    return loadJsonObject(KEY_EXPERIENCE_MAP);
  }

  function saveExperienceMap(map) {
    saveJsonObject(KEY_EXPERIENCE_MAP, map);
  }

  function loadExperienceFired() {
    return loadJsonObject(KEY_EXPERIENCE_FIRED);
  }

  function saveExperienceFired(fired) {
    saveJsonObject(KEY_EXPERIENCE_FIRED, fired);
  }

  function loadEventBuffer() {
    return loadJsonArray(KEY_EVENT_BUFFER);
  }

  function saveEventBuffer(buffer) {
    saveJsonArray(KEY_EVENT_BUFFER, buffer);
  }

  function clearEventBuffer() {
    saveJsonArray(KEY_EVENT_BUFFER, []);
  }

  function isEmissionEnabled() {
    if (!window.sessionStorage) return false;
    return window.sessionStorage.getItem(KEY_EMISSION_ENABLED) === 'true';
  }

  function setEmissionEnabled(value) {
    if (!window.sessionStorage) return;
    window.sessionStorage.setItem(KEY_EMISSION_ENABLED, value ? 'true' : 'false');
  }

  function isConversioExperience(item) {
    return (
      isObject(item) &&
      item.event === 'conversioExperience' &&
      isObject(item.conversio)
    );
  }

  function isConversioEvent(item) {
    return (
      isObject(item) &&
      item.event === 'conversioEvent' &&
      isObject(item.conversio)
    );
  }

  function emitExperience(seg, payload) {
    dl.push({
      event: EXPERIENCE_EVENT_NAME,
      conversio: {
        experience_segment: seg,
        experience_category: payload.experience_category || '',
        experience_action: payload.experience_action || '',
        experience_label: payload.experience_label || ''
      }
    });
  }

  function emitConversioEvent(payload) {
    dl.push({
      event: CONVERSIO_EVENT_EMIT_NAME,
      conversio: {
        event_category: payload.event_category || '',
        event_action: payload.event_action || '',
        event_label: payload.event_label || '',
        event_segment: payload.event_segment || ''
      }
    });
  }

  function persistExperienceIfNew(payload) {
    var seg;
    var map;
    var isNew;

    if (!isObject(payload)) return '';

    seg = payload.experience_segment;
    if (!seg || typeof seg !== 'string') return '';

    map = loadExperienceMap();
    isNew = !Object.prototype.hasOwnProperty.call(map, seg);

    if (isNew) {
      map[seg] = {
        experience_category: payload.experience_category || '',
        experience_action: payload.experience_action || '',
        experience_label: payload.experience_label || ''
      };
      saveExperienceMap(map);
      addUniqueStringToArrayStorage(KEY_EXPERIENCE_LIST, seg);
    }

    return seg;
  }

  function emitExperienceIfUnfired(seg, payload) {
    var fired;

    if (!seg || typeof seg !== 'string') return;
    if (!isEmissionEnabled()) return;

    fired = loadExperienceFired();
    if (Object.prototype.hasOwnProperty.call(fired, seg)) return;

    emitExperience(seg, payload);
    fired[seg] = true;
    saveExperienceFired(fired);
  }

  function flushUnfiredExperiences() {
    var list;
    var map;
    var fired;
    var i;
    var seg;
    var payload;
    var changed;

    if (!isEmissionEnabled()) return;

    list = loadJsonArray(KEY_EXPERIENCE_LIST);
    if (!list.length) return;

    map = loadExperienceMap();
    fired = loadExperienceFired();
    changed = false;

    for (i = 0; i < list.length; i++) {
      seg = list[i];
      if (!seg || typeof seg !== 'string') continue;
      if (Object.prototype.hasOwnProperty.call(fired, seg)) continue;

      payload = map[seg];
      if (!isObject(payload)) continue;

      emitExperience(seg, payload);
      fired[seg] = true;
      changed = true;
    }

    if (changed) saveExperienceFired(fired);
  }

  function bufferConversioEvent(payload) {
    var buffer;

    if (!isObject(payload)) return;

    buffer = loadEventBuffer();
    buffer.push({
      event_category: payload.event_category || '',
      event_action: payload.event_action || '',
      event_label: payload.event_label || '',
      event_segment: payload.event_segment || ''
    });
    saveEventBuffer(buffer);
  }

  function flushBufferedConversioEvents() {
    var buffer;
    var i;
    var payload;

    if (!isEmissionEnabled()) return;

    buffer = loadEventBuffer();
    if (!buffer.length) return;

    clearEventBuffer();

    for (i = 0; i < buffer.length; i++) {
      payload = buffer[i];
      if (!isObject(payload)) continue;
      emitConversioEvent(payload);
    }
  }

  function emitVitals(vitals) {
    dl.push({
      event: VITALS_EVENT_NAME,
      conversio: {
        conversio_vitals: vitals
      }
    });
  }

  function bufferVitals(vitals) {
    saveJsonObject(KEY_VITALS_PENDING, vitals);
  }

  function flushPendingVitals() {
    var vitals;

    if (!isEmissionEnabled()) return;

    vitals = loadJsonObject(KEY_VITALS_PENDING);
    if (!isObject(vitals) || !Object.prototype.hasOwnProperty.call(vitals, 'ps')) return;

    saveJsonObject(KEY_VITALS_PENDING, {});
    emitVitals(vitals);
  }

  function handleCollectedVitals(vitals) {
    // Always store the latest snapshot locally, regardless of emission gate,
    // consistent with how experiences/events are persisted independently of emission.
    saveJsonObject(KEY_VITALS_LATEST, vitals);

    if (isEmissionEnabled()) {
      emitVitals(vitals);
    } else {
      bufferVitals(vitals);
    }
  }

  function enableEmission() {
    setEmissionEnabled(true);
    flushUnfiredExperiences();
    flushBufferedConversioEvents();
    flushPendingVitals();
  }

  function disableEmission() {
    setEmissionEnabled(false);
  }

  // --- Core Web Vitals (CWV) tracking -----------------------------------
  // Best-effort only: any failure here must never affect dataLayer
  // processing above, and must never delay it. All entry points are
  // wrapped in try/catch and every wait has a hard timeout fallback.

  function isPerformanceApiSupported() {
    return !!(
      window.performance &&
      typeof window.performance.getEntries === 'function' &&
      typeof window.performance.getEntriesByType === 'function' &&
      typeof window.PerformanceObserver === 'function'
    );
  }

  function collectWebVitals(onDone) {
    var lcp = null;
    var fcp = null;
    var cls = 0;
    var observers = [];
    var finished = false;

    function safeObserve(type, cb) {
      var obs;
      try {
        obs = new window.PerformanceObserver(cb);
        obs.observe({ type: type, buffered: true });
        observers.push(obs);
      } catch (e) {
        // entry type unsupported in this browser; ignore
      }
    }

    safeObserve('largest-contentful-paint', function (list) {
      var entries;
      try {
        entries = list.getEntries();
        if (entries && entries.length) {
          lcp = entries[entries.length - 1].startTime;
        }
      } catch (e) { /* ignore malformed entries */ }
    });

    safeObserve('paint', function (list) {
      var entries;
      var i;
      try {
        entries = list.getEntries();
        for (i = 0; i < entries.length; i++) {
          if (entries[i].name === 'first-contentful-paint') fcp = entries[i].startTime;
        }
      } catch (e) { /* ignore malformed entries */ }
    });

    safeObserve('layout-shift', function (list) {
      var entries;
      var i;
      try {
        entries = list.getEntries();
        for (i = 0; i < entries.length; i++) {
          if (!entries[i].hadRecentInput) cls += entries[i].value;
        }
      } catch (e) { /* ignore malformed entries */ }
    });

    function grabMissingFromEntries() {
      var all;
      var i;

      try {
        all = window.performance.getEntries();
      } catch (e) {
        return;
      }

      if (lcp === null) {
        for (i = all.length - 1; i >= 0; i--) {
          if (all[i].entryType === 'largest-contentful-paint') {
            lcp = all[i].startTime;
            break;
          }
        }
      }

      if (fcp === null) {
        for (i = all.length - 1; i >= 0; i--) {
          if (all[i].name === 'first-contentful-paint') {
            fcp = all[i].startTime;
            break;
          }
        }
      }
    }

    function finish() {
      var i;
      var nav;
      var pageLoad;

      if (finished) return;
      finished = true;

      for (i = 0; i < observers.length; i++) {
        try { observers[i].disconnect(); } catch (e) { /* ignore */ }
      }

      pageLoad = null;
      try {
        grabMissingFromEntries();
        nav = window.performance.getEntriesByType('navigation')[0];
        if (nav && nav.loadEventEnd) {
          pageLoad = Math.round(nav.loadEventEnd - nav.startTime);
        }
      } catch (e) { /* leave pageLoad as null */ }

      try {
        onDone({
          lcp: (typeof lcp === 'number') ? lcp : null,
          fcp: (typeof fcp === 'number') ? fcp : null,
          cls: +cls.toFixed(3),
          ps: pageLoad
        });
      } catch (e) { /* consumer failure must not throw back into observers */ }
    }

    function scheduleFinish() {
      try {
        if ('requestIdleCallback' in window) {
          window.requestIdleCallback(finish, { timeout: VITALS_IDLE_TIMEOUT_MS });
        } else {
          window.setTimeout(finish, VITALS_IDLE_TIMEOUT_MS);
        }
      } catch (e) {
        window.setTimeout(finish, VITALS_IDLE_TIMEOUT_MS);
      }
      // Hard safety net: guarantees finish() runs even if requestIdleCallback
      // never fires, so collection can never hang indefinitely.
      window.setTimeout(finish, VITALS_HARD_TIMEOUT_MS);
    }

    try {
      if (document.readyState === 'complete') {
        scheduleFinish();
      } else {
        window.addEventListener('load', scheduleFinish, { once: true });
        // In case 'load' never fires (e.g. tab backgrounded/frozen), still
        // guarantee a result within the hard timeout window.
        window.setTimeout(finish, VITALS_HARD_TIMEOUT_MS);
      }
    } catch (e) {
      // If we can't even schedule collection, resolve immediately with nulls
      // rather than leaving the caller waiting.
      finish();
    }
  }

  function initWebVitalsTracking() {
    if (!isPerformanceApiSupported()) return;

    try {
      collectWebVitals(function (vitals) {
        try {
          handleCollectedVitals(vitals);
        } catch (e) { /* never let CWV handling affect the runtime tag */ }
      });
    } catch (e) {
      // never let CWV tracking affect the runtime tag
    }
  }

  function processOneConversioExperience(item) {
    var payload;
    var seg;

    if (!isConversioExperience(item)) return;
    if (item[EXPERIENCE_PROCESSED_FLAG]) return;

    item[EXPERIENCE_PROCESSED_FLAG] = true;
    payload = item.conversio;

    seg = persistExperienceIfNew(payload);
    if (!seg) return;

    emitExperienceIfUnfired(seg, payload);
  }

  function processOneConversioEvent(item) {
    var payload;

    if (!isConversioEvent(item)) return;
    if (item[EVENT_PROCESSED_FLAG]) return;

    item[EVENT_PROCESSED_FLAG] = true;
    payload = item.conversio;

    addUniqueStringToArrayStorage(KEY_EVENT_LIST, payload.event_segment);

    if (isEmissionEnabled()) {
      emitConversioEvent(payload);
    } else {
      bufferConversioEvent(payload);
    }
  }

  function processOneItem(item) {
    processOneConversioExperience(item);
    processOneConversioEvent(item);
  }

  function processExistingDataLayer() {
    var i;
    for (i = 0; i < dl.length; i++) {
      processOneItem(dl[i]);
    }
  }

  function hookPush() {
    var originalPush = dl.push;

    dl.push = function () {
      var res = originalPush.apply(dl, arguments);
      var i;

      for (i = 0; i < arguments.length; i++) {
        processOneItem(arguments[i]);
      }

      return res;
    };
  }

  // Public gate controls
  window.__conversioEnableEmission__ = enableEmission;
  window.__conversioDisableEmission__ = disableEmission;
  window.__conversioFlushEmission__ = function () {
    flushUnfiredExperiences();
    flushBufferedConversioEvents();
    flushPendingVitals();
  };

  // Bootstrap
  processExistingDataLayer();
  hookPush();

  // Core Web Vitals tracking is strictly best-effort: it runs after the
  // core dataLayer plumbing above is already live, and any failure here
  // is swallowed so it can never block or break tag initialisation.
  try {
    initWebVitalsTracking();
  } catch (e) { /* ignore */ }

})();
// Copyright Conversio Ltd. 2026 - Use permitted only under licence.
