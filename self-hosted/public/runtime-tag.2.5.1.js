// CONVERSIO TAG | Runtime bundle : version 2.5.1 - updated 20-08-2026
// Copyright Conversio Ltd. 2026 - Use permitted only under licence.
(function () {
  'use strict';

  var INIT_KEY = '__CONVERSIO_RUNTIME_INIT__';
  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  var KEY_DATA_PENDING          = 'conversioVitalsPending';
  var KEY_VITALS_LATEST         = 'conversio_vitals';

  var PENDING_MARKER            = 'conversio_pending';

  var KEY_CONVERSIO_ID          = 'conversio_id';

  var VITALS_EVENT_NAME         = 'conversio_data';

  var CONVERSIO_STREAM = {
    payloadKey:         'conversio',
    experienceTriggers: ['conversioExperience', 'conversio_experience'],
    eventTriggers:      ['conversioEvent', 'conversio_event'],
    experienceEmitName: 'conversio_experience_session',
    eventEmitName:      'conversio_event_instance',
    gaEventName:        'conversio_cro',
    paramPrefix:        'conversio_',
    keyExperienceMap:   'conversioExperienceMap',
    keyExperienceList:  'conversioExperienceList',
    keyExperienceFired: 'conversioExperienceFired',
    keyEventList:       'conversioEventList',
    keyEventBuffer:     'conversioEventBuffer',
    keyEmissionEnabled: 'conversioEmissionEnabled',
    experienceFlag:     '__conversioExperienceRuntimeProcessed__',
    eventFlag:          '__conversioEventRuntimeProcessed__',
    carriesIdentity:    true
  };

  var CLIENT_STREAM = {
    payloadKey:         'client',
    experienceTriggers: ['client_experience'],
    eventTriggers:      ['client_event'],
    experienceEmitName: 'client_experience_session',
    eventEmitName:      'client_event_instance',
    gaEventName:        'client_cro',
    paramPrefix:        'client_',
    keyExperienceMap:   'clientExperienceMap',
    keyExperienceList:  'clientExperienceList',
    keyExperienceFired: 'clientExperienceFired',
    keyEventList:       'clientEventList',
    keyEventBuffer:     'clientEventBuffer',
    keyEmissionEnabled: 'clientEmissionEnabled',
    experienceFlag:     '__clientExperienceRuntimeProcessed__',
    eventFlag:          '__clientEventRuntimeProcessed__',
    carriesIdentity:    false
  };

  var STREAMS = [CONVERSIO_STREAM, CLIENT_STREAM];

  var PARAM_LIST_DELIMITER      = ',';
  var PARAM_PAIR_DELIMITER      = ':';

  var VITALS_PARAMS = [
    { key: 'lcp', decimals: 1 },
    { key: 'fcp', decimals: 1 },
    { key: 'cls', decimals: 3 },
    { key: 'ps', decimals: 0 },
    { key: 'vis', decimals: 0 }
  ];

  var VITALS_IDLE_TIMEOUT_MS    = 4000;
  var VITALS_HARD_TIMEOUT_MS    = 6000;

  var VITALS_PAINT_RETRY_MS     = 500;
  var VITALS_PAINT_MAX_RETRIES  = 10;

  var CONVERSIO_ID_PREFIX       = 'con_';
  var CONVERSIO_ID_RANDOM_LEN   = 16;
  var CONVERSIO_ID_ALPHABET     = 'abcdefghijklmnopqrstuvwxyz234567';
  var CONVERSIO_ID_PATTERN      = /^con_[a-z2-7]{16}\.[0-9]+$/;

  var CONVERSIO_ID_PERF_GRAIN_US = 100;
  var CONVERSIO_ID_DATE_GRAIN_US = 1000;

  var TRACKING_ID_SLOT          = '@@CONVERSIO_TRACKING_ID@@';

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

    if (!isEmissionEnabled(CONVERSIO_STREAM)) return '';

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

  function loadExperienceMap(stream) {
    return loadJsonObject(stream.keyExperienceMap);
  }

  function saveExperienceMap(stream, map) {
    saveJsonObject(stream.keyExperienceMap, map);
  }

  function loadExperienceFired(stream) {
    return loadJsonObject(stream.keyExperienceFired);
  }

  function saveExperienceFired(stream, fired) {
    saveJsonObject(stream.keyExperienceFired, fired);
  }

  function loadEventBuffer(stream) {
    return loadJsonArray(stream.keyEventBuffer);
  }

  function saveEventBuffer(stream, buffer) {
    saveJsonArray(stream.keyEventBuffer, buffer);
  }

  function clearEventBuffer(stream) {
    saveJsonArray(stream.keyEventBuffer, []);
  }

  function isEmissionEnabled(stream) {
    if (!window.sessionStorage) return false;
    return window.sessionStorage.getItem(stream.keyEmissionEnabled) === 'true';
  }

  function setEmissionEnabled(value) {
    var i;

    if (!window.sessionStorage) return;

    for (i = 0; i < STREAMS.length; i++) {
      window.sessionStorage.setItem(STREAMS[i].keyEmissionEnabled, value ? 'true' : 'false');
    }
  }

  function isTriggerFor(stream, item, names) {
    var i;

    if (!isObject(item) || !isObject(item[stream.payloadKey])) return false;

    for (i = 0; i < names.length; i++) {
      if (item.event === names[i]) return true;
    }

    return false;
  }

  function isExperienceTrigger(stream, item) {
    return isTriggerFor(stream, item, stream.experienceTriggers);
  }

  function isEventTrigger(stream, item) {
    return isTriggerFor(stream, item, stream.eventTriggers);
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

  function sendToGa(stream, params) {
    var trackingId = readTrackingId();
    var conversioId;

    if (!trackingId) return;

    params.send_to = trackingId;

    if (stream.carriesIdentity) {
      conversioId = getConversioId();
      if (conversioId) params.conversio_id = conversioId;
    }

    gtagCommand('event', stream.gaEventName, params);
  }

  function emitExperience(stream, seg, payload) {
    var emit = { event: stream.experienceEmitName };
    var prefix = stream.paramPrefix;
    var params;
    var vitals;

    emit[stream.payloadKey] = {
      experience_segment: seg,
      experience_category: payload.experience_category || '',
      experience_action: payload.experience_action || '',
      experience_label: payload.experience_label || ''
    };

    dl.push(emit);

    try {
      params = {};
      params[prefix + 'category'] = payload.experience_category || '';
      params[prefix + 'action'] = payload.experience_action || '';
      params[prefix + 'label'] = payload.experience_label || '';
      params[prefix + 'segment'] = seg;
      params[prefix + 'experiences'] = storedListParam(stream.keyExperienceList);
      params[prefix + 'events'] = storedListParam(stream.keyEventList);

      if (stream.carriesIdentity) {
        vitals = storedVitalsParam();
        if (vitals) params[prefix + 'vitals'] = vitals;
      }

      sendToGa(stream, params);
    } catch (e) {
    }
  }

  function emitEvent(stream, payload) {
    var emit = { event: stream.eventEmitName };
    var prefix = stream.paramPrefix;
    var params;

    emit[stream.payloadKey] = {
      event_category: payload.event_category || '',
      event_action: payload.event_action || '',
      event_label: payload.event_label || '',
      event_segment: payload.event_segment || ''
    };

    dl.push(emit);

    try {
      params = {};
      params[prefix + 'category'] = payload.event_category || '';
      params[prefix + 'action'] = payload.event_action || '';
      params[prefix + 'label'] = payload.event_label || '';
      params[prefix + 'segment'] = payload.event_segment || '';
      params[prefix + 'experiences'] = storedListParam(stream.keyExperienceList);
      params[prefix + 'events'] = storedListParam(stream.keyEventList);

      sendToGa(stream, params);
    } catch (e) {
    }
  }

  function persistExperienceIfNew(stream, payload) {
    var seg;
    var map;
    var isNew;

    if (!isObject(payload)) return '';

    seg = payload.experience_segment;
    if (!seg || typeof seg !== 'string') return '';

    map = loadExperienceMap(stream);
    isNew = !hasOwn(map, seg);

    if (isNew) {
      map[seg] = {
        experience_category: payload.experience_category || '',
        experience_action: payload.experience_action || '',
        experience_label: payload.experience_label || ''
      };
      saveExperienceMap(stream, map);
      addUniqueStringToArrayStorage(stream.keyExperienceList, seg);
    }

    return seg;
  }

  function emitExperienceIfUnfired(stream, seg, payload) {
    var fired;

    if (!seg || typeof seg !== 'string') return;
    if (!isEmissionEnabled(stream)) return;

    fired = loadExperienceFired(stream);
    if (hasOwn(fired, seg)) return;

    emitExperience(stream, seg, payload);
    fired[seg] = true;
    saveExperienceFired(stream, fired);
  }

  function flushUnfiredExperiences(stream) {
    var list;
    var map;
    var fired;
    var i;
    var seg;
    var payload;
    var changed;

    if (!isEmissionEnabled(stream)) return;

    list = loadJsonArray(stream.keyExperienceList);
    if (!list.length) return;

    map = loadExperienceMap(stream);
    fired = loadExperienceFired(stream);
    changed = false;

    for (i = 0; i < list.length; i++) {
      seg = list[i];
      if (!seg || typeof seg !== 'string') continue;
      if (hasOwn(fired, seg)) continue;

      payload = map[seg];
      if (!isObject(payload)) continue;

      emitExperience(stream, seg, payload);
      fired[seg] = true;
      changed = true;
    }

    if (changed) saveExperienceFired(stream, fired);
  }

  function bufferEvent(stream, payload) {
    var buffer;

    if (!isObject(payload)) return;

    buffer = loadEventBuffer(stream);
    buffer.push({
      event_category: payload.event_category || '',
      event_action: payload.event_action || '',
      event_label: payload.event_label || '',
      event_segment: payload.event_segment || ''
    });
    saveEventBuffer(stream, buffer);
  }

  function flushBufferedEvents(stream) {
    var buffer;
    var i;
    var payload;

    if (!isEmissionEnabled(stream)) return;

    buffer = loadEventBuffer(stream);
    if (!buffer.length) return;

    clearEventBuffer(stream);

    for (i = 0; i < buffer.length; i++) {
      payload = buffer[i];
      if (!isObject(payload)) continue;
      emitEvent(stream, payload);
    }
  }

  function hasUsableVitals(vitals) {
    return (
      isObject(vitals) &&
      (
        typeof vitals.lcp === 'number' ||
        typeof vitals.fcp === 'number' ||
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

    if (!isEmissionEnabled(CONVERSIO_STREAM)) return;

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

    if (isEmissionEnabled(CONVERSIO_STREAM)) {
      emitData(buildDataPayload(vitals));
    } else {
      bufferData(vitals);
    }
  }

  function flushAllStreams() {
    var i;

    for (i = 0; i < STREAMS.length; i++) {
      flushUnfiredExperiences(STREAMS[i]);
      flushBufferedEvents(STREAMS[i]);
    }

    flushPendingData();
  }

  function enableEmission() {
    setEmissionEnabled(true);
    flushAllStreams();
  }

  function disableEmission() {
    setEmissionEnabled(false);
  }

  function startedHidden(visibilityAtStart) {
    var entries;
    var i;

    try {
      entries = window.performance.getEntriesByType('visibility-state');
      for (i = 0; i < entries.length; i++) {
        if (entries[i].startTime === 0) return entries[i].name === 'hidden';
      }
    } catch (e) {
    }

    return visibilityAtStart === 'hidden';
  }

  function currentVisibility() {
    try {
      return document.visibilityState || '';
    } catch (e) {
      return '';
    }
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
    var observers = [];
    var finished = false;
    var visibilityAtStart = currentVisibility();
    var paintRetries = 0;

    function safeObserve(type, cb) {
      var obs;
      try {
        obs = new window.PerformanceObserver(cb);
        obs.observe({ type: type, buffered: true });
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

    function grabMissingFromEntries() {
      var entries;
      var i;

      if (lcp === null) {
        try {
          entries = window.performance.getEntriesByType('largest-contentful-paint');
          if (entries && entries.length) lcp = entries[entries.length - 1].startTime;
        } catch (e) { }
      }

      if (fcp === null) {
        try {
          entries = window.performance.getEntriesByType('paint');
          for (i = 0; i < entries.length; i++) {
            if (entries[i].name === 'first-contentful-paint') fcp = entries[i].startTime;
          }
        } catch (e) { }
      }
    }

    function finish() {
      var i;
      var nav;
      var pageLoad;
      var result;

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

      result = {
        lcp: (typeof lcp === 'number') ? lcp : null,
        fcp: (typeof fcp === 'number') ? fcp : null,
        cls: +cls.toFixed(3),
        ps: pageLoad
      };

      if (startedHidden(visibilityAtStart)) result.vis = 0;

      try {
        onDone(result);
      } catch (e) { }
    }

    function finishOrWait() {
      if (finished) return;

      try {
        grabMissingFromEntries();
      } catch (e) { }

      if (lcp === null && fcp === null && paintRetries < VITALS_PAINT_MAX_RETRIES) {
        paintRetries++;
        window.setTimeout(finishOrWait, VITALS_PAINT_RETRY_MS);
        return;
      }

      finish();
    }

    function scheduleFinish() {
      try {
        if ('requestIdleCallback' in window) {
          window.requestIdleCallback(finishOrWait, { timeout: VITALS_IDLE_TIMEOUT_MS });
        } else {
          window.setTimeout(finishOrWait, VITALS_IDLE_TIMEOUT_MS);
        }
      } catch (e) {
        window.setTimeout(finishOrWait, VITALS_IDLE_TIMEOUT_MS);
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

  function processOneExperience(stream, item) {
    var payload;
    var seg;

    if (!isExperienceTrigger(stream, item)) return;
    if (item[stream.experienceFlag]) return;

    item[stream.experienceFlag] = true;
    payload = item[stream.payloadKey];

    seg = persistExperienceIfNew(stream, payload);
    if (!seg) return;

    emitExperienceIfUnfired(stream, seg, payload);
  }

  function processOneEvent(stream, item) {
    var payload;

    if (!isEventTrigger(stream, item)) return;
    if (item[stream.eventFlag]) return;

    item[stream.eventFlag] = true;
    payload = item[stream.payloadKey];

    addUniqueStringToArrayStorage(stream.keyEventList, payload.event_segment);

    if (isEmissionEnabled(stream)) {
      emitEvent(stream, payload);
    } else {
      bufferEvent(stream, payload);
    }
  }

  function processOneItem(item) {
    var i;

    for (i = 0; i < STREAMS.length; i++) {
      processOneExperience(STREAMS[i], item);
      processOneEvent(STREAMS[i], item);
    }
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
  window.__conversioFlushEmission__ = flushAllStreams;

  exposeClientSettings();
  processExistingDataLayer();
  hookPush();

  try {
    initConversioDataEvent();
  } catch (e) {
    try { handleCollectedData(null); } catch (e2) { }
  }

})();
