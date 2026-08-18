// CONVERSIO TAG | Runtime bundle : version 2.4.1 - updated 17-08-2026
// Copyright Conversio Ltd. 2026 - Use permitted only under licence.
(function () {
  'use strict';

  var INIT_KEY = '__CONVERSIO_RUNTIME_INIT__';
  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  var KEY_EXPERIENCE_MAP        = 'conversioExperienceMap';
  var KEY_EXPERIENCE_LIST       = 'conversioExperienceList';
  var KEY_EXPERIENCE_FIRED      = 'conversioExperienceFired';
  var KEY_EVENT_LIST            = 'conversioEventList';
  var KEY_EVENT_BUFFER          = 'conversioEventBuffer';
  var KEY_EMISSION_ENABLED      = 'conversioEmissionEnabled';
  var KEY_DATA_PENDING          = 'conversioVitalsPending';
  var KEY_VITALS_LATEST         = 'conversio_vitals';

  var PENDING_MARKER            = 'conversio_pending';

  var KEY_CONVERSIO_ID          = 'conversio_id';

  var EXPERIENCE_EVENT_NAME     = 'conversio_experience_session';
  var CONVERSIO_EVENT_EMIT_NAME = 'conversio_event_instance';
  var VITALS_EVENT_NAME         = 'conversio_data';

  var GA_EVENT_NAME             = 'conversio_cro';

  var PARAM_LIST_DELIMITER      = ',';
  var PARAM_PAIR_DELIMITER      = ':';

  var VITALS_PARAMS = [
    { key: 'lcp', decimals: 1 },
    { key: 'fcp', decimals: 1 },
    { key: 'cls', decimals: 3 },
    { key: 'inp', decimals: 0 },
    { key: 'ps', decimals: 0 }
  ];

  var VITALS_IDLE_TIMEOUT_MS    = 4000;
  var VITALS_HARD_TIMEOUT_MS    = 6000;

  var INP_DURATION_THRESHOLD_MS = 16;

  var CONVERSIO_ID_PREFIX       = 'con_';
  var CONVERSIO_ID_RANDOM_LEN   = 16;
  var CONVERSIO_ID_ALPHABET     = 'abcdefghijklmnopqrstuvwxyz234567';
  var CONVERSIO_ID_PATTERN      = /^con_[a-z2-7]{16}\.[0-9]+$/;

  var CONVERSIO_ID_PERF_GRAIN_US = 100;
  var CONVERSIO_ID_DATE_GRAIN_US = 1000;

  var TRACKING_ID_SLOT          = '@@CONVERSIO_TRACKING_ID@@';

  var EXPERIENCE_PROCESSED_FLAG = '__conversioExperienceRuntimeProcessed__';
  var EVENT_PROCESSED_FLAG      = '__conversioEventRuntimeProcessed__';

  var dl = window.dataLayer = window.dataLayer || [];

  var conversioIdCache = null;
  var dataEventProduced = false;
  var dataEventBuffered = false;

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

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
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

  function readTrackingId() {
    if (TRACKING_ID_SLOT.indexOf('@@') !== -1) return null;
    return TRACKING_ID_SLOT.trim() || null;
  }

  function exposeClientSettings() {
    var settings;
    try {
      settings = window.conversioSettings;
      if (!isObject(settings)) settings = window.conversioSettings = {};
      settings.trackingId = readTrackingId();
    } catch (e) {
    }
  }

  function readLocalStorage(key) {
    try {
      if (!window.localStorage) return null;
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writeLocalStorage(key, value) {
    try {
      if (!window.localStorage) return false;
      window.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function randomBytes(len) {
    var crypto = window.crypto || window.msCrypto;
    var out;

    try {
      if (crypto && typeof crypto.getRandomValues === 'function') {
        out = new window.Uint8Array(len);
        crypto.getRandomValues(out);
        return out;
      }
    } catch (e) {
    }

    return null;
  }

  function randomIdString(len) {
    var bytes = randomBytes(len);
    var str = '';
    var n;
    var i;

    for (i = 0; i < len; i++) {
      n = bytes ? bytes[i] : Math.floor(Math.random() * 256);
      str += CONVERSIO_ID_ALPHABET.charAt(n & 31);
    }

    return str;
  }

  function randomBelow(max) {
    var bytes = randomBytes(2);
    var n = bytes ? ((bytes[0] << 8) | bytes[1]) : Math.floor(Math.random() * 65536);
    return n % max;
  }

  function fillClockGrain(micros, grainUs) {
    if (micros % grainUs !== 0) return micros;
    return micros + randomBelow(grainUs);
  }

  function nowMicroseconds() {
    var perf = window.performance;
    var ms;

    try {
      if (perf && typeof perf.now === 'function' && typeof perf.timeOrigin === 'number') {
        ms = perf.timeOrigin + perf.now();
        if (isFinite(ms) && ms > 0) {
          return fillClockGrain(Math.round(ms * 1000), CONVERSIO_ID_PERF_GRAIN_US);
        }
      }
    } catch (e) {
    }

    return fillClockGrain(Date.now() * 1000, CONVERSIO_ID_DATE_GRAIN_US);
  }

  function mintConversioId() {
    return CONVERSIO_ID_PREFIX + randomIdString(CONVERSIO_ID_RANDOM_LEN) + '.' + nowMicroseconds();
  }

  function getConversioId() {
    var stored;

    if (!isEmissionEnabled()) return '';

    if (conversioIdCache) return conversioIdCache;

    stored = readLocalStorage(KEY_CONVERSIO_ID);
    if (stored && CONVERSIO_ID_PATTERN.test(stored)) {
      conversioIdCache = stored;
      return conversioIdCache;
    }

    conversioIdCache = mintConversioId();
    writeLocalStorage(KEY_CONVERSIO_ID, conversioIdCache);
    return conversioIdCache;
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

  function gtagCommand() {
    if (typeof window.gtag === 'function') {
      window.gtag.apply(null, arguments);
      return;
    }
    dl.push(arguments);
  }

  function storedListParam(key) {
    var list = loadJsonArray(key);
    var out = [];
    var i;

    for (i = 0; i < list.length; i++) {
      if (list[i] && typeof list[i] === 'string') out.push(list[i]);
    }

    return out.join(PARAM_LIST_DELIMITER);
  }

  function storedVitalsParam() {
    var vitals = loadJsonObject(KEY_VITALS_LATEST);
    var parts = [];
    var value;
    var entry;
    var i;

    if (!hasUsableVitals(vitals)) return '';

    for (i = 0; i < VITALS_PARAMS.length; i++) {
      entry = VITALS_PARAMS[i];
      value = vitals[entry.key];
      if (typeof value !== 'number' || !isFinite(value)) continue;
      parts.push(entry.key + PARAM_PAIR_DELIMITER + (+value.toFixed(entry.decimals)));
    }

    return parts.join(PARAM_LIST_DELIMITER);
  }

  function sendToGa(params) {
    var trackingId = readTrackingId();
    var conversioId;

    if (!trackingId) return;

    params.send_to = trackingId;

    conversioId = getConversioId();
    if (conversioId) params.conversio_id = conversioId;

    gtagCommand('event', GA_EVENT_NAME, params);
  }

  function emitExperience(seg, payload) {
    var params;
    var vitals;

    dl.push({
      event: EXPERIENCE_EVENT_NAME,
      conversio: {
        experience_segment: seg,
        experience_category: payload.experience_category || '',
        experience_action: payload.experience_action || '',
        experience_label: payload.experience_label || ''
      }
    });

    try {
      params = {
        conversio_category: payload.experience_category || '',
        conversio_action: payload.experience_action || '',
        conversio_label: payload.experience_label || '',
        conversio_segment: seg,
        conversio_experiences: storedListParam(KEY_EXPERIENCE_LIST),
        conversio_events: storedListParam(KEY_EVENT_LIST)
      };

      vitals = storedVitalsParam();
      if (vitals) params.conversio_vitals = vitals;

      sendToGa(params);
    } catch (e) {
    }
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

    try {
      sendToGa({
        conversio_category: payload.event_category || '',
        conversio_action: payload.event_action || '',
        conversio_label: payload.event_label || '',
        conversio_segment: payload.event_segment || '',
        conversio_experiences: storedListParam(KEY_EXPERIENCE_LIST),
        conversio_events: storedListParam(KEY_EVENT_LIST)
      });
    } catch (e) {
    }
  }

  function persistExperienceIfNew(payload) {
    var seg;
    var map;
    var isNew;

    if (!isObject(payload)) return '';

    seg = payload.experience_segment;
    if (!seg || typeof seg !== 'string') return '';

    map = loadExperienceMap();
    isNew = !hasOwn(map, seg);

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
    if (hasOwn(fired, seg)) return;

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
      if (hasOwn(fired, seg)) continue;

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

  function hasUsableVitals(vitals) {
    return (
      isObject(vitals) &&
      (
        typeof vitals.lcp === 'number' ||
        typeof vitals.fcp === 'number' ||
        typeof vitals.inp === 'number' ||
        typeof vitals.ps === 'number'
      )
    );
  }

  function buildDataPayload(vitals) {
    var payload = { conversio_id: getConversioId() };

    if (hasUsableVitals(vitals)) {
      payload.conversio_vitals = vitals;
    }

    return payload;
  }

  function emitData(payload) {
    dl.push({
      event: VITALS_EVENT_NAME,
      conversio: payload
    });
  }

  function bufferData(vitals) {
    var pending = {};

    pending[PENDING_MARKER] = true;
    if (hasUsableVitals(vitals)) pending.conversio_vitals = vitals;

    saveJsonObject(KEY_DATA_PENDING, pending);
    dataEventBuffered = true;
  }

  function clearPendingData() {
    saveJsonObject(KEY_DATA_PENDING, {});
  }

  function isPendingDataPayload(pending) {
    return isObject(pending) && pending[PENDING_MARKER] === true;
  }

  function pendingVitals(pending) {
    return isObject(pending.conversio_vitals) ? pending.conversio_vitals : null;
  }

  function flushPendingData() {
    var pending;

    if (!isEmissionEnabled()) return;

    if (!dataEventBuffered) {
      clearPendingData();
      return;
    }

    pending = loadJsonObject(KEY_DATA_PENDING);
    if (!isPendingDataPayload(pending)) return;

    dataEventBuffered = false;
    clearPendingData();
    emitData(buildDataPayload(pendingVitals(pending)));
  }

  function handleCollectedData(vitals) {
    if (dataEventProduced) return;
    dataEventProduced = true;

    if (hasUsableVitals(vitals)) {
      saveJsonObject(KEY_VITALS_LATEST, vitals);
    }

    if (isEmissionEnabled()) {
      emitData(buildDataPayload(vitals));
    } else {
      bufferData(vitals);
    }
  }

  function enableEmission() {
    setEmissionEnabled(true);
    flushUnfiredExperiences();
    flushBufferedConversioEvents();
    flushPendingData();
  }

  function disableEmission() {
    setEmissionEnabled(false);
  }

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
    var interactions = {};
    var observers = [];
    var finished = false;

    function safeObserve(type, cb, durationThreshold) {
      var obs;
      var spec = { type: type, buffered: true };

      if (typeof durationThreshold === 'number') spec.durationThreshold = durationThreshold;

      try {
        obs = new window.PerformanceObserver(cb);
        obs.observe(spec);
        observers.push(obs);
      } catch (e) {
      }
    }

    safeObserve('largest-contentful-paint', function (list) {
      var entries;
      try {
        entries = list.getEntries();
        if (entries && entries.length) {
          lcp = entries[entries.length - 1].startTime;
        }
      } catch (e) { }
    });

    safeObserve('paint', function (list) {
      var entries;
      var i;
      try {
        entries = list.getEntries();
        for (i = 0; i < entries.length; i++) {
          if (entries[i].name === 'first-contentful-paint') fcp = entries[i].startTime;
        }
      } catch (e) { }
    });

    safeObserve('layout-shift', function (list) {
      var entries;
      var i;
      try {
        entries = list.getEntries();
        for (i = 0; i < entries.length; i++) {
          if (!entries[i].hadRecentInput) cls += entries[i].value;
        }
      } catch (e) { }
    });

    safeObserve('event', function (list) {
      var entries;
      var i;
      var id;
      try {
        entries = list.getEntries();
        for (i = 0; i < entries.length; i++) {
          id = entries[i].interactionId;
          if (!id) continue;
          if (!hasOwn(interactions, id) || entries[i].duration > interactions[id]) {
            interactions[id] = entries[i].duration;
          }
        }
      } catch (e) { }
    }, INP_DURATION_THRESHOLD_MS);

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

    function worstInteraction() {
      var latencies = [];
      var index;
      var id;

      for (id in interactions) {
        if (hasOwn(interactions, id)) latencies.push(interactions[id]);
      }

      if (!latencies.length) return null;

      latencies.sort(function (a, b) { return b - a; });
      index = Math.floor(latencies.length / 50);
      if (index > latencies.length - 1) index = latencies.length - 1;

      return latencies[index];
    }

    function finish() {
      var i;
      var nav;
      var pageLoad;

      if (finished) return;
      finished = true;

      for (i = 0; i < observers.length; i++) {
        try { observers[i].disconnect(); } catch (e) { }
      }

      pageLoad = null;
      try {
        grabMissingFromEntries();
        nav = window.performance.getEntriesByType('navigation')[0];
        if (nav && nav.loadEventEnd) {
          pageLoad = Math.round(nav.loadEventEnd - nav.startTime);
        }
      } catch (e) { }

      try {
        onDone({
          lcp: (typeof lcp === 'number') ? lcp : null,
          fcp: (typeof fcp === 'number') ? fcp : null,
          cls: +cls.toFixed(3),
          inp: worstInteraction(),
          ps: pageLoad
        });
      } catch (e) { }
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
      window.setTimeout(finish, VITALS_HARD_TIMEOUT_MS);
    }

    try {
      if (document.readyState === 'complete') {
        scheduleFinish();
      } else {
        window.addEventListener('load', scheduleFinish, { once: true });
        window.setTimeout(finish, VITALS_HARD_TIMEOUT_MS);
      }
    } catch (e) {
      finish();
    }
  }

  function initConversioDataEvent() {
    if (!isPerformanceApiSupported()) {
      handleCollectedData(null);
      return;
    }

    try {
      collectWebVitals(function (vitals) {
        try {
          handleCollectedData(vitals);
        } catch (e) { }
      });
    } catch (e) {
      try { handleCollectedData(null); } catch (e2) { }
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

  window.__conversioEnableEmission__ = enableEmission;
  window.__conversioDisableEmission__ = disableEmission;
  window.__conversioFlushEmission__ = function () {
    flushUnfiredExperiences();
    flushBufferedConversioEvents();
    flushPendingData();
  };

  exposeClientSettings();
  processExistingDataLayer();
  hookPush();

  try {
    initConversioDataEvent();
  } catch (e) {
    try { handleCollectedData(null); } catch (e2) { }
  }

})();
