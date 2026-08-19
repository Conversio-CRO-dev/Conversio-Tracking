//<script>
// CONVERSIO TAG | Client: XXXXXX : version 2.5 - updated 19-08-2026
// Copyright Conversio Ltd. 2026 - Use permitted only under licence.
(function () {
  'use strict';

  // Prevent double initialisation
  var INIT_KEY = '__CONVERSIO_RUNTIME_INIT__';
  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  // Storage keys for the once-per-page-load data event (sessionStorage). Every
  // experience- and event-shaped key belongs to one stream or the other, so
  // those live on the stream descriptors below rather than here.
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

  // The outbound name of the data event. It belongs to neither stream below:
  // there is one conversio_data per page load, carrying the conversio_id and the
  // vitals, and no client-namespaced counterpart to it.
  var VITALS_EVENT_NAME         = 'conversio_data';

  // --- the two streams ---------------------------------------------------
  // This tag runs the same machinery twice over. CONVERSIO_STREAM is ours,
  // driven by the dataLayer events a Conversio experience pushes. CLIENT_STREAM
  // is the client's own, driven by events they push themselves, so they can
  // report their experiences and events through this tag and have them arrive in
  // GA4 shaped exactly like ours.
  //
  // Everything from the trigger onwards is identical, so the two are driven by
  // one set of functions taking a descriptor rather than by two parallel code
  // paths that would drift apart as one of them was maintained. What a stream
  // owns is its names and its storage, and it shares neither: a segment reported
  // to one is invisible to the other, each keeps its own map, list, fired set
  // and buffer, and clearing one stream's storage by hand leaves the other
  // running.
  //
  // carriesIdentity marks the two things only our own stream has. The
  // conversio_id identifies the visitor to us and the vitals measure the page
  // load; neither is the client's to report through their own events, so a
  // client send carries neither and there is no client_id or client_data
  // anywhere in this file.
  //
  // On the trigger names: both streams accept the snake_case name the naming is
  // moving to, and the Conversio stream also accepts the camelCase name every
  // client container pushes today, so a container moves over whenever it does,
  // with no coordinated release and no version pin. The client stream is new and
  // has no legacy name to accept.
  //
  // What a container must not do is push two accepted names for the same
  // occurrence. Experiences would survive it, being de-duplicated by segment,
  // but an event is one instance per push and a second push is a second
  // instance: see processOneEvent, where the processed flag guards the same
  // object reaching the queue twice rather than two pushes of one interaction.
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

  // Every dataLayer item is offered to both streams. An item matches at most
  // one of them, an accepted event name belonging to one stream only.
  var STREAMS = [CONVERSIO_STREAM, CLIENT_STREAM];

  // GA4 event parameters are plain strings capped at 100 characters, so the
  // three that carry more than one value go out as delimited lists rather than
  // as JSON. Two reasons: nothing downstream parses a GA4 parameter as JSON, so
  // the brackets, braces and the pair of quotes around every entry are
  // punctuation no reader wants; and on the segment lists that punctuation is
  // six characters per entry of a budget that decides how many entries survive
  // the truncation at all.
  var PARAM_LIST_DELIMITER      = ',';
  var PARAM_PAIR_DELIMITER      = ':';

  // The vitals reported in the parameter, in this order, each rounded to the
  // decimals worth keeping. An unrounded paint timing can read 1234.5999999046326
  // and spend a fifth of the character budget on precision the clock never had,
  // browsers clamping these to 100us. Milliseconds are pointless past one
  // decimal; cls is unitless and small, so it keeps three. The dataLayer copy on
  // conversio_data carries the raw numbers, so nothing is lost by rounding here.
  var VITALS_PARAMS = [
    { key: 'lcp', decimals: 1 },
    { key: 'fcp', decimals: 1 },
    { key: 'cls', decimals: 3 },
    { key: 'ps', decimals: 0 }
  ];

  // Core Web Vitals collection tuning
  var VITALS_IDLE_TIMEOUT_MS    = 4000;
  var VITALS_HARD_TIMEOUT_MS    = 6000;

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
  // window.conversioSettings for later tags to read. 'Client' here is the
  // Conversio client whose container this is, which is who a tracking ID belongs
  // to, rather than CLIENT_STREAM above: both streams send to this one property.
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
    // guard is here so a future caller cannot mint an id before consent. Our
    // own gate, the id being ours: a client send never reaches this at all.
    if (!isEmissionEnabled(CONVERSIO_STREAM)) return '';

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

  // Consent is a fact about the visitor rather than about a stream, so the one
  // control opens and closes both: a client's consent platform calls
  // __conversioEnableEmission__ as it does today and their own stream opens
  // alongside ours, rather than staying shut until a second call is wired up
  // and losing every client event until someone notices. The state is still
  // stored per stream, so neither reads the other's key.
  function setEmissionEnabled(value) {
    var i;

    if (!window.sessionStorage) return;

    for (i = 0; i < STREAMS.length; i++) {
      window.sessionStorage.setItem(STREAMS[i].keyEmissionEnabled, value ? 'true' : 'false');
    }
  }

  // A dataLayer item is a trigger for a stream when its event name is one that
  // stream accepts and it carries that stream's own payload object. The payload
  // key is part of the match, so a client_experience carrying a conversio
  // payload is not a trigger and neither is the reverse: the streams stay
  // separate on the way in as well as on the way out. The name is compared in a
  // loop rather than with indexOf so the match stays available on a browser old
  // enough to reach this tag without the ES5 array methods.
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

  // --- GA4 delivery ------------------------------------------------------
  // Sends one event to the client's own GA4 property alongside each dataLayer
  // emit: conversio_cro for our stream, client_cro for theirs, so a client's
  // own reporting never lands in the middle of ours. Called only from the two
  // emit functions below, so it inherits their consent gate and their
  // de-duplication: nothing reaches GA that did not also reach the dataLayer,
  // and nothing reaches either before emission is enabled.
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

  // A stored segment list as a delimited string. Only strings are joined:
  // everything this tag puts in these lists is one, and a hand-edited
  // sessionStorage entry holding anything else would otherwise land in the
  // parameter as '[object Object]'. An empty list is an empty parameter.
  function storedListParam(key) {
    var list = loadJsonArray(key);
    var out = [];
    var i;

    for (i = 0; i < list.length; i++) {
      if (list[i] && typeof list[i] === 'string') out.push(list[i]);
    }

    return out.join(PARAM_LIST_DELIMITER);
  }

  // hasUsableVitals lives in the conversio_data section below. Vitals are
  // absent from most of these sends by nature: an experience fires when it
  // occurs, which is usually well before Core Web Vitals collection has
  // finished, so an empty result here is the normal early-page case.
  //
  // A measurement that failed is left out rather than sent as a null: absent and
  // null tell a reader the same thing, and only one of them costs characters.
  // Non-finite values are dropped for the same reason JSON turned them into
  // null, since 'lcp:NaN' is worse than no lcp at all.
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

    // No tracking ID configured for this client: GA delivery is simply off,
    // which is a supported state rather than a failure. Both streams send to
    // this one property, it being the client's own either way.
    if (!trackingId) return;

    params.send_to = trackingId;

    // The conversio_id identifies the visitor to us, so it rides with our own
    // stream only and a client send carries no identifier at all.
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

    // Best-effort, and always after the dataLayer push: the dataLayer emit is
    // the primary contract and a GA failure must not cost it.
    try {
      params = {};
      params[prefix + 'category'] = payload.experience_category || '';
      params[prefix + 'action'] = payload.experience_action || '';
      params[prefix + 'label'] = payload.experience_label || '';
      params[prefix + 'segment'] = seg;
      params[prefix + 'experiences'] = storedListParam(stream.keyExperienceList);
      params[prefix + 'events'] = storedListParam(stream.keyEventList);

      // Vitals are attached here and nowhere else, and on our own stream only.
      // They measure the page load, not the interaction, so the one send per
      // experience carries them once instead of every event emit repeating the
      // same block for as many events as a visitor happens to trigger.
      if (stream.carriesIdentity) {
        vitals = storedVitalsParam();
        if (vitals) params[prefix + 'vitals'] = vitals;
      }

      sendToGa(stream, params);
    } catch (e) {
      // ignore
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
      // ignore
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

  // --- conversio_data ----------------------------------------------------
  // Fires exactly once per page load. conversio_id is always present; the
  // conversio_vitals block is only attached when CWV collection actually
  // produced something. A CWV failure now costs the vitals, not the event.

  // cls is deliberately excluded from this test: it initialises to 0 and stays
  // a number even when nothing was ever observed, so it cannot distinguish a
  // successful collection from a failed one.
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

    if (!isEmissionEnabled(CONVERSIO_STREAM)) return;

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

    if (isEmissionEnabled(CONVERSIO_STREAM)) {
      emitData(buildDataPayload(vitals));
    } else {
      bufferData(vitals);
    }
  }

  // Everything the consent gate was holding, in both streams, plus the data
  // event. Each flush re-checks its own gate, so this is safe to call at any
  // time and is what the public flush control points at.
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

  // --- Core Web Vitals (CWV) tracking -----------------------------------
  // Best-effort only: any failure here must never affect dataLayer
  // processing above, and must never delay it. All entry points are
  // wrapped in try/catch and every wait has a hard timeout fallback.
  //
  // lcp, fcp, cls and the page load time. Deliberately not INP, which 2.4.1
  // collected and 2.4.2 removed: responsiveness is a property of the page's own
  // main-thread work rather than of anything an experience changes, so the
  // figure moved with whatever else a client shipped and never with us, and the
  // few seconds of collection here only caught the pages whose visitor happened
  // to interact that early, so it read null more often than not.

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

  // Public gate controls
  window.__conversioEnableEmission__ = enableEmission;
  window.__conversioDisableEmission__ = disableEmission;
  window.__conversioFlushEmission__ = flushAllStreams;

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
