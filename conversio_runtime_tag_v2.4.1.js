//<script>
// CONVERSIO TAG | Client: XXXXXX : version 2.4.1 - updated 17-08-2026
// Copyright Conversio Ltd. 2026 - Use permitted only under licence.
(function () {
  'use strict';

  // Prevent double initialisation
  var INIT_KEY = '__CONVERSIO_RUNTIME_INIT__';
  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  // Storage keys (sessionStorage unless noted)
  var KEY_EXPERIENCE_MAP        = 'conversioExperienceMap';
  var KEY_EXPERIENCE_LIST       = 'conversioExperienceList';
  var KEY_EXPERIENCE_FIRED      = 'conversioExperienceFired';
  var KEY_EVENT_LIST            = 'conversioEventList';
  var KEY_EVENT_BUFFER          = 'conversioEventBuffer';
  var KEY_EMISSION_ENABLED      = 'conversioEmissionEnabled';
  var KEY_DATA_PENDING          = 'conversioVitalsPending';
  var KEY_VITALS_LATEST         = 'conversio_vitals';

  // Marks a buffered conversio_data payload as present. Needed because a
  // pre-consent payload carries no conversio_id (see getConversioId) and may
  // carry no vitals either, so without a marker an id-only payload would be
  // indistinguishable from an empty storage slot and would never be flushed.
  var PENDING_MARKER            = 'conversio_pending';

  // localStorage, deliberately not sessionStorage: conversio_id has to survive
  // across sessions so a returning browser is recognised as the same one.
  var KEY_CONVERSIO_ID          = 'conversio_id';

  // Outbound emit event names
  var EXPERIENCE_EVENT_NAME     = 'conversio_experience_session';
  var CONVERSIO_EVENT_EMIT_NAME = 'conversio_event_instance';
  var VITALS_EVENT_NAME         = 'conversio_data';

  // The single GA4 event name both emits are sent under, distinguished there by
  // their conversio_category/action/label parameters.
  var GA_EVENT_NAME             = 'conversio_cro';

  // Core Web Vitals collection tuning
  var VITALS_IDLE_TIMEOUT_MS    = 4000;
  var VITALS_HARD_TIMEOUT_MS    = 6000;

  // The shortest interaction latency to ask the responsiveness spec for. The
  // default for the 'event' entry type is 104ms, which would hide every
  // interaction fast enough to be a good one and report no INP for a page that
  // in fact responded well; 16ms is the floor the spec allows, so this asks for
  // everything that can be observed at all.
  var INP_DURATION_THRESHOLD_MS = 16;

  // conversio_id shape: 'con_' + random + '.' + creation time in microseconds.
  // The alphabet is 32 characters so a random byte can be masked to 5 bits
  // rather than reduced modulo, which would skew the character distribution.
  var CONVERSIO_ID_PREFIX       = 'con_';
  var CONVERSIO_ID_RANDOM_LEN   = 16;
  var CONVERSIO_ID_ALPHABET     = 'abcdefghijklmnopqrstuvwxyz234567';
  var CONVERSIO_ID_PATTERN      = /^con_[a-z2-7]{16}\.[0-9]+$/;

  // The finest granularity, in microseconds, that each available clock really
  // resolves: browsers clamp performance.now() (typically to 100us) as a
  // Spectre mitigation, and Date.now() only ever resolves milliseconds. See
  // nowMicroseconds for what becomes of the digits below these.
  var CONVERSIO_ID_PERF_GRAIN_US = 100;
  var CONVERSIO_ID_DATE_GRAIN_US = 1000;

  // Client-level tracking ID (a GA property ID), fixed per client rather than
  // per visitor. The self-hosted loader substitutes this slot at serve time
  // from the client's KV record, which is how one shared bundle still carries
  // per-client configuration. See readTrackingId for what an un-substituted
  // slot means.
  var TRACKING_ID_SLOT          = '@@CONVERSIO_TRACKING_ID@@';

  // Internal per-object processed flags
  var EXPERIENCE_PROCESSED_FLAG = '__conversioExperienceRuntimeProcessed__';
  var EVENT_PROCESSED_FLAG      = '__conversioEventRuntimeProcessed__';

  var dl = window.dataLayer = window.dataLayer || [];

  // Memoised conversio_id for this page load, plus the two guards that keep
  // conversio_data to exactly one occurrence per page load: dataEventProduced
  // stops a second payload being produced at all, and dataEventBuffered marks
  // the buffered payload as belonging to this page load rather than an earlier
  // one in the same session.
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

  // --- client settings ---------------------------------------------------
  // Configuration that belongs to the client, not to the visitor, exposed on
  // window.conversioSettings for later tags to read.
  //
  // Deliberately not behind the emission-consent gate: a tracking ID says
  // nothing about the person browsing, and is public anyway (it appears in the
  // page source of every GA-tagged site). Deliberately kept off the
  // conversio_data payload too, because that event fires late (after CWV
  // collection) and only once consent arrives, so a tag needing the tracking
  // ID at page load could not rely on finding it there.

  function readTrackingId() {
    // Three cases have to read as "not configured": the GTM paste-in copy of
    // this file, which no loader ever rewrites; a client whose KV record
    // carries no trackingId, for whom the loader substitutes an empty string;
    // and a value that is only whitespace.
    //
    // The un-substituted case is detected by looking for the '@@' marker
    // rather than comparing against the placeholder in full, since repeating
    // that literal here would make the loader rewrite this line too. A
    // substituted value never contains '@@'.
    if (TRACKING_ID_SLOT.indexOf('@@') !== -1) return null;
    return TRACKING_ID_SLOT.trim() || null;
  }

  function exposeClientSettings() {
    var settings;
    try {
      settings = window.conversioSettings;
      if (!isObject(settings)) settings = window.conversioSettings = {};
      // Assigned rather than replacing the object, so a later tag that has
      // already put its own keys there keeps them.
      settings.trackingId = readTrackingId();
    } catch (e) {
      // A frozen or otherwise hostile window.conversioSettings must not take
      // the rest of the tag down with it.
    }
  }

  // --- conversio_id ------------------------------------------------------
  // A persistent per-browser identifier. Minted once, kept in localStorage,
  // and reused for as long as it survives there. Every accessor is wrapped
  // because localStorage can throw on read as well as write (blocked cookies,
  // Safari private mode, sandboxed iframes), and an id failure must never
  // stop conversio_data from being produced.
  //
  // The id sits behind the emission gate: it is a persistent identifier, so
  // nothing is read from or written to localStorage until emission is enabled.
  // A visitor who never enables emission leaves no stored id behind at all.

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
      // no CSPRNG available, or typed arrays unsupported
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

  // A non-negative integer below max, drawn from the same source as the random
  // id component. Reduced modulo rather than bit-masked because max here is not
  // a power of two; over a 16-bit draw the residual bias is well under 0.1%,
  // which is immaterial for digits no clock ever measured.
  function randomBelow(max) {
    var bytes = randomBytes(2);
    var n = bytes ? ((bytes[0] << 8) | bytes[1]) : Math.floor(Math.random() * 65536);
    return n % max;
  }

  // Fills in the digits below what a clock can actually resolve. Both clocks
  // read as a floor, so the true time lies somewhere in the grainUs window
  // above the reading; this picks a point inside that window instead of leaving
  // those digits at zero, which is what made every id end in the same '00'. The
  // figure stays microsecond-scale and no further from the truth than the clock
  // itself already is.
  //
  // A reading that already carries detail finer than grainUs is returned
  // untouched, so a browser resolving further than the usual clamp (a
  // cross-origin-isolated context clamps to 5us, not 100us) keeps that
  // precision rather than having it thrown away and re-randomised.
  function fillClockGrain(micros, grainUs) {
    if (micros % grainUs !== 0) return micros;
    return micros + randomBelow(grainUs);
  }

  // Microseconds since the Unix epoch. performance.timeOrigin + performance.now()
  // is preferred for its sub-millisecond resolution, with Date.now() as the
  // fallback. Neither resolves microseconds on its own, so the low-order digits
  // come from fillClockGrain. Uniqueness rests on the random component, not on
  // this clock.
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
      // fall through to the millisecond clock
    }

    return fillClockGrain(Date.now() * 1000, CONVERSIO_ID_DATE_GRAIN_US);
  }

  function mintConversioId() {
    return CONVERSIO_ID_PREFIX + randomIdString(CONVERSIO_ID_RANDOM_LEN) + '.' + nowMicroseconds();
  }

  function getConversioId() {
    var stored;

    // Only ever reached from the emit paths, which are already gated. The
    // guard is here so a future caller cannot mint an id before consent.
    if (!isEmissionEnabled()) return '';

    if (conversioIdCache) return conversioIdCache;

    // A stored value is only reused if it still matches the expected shape, so
    // a truncated or tampered entry is replaced rather than propagated forever.
    stored = readLocalStorage(KEY_CONVERSIO_ID);
    if (stored && CONVERSIO_ID_PATTERN.test(stored)) {
      conversioIdCache = stored;
      return conversioIdCache;
    }

    // If the write fails the id still stands for this page load, so
    // conversio_data always carries one. It just won't persist, and the next
    // page load will mint another.
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

  // --- GA4 delivery ------------------------------------------------------
  // Sends a conversio_cro event to the client's own GA4 property alongside each
  // dataLayer emit. Called only from the two emit functions below, so it
  // inherits their consent gate and their de-duplication: nothing reaches GA
  // that did not also reach the dataLayer, and nothing reaches either before
  // emission is enabled.
  //
  // Routing is the whole difficulty here. A bare gtag('event', ...) goes to
  // every measurement ID configured in that gtag instance, so on a site running
  // more than one GA4 property the event lands in all of them, or in whichever
  // the site configured last. send_to pins it to the one property named in this
  // client's key record.
  //
  // The tag deliberately never calls gtag('config', ...) for that ID. The
  // property belongs to the client and their own tagging already configures it;
  // configuring it again from here could reset their settings or emit a
  // duplicate page_view. If the ID is genuinely not configured on the page the
  // send is dropped by gtag, which is a better failure than interfering with
  // the client's own GA setup.

  function gtagCommand() {
    // gtag.js defines gtag() as precisely this push, so handing the queue a
    // real arguments object is what it expects to find there. An existing
    // window.gtag is preferred because a site that loaded gtag.js under a
    // custom dataLayer name reads a different queue from the one in dl.
    //
    // Where neither has loaded yet, the command still queues: gtag.js
    // processes whatever is already on the dataLayer when it initialises, so
    // an early send is delivered rather than lost.
    if (typeof window.gtag === 'function') {
      window.gtag.apply(null, arguments);
      return;
    }
    dl.push(arguments);
  }

  // The raw stored JSON, matching what a reader of sessionStorage would see
  // rather than a re-serialised copy of it.
  function storedListString(key) {
    var raw = window.sessionStorage ? window.sessionStorage.getItem(key) : null;
    return raw || '[]';
  }

  // hasUsableVitals lives in the conversio_data section below. Vitals are
  // absent from most of these sends by nature: an experience fires when it
  // occurs, which is usually well before Core Web Vitals collection has
  // finished, so an empty result here is the normal early-page case.
  function storedVitalsString() {
    var vitals = loadJsonObject(KEY_VITALS_LATEST);
    if (!hasUsableVitals(vitals)) return '';
    return safeJsonStringify(vitals, '');
  }

  function sendToGa(params) {
    var trackingId = readTrackingId();
    var conversioId;

    // No tracking ID configured for this client: GA delivery is simply off,
    // which is a supported state rather than a failure.
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

    // Best-effort, and always after the dataLayer push: the dataLayer emit is
    // the primary contract and a GA failure must not cost it.
    try {
      params = {
        conversio_category: payload.experience_category || '',
        conversio_action: payload.experience_action || '',
        conversio_label: payload.experience_label || '',
        conversio_segment: seg,
        conversio_experiences: storedListString(KEY_EXPERIENCE_LIST),
        conversio_events: storedListString(KEY_EVENT_LIST)
      };

      // Vitals are attached here and nowhere else. They measure the page load,
      // not the interaction, so the one send per experience carries them once
      // instead of every conversio_event_instance repeating the same block for
      // as many events as a visitor happens to trigger.
      vitals = storedVitalsString();
      if (vitals) params.conversio_vitals = vitals;

      sendToGa(params);
    } catch (e) {
      // ignore
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
        conversio_experiences: storedListString(KEY_EXPERIENCE_LIST),
        conversio_events: storedListString(KEY_EVENT_LIST)
      });
    } catch (e) {
      // ignore
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

  // --- conversio_data ----------------------------------------------------
  // Fires exactly once per page load. conversio_id is always present; the
  // conversio_vitals block is only attached when CWV collection actually
  // produced something. A CWV failure now costs the vitals, not the event.

  // cls is deliberately excluded from this test: it initialises to 0 and stays
  // a number even when nothing was ever observed, so it cannot distinguish a
  // successful collection from a failed one. inp is included, because like lcp,
  // fcp and ps it stays null unless something was genuinely measured, and a page
  // whose one successful measurement is an interaction latency still has vitals
  // worth reporting.
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

  // Called only from the emit paths, never from the buffer path, because it
  // resolves the conversio_id and that must happen post-consent.
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

  // Buffers the vitals only, never a conversio_id: this runs pre-consent, and
  // the id is minted at flush time once the gate is open.
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

    // Only this page load's own payload is ever emitted. Anything left in the
    // slot by an earlier page load in this session is discarded, not emitted:
    // it would arrive attributed to the wrong page, and it would land as a
    // second conversio_data alongside the one this page load produces itself.
    // Discarding also covers the 2.2 payload shape, which by definition can
    // only have come from an earlier page load.
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

    // Store the latest vitals snapshot regardless of the emission gate, as 2.2
    // did, but only when there is something real to store. This snapshot holds
    // no identifier and lives in sessionStorage, so it stays outside the gate.
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
    // interactionId -> the longest event duration seen for that interaction.
    // See the 'event' observer below for why INP is accumulated this way.
    var interactions = {};
    var observers = [];
    var finished = false;

    function safeObserve(type, cb, durationThreshold) {
      var obs;
      var spec = { type: type, buffered: true };

      // Only the 'event' type takes a threshold. A browser that does not know
      // the option ignores it, and one that does not know the type throws on
      // observe() and is caught below, so neither needs a feature test.
      if (typeof durationThreshold === 'number') spec.durationThreshold = durationThreshold;

      try {
        obs = new window.PerformanceObserver(cb);
        obs.observe(spec);
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

    // INP (Interaction to Next Paint), Google's stable responsiveness metric.
    //
    // One interaction produces several event entries sharing an interactionId
    // (a tap fires pointerdown, pointerup and click), and the interaction's
    // latency is the longest of them, so durations are accumulated per
    // interactionId rather than per entry. An interactionId of 0 means the
    // event was never part of an interaction at all, a scroll or a mousemove,
    // and is skipped: a slow one would otherwise be reported as an interaction
    // latency that no visitor ever waited on.
    //
    // The limit worth knowing: collection closes a few seconds after load (see
    // VITALS_IDLE_TIMEOUT_MS), so this is the worst interaction latency in that
    // early window, not for the whole page life as Google's own field data
    // measures it. Early is where responsiveness is usually at its worst, the
    // main thread still being busy, so the window does catch the bad cases; a
    // page with no interaction inside it reports inp as null.
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
      } catch (e) { /* ignore malformed entries */ }
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

    // Google's INP is the worst interaction latency on the page, discounting
    // one interaction per 50 so that a single outlier does not define a heavily
    // interacted page. Below 50 interactions, which is all a few seconds of
    // collection can realistically see, that rule reduces to simply the worst.
    // The discount counts observed interactions, so an interaction too fast to
    // be reported at all does not shift the index.
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
          inp: worstInteraction(),
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

  function initConversioDataEvent() {
    if (!isPerformanceApiSupported()) {
      // No CWV support at all: still produce conversio_data, id only.
      handleCollectedData(null);
      return;
    }

    try {
      collectWebVitals(function (vitals) {
        try {
          handleCollectedData(vitals);
        } catch (e) { /* never let CWV handling affect the runtime tag */ }
      });
    } catch (e) {
      // Collection could not even be scheduled: fall back to an id-only event
      // so conversio_data is still present for this page load.
      try { handleCollectedData(null); } catch (e2) { /* ignore */ }
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
    flushPendingData();
  };

  // Bootstrap
  // Settings go up first, before any dataLayer processing, so a tag triggered
  // by the events below can already read window.conversioSettings.
  exposeClientSettings();
  processExistingDataLayer();
  hookPush();

  // Core Web Vitals tracking is strictly best-effort: it runs after the
  // core dataLayer plumbing above is already live, and any failure here
  // is swallowed so it can never block or break tag initialisation.
  // conversio_data itself is not best-effort, so if init fails outright we
  // still fall back to producing the id-only event.
  try {
    initConversioDataEvent();
  } catch (e) {
    try { handleCollectedData(null); } catch (e2) { /* ignore */ }
  }

})();
// Copyright Conversio Ltd. 2026 - Use permitted only under licence.
//</script>
