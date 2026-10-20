//<script>
// CONVERSIO TAG | Client: XXXXXX : version 2.6.5 - updated 20-10-2026
// Copyright Conversio Ltd. 2026 - Use permitted only under licence.
(function () {
  'use strict';

  // Which bundle this is. Kept in step with the header above by
  // build-bundle.mjs, which refuses to build a bundle whose constant and header
  // disagree, since a version marker that lies is worse than none: it is read
  // at exactly the moment someone has stopped trusting what they can see.
  var TAG_VERSION = '2.6.5';

  // When this version was cut, ISO 8601 and taken from the same header line by
  // the same build guard. Deliberately not the header's DD-MM-YYYY: this one is
  // read by clients rather than by us, and a date that can be read as 10
  // September instead of 9 October defeats the purpose of publishing it.
  //
  // Fixed per version and identical for every client. What it does NOT say is
  // when this client started being served it, which is the question a client
  // actually asks and which DEPLOYED_AT_SLOT below answers.
  var VERSION_RELEASED = '2026-10-20';

  // Prevent double initialisation
  var INIT_KEY = '__CONVERSIO_RUNTIME_INIT__';
  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  // Storage keys for the once-per-page-load data event. Every experience- and
  // event-shaped key belongs to one stream or the other, so those live on the
  // stream descriptors below rather than here.
  //
  // Which store a key is read from and written to is no longer fixed: from
  // 2.6.5 every one of them lands in the pre-consent buffer while the gate is
  // shut and in sessionStorage once it is open. See preConsentStore below.
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
  // That is the event name only. The four fields inside the payload have a
  // camelCase spelling of their own, which both streams accept: see
  // EXPERIENCE_FIELDS and EVENT_FIELDS below.
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
    { key: 'ps', decimals: 0 },
    { key: 'vis', decimals: 0 }
  ];

  // Core Web Vitals collection tuning
  var VITALS_IDLE_TIMEOUT_MS    = 4000;
  var VITALS_HARD_TIMEOUT_MS    = 6000;

  // How long to keep waiting when nothing has painted yet, and how many times.
  // A page loaded into a background tab does not paint until the visitor looks
  // at it, which can be after its load event: closing collection on the first
  // idle period after load then measures a page that has not drawn a pixel and
  // reports lcp and fcp as null. While no paint has been recorded the close is
  // deferred and re-tried, which costs a later conversio_data on those loads and
  // nothing at all on a page that has already painted. Ten tries at 500ms sits
  // inside VITALS_HARD_TIMEOUT_MS, which fires independently and closes
  // collection regardless, so this can never hold the event indefinitely.
  var VITALS_PAINT_RETRY_MS     = 500;
  var VITALS_PAINT_MAX_RETRIES  = 10;

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

  // The date this client's key was last pointed at a new version, substituted
  // from their KV record by the same mechanism as the tracking ID above.
  //
  // Per client rather than per version, and that is the whole point of it.
  // VERSION_RELEASED says when this bundle was built, which is the same answer
  // for everyone and says nothing about when a particular site changed. This
  // says when THIS site changed, which is what a client checking that nothing
  // shipped outside an agreed window is actually asking.
  var DEPLOYED_AT_SLOT          = '@@CONVERSIO_DEPLOYED_AT@@';

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

  // --- the pre-consent buffer --------------------------------------------
  // Everything this tag buffers while the consent gate is shut is held here, in
  // memory, and nothing reaches sessionStorage until the visitor has consented.
  // 2.6.4 buffered into sessionStorage instead, which is the one thing this
  // version changes.
  //
  // The reason is PECR reg 6, and ePrivacy Article 5(3) behind it: what those
  // regulate is the act of storing information on a visitor's device, or
  // reading what is already there, whether or not that information identifies
  // anyone. A buffer carrying no conversio_id is a good answer to a data
  // protection question and no answer at all to this one, so the buffer moves
  // off the device rather than being argued for.
  //
  // What that costs is the page loads before the one where consent arrives.
  // Memory does not survive a navigation, so a visitor who sees an experience
  // on page one, leaves the banner alone, and accepts on page four is reported
  // from page four. 2.6.4 released all four. There is no way to keep the
  // earlier pages that does not involve writing to the device, which is the
  // thing being objected to, so this is a deliberate loss rather than a gap to
  // close later.
  //
  // Strings rather than parsed objects, under the same keys sessionStorage
  // would have used. Callers load a value, mutate it and save it back, and the
  // round trip through JSON is what makes the mutation land at the save rather
  // than at the mutation; handing back a live reference would change when every
  // one of those writes takes effect.
  var preConsentStore = {};

  // Consent is a fact about the visitor rather than about a stream, so one
  // answer covers the whole buffer. Both stream keys are written together by
  // setEmissionEnabled and so agree in every session this tag produces itself;
  // the loop is for the mid-upgrade session, where only ours is seeded.
  //
  // Read live on every access rather than cached, because the gate moves during
  // a page load: this is false while the page is being read and true a moment
  // later when the consent platform calls in, and a cached answer would send
  // the flush to the store the buffer had just been emptied out of.
  function hasConsent() {
    var i;

    for (i = 0; i < STREAMS.length; i++) {
      if (isEmissionEnabled(STREAMS[i])) return true;
    }

    return false;
  }

  // The two functions every stored value in this tag passes through, and the
  // only place that decides which of the two backing stores it lands in. The
  // emission flag itself does not come through here: it is the record of the
  // consent decision, written only when one is made, and routing it through a
  // store whose choice depends on reading it would be circular.
  function readStoredString(key) {
    if (!hasConsent()) {
      return hasOwn(preConsentStore, key) ? preConsentStore[key] : null;
    }

    if (!window.sessionStorage) return null;
    return window.sessionStorage.getItem(key);
  }

  function writeStoredString(key, value) {
    if (!hasConsent()) {
      preConsentStore[key] = String(value);
      return;
    }

    if (!window.sessionStorage) return;
    window.sessionStorage.setItem(key, value);
  }

  function loadJsonObject(key) {
    var raw = readStoredString(key);
    var obj = raw ? safeJsonParse(raw, {}) : {};
    if (!isObject(obj) || isArray(obj)) obj = {};
    return obj;
  }

  function saveJsonObject(key, obj) {
    writeStoredString(key, safeJsonStringify(obj, '{}'));
  }

  function loadJsonArray(key) {
    var raw = readStoredString(key);
    var arr = raw ? safeJsonParse(raw, []) : [];
    if (!isArray(arr)) arr = [];
    return arr;
  }

  function saveJsonArray(key, arr) {
    writeStoredString(key, safeJsonStringify(arr, '[]'));
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
  //
  // 2.6.4 adds three provenance fields beside it: which version is running,
  // when that version was cut, and when this client was moved onto it. They are
  // here so a client can see on any page load what we are serving them and
  // since when, rather than taking our word for it after the fact.
  //
  // Worth being straight about what that is and is not. We control both the
  // values and the serving, so this is not proof of anything to someone who has
  // decided we are lying. What it does do is make an unannounced change
  // VISIBLE, where previously nothing on the page distinguished one version
  // from another, and let a client record the values in their own analytics on
  // every page load. That record is theirs, not ours, and it is the part that
  // actually turns this into assurance.

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

  // Same three cases as readTrackingId, for the same reasons, including the
  // '@@' test standing in for a comparison against the placeholder in full.
  //
  // A null here is not an error and must not be dressed up as one. The GTM
  // paste-in copy of this file is never rewritten by any loader, and a client
  // on the self-hosted loader whose record predates this field has nothing to
  // substitute. Both are correctly "we cannot tell you", and inventing a date
  // for either would be the one failure this field exists to prevent.
  function readDeployedAt() {
    if (DEPLOYED_AT_SLOT.indexOf('@@') !== -1) return null;
    return DEPLOYED_AT_SLOT.trim() || null;
  }

  function exposeClientSettings() {
    var settings;
    try {
      settings = window.conversioSettings;
      if (!isObject(settings)) settings = window.conversioSettings = {};
      // Assigned rather than replacing the object, so a later tag that has
      // already put its own keys there keeps them.
      settings.trackingId = readTrackingId();
      // Constants in the file rather than anything the loader substitutes, so
      // they answer for the pasted-inline copy too, where no loader has ever
      // run and every slot above reads as unconfigured.
      settings.version = TAG_VERSION;
      settings.versionReleased = VERSION_RELEASED;
      settings.deployedAt = readDeployedAt();
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

  // Removed rather than written as an empty array. From 2.6.5 a buffer only
  // ever fills while the gate is shut, which now means in memory, so the
  // sessionStorage entry behind this key can hold nothing but the empty value a
  // clear put there: promotion copies the buffer across on consent and the
  // flush below empties it in the same call. Leaving '[]' on the device would
  // be a key that is only ever a record of there being nothing to record.
  //
  // Safe to go straight to the device rather than through the facade because
  // this is reached only from flushBufferedEvents, which returns early unless
  // the gate is open. A caller that ran it with the gate shut would clear the
  // sessionStorage entry and leave the memory buffer holding the events, so
  // keep that ordering if this ever gains a second caller.
  function clearEventBuffer(stream) {
    removeStoredKey(stream.keyEventBuffer);
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
  //
  // The one thing in this tag that writes to sessionStorage directly rather
  // than through the facade above, and the one thing still written at all on a
  // visitor who has not consented. Both are deliberate. This is reached only
  // from enableEmission and disableEmission, which are reached only when a
  // consent platform signals a decision, so what is recorded here is the
  // decision itself and nothing about what the visitor did: before the first
  // signal arrives the key does not exist, and a client auditing storage on a
  // page they have not answered the banner on finds it empty. Routing it
  // through a facade whose choice of store depends on reading it would also be
  // circular.
  //
  // Dropping the granted key too, and treating its absence as 'false', has been
  // raised and would work, at the cost of making every page load depend on the
  // consent platform re-signalling: today a signal missed on page three costs
  // nothing because the key still reads true, and without it that page reports
  // nothing at all. See promotePreConsentStore, which is written to survive
  // that change. That is a different question from the refusal below, where
  // there is nothing to lose by removing the key, the gate being shut by
  // default either way.
  // A grant writes the key; a withdrawal removes it rather than writing
  // 'false'. isEmissionEnabled is the only reader and tests for the string
  // 'true', so an absent key and a 'false' one are the same shut gate to
  // everything in this tag: the gate's default is shut, and the tag needs no
  // record of a refusal in order to honour one. Writing 'false' would leave two
  // keys on the device of a visitor who had just said no, to no end, which is
  // the opposite of what the rest of this version is for. The platform that
  // asked the question keeps the record of the answer; this tag does not need a
  // second copy of it.
  //
  // So 'true' is the only value this key ever holds, and the only write this
  // tag makes to an unconsented visitor's device is the removal below.
  function setEmissionEnabled(value) {
    var i;

    if (!window.sessionStorage) return;

    for (i = 0; i < STREAMS.length; i++) {
      if (value) {
        window.sessionStorage.setItem(STREAMS[i].keyEmissionEnabled, 'true');
      } else {
        removeStoredKey(STREAMS[i].keyEmissionEnabled);
      }
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

  // A payload carries four fields, and each of them answers to two names: the
  // snake_case one this tag reads throughout, and the camelCase one legacy
  // campaigns push. The camelCase spelling predates the naming this tag settled
  // on and is still nested under the stream's payload key exactly as the
  // snake_case one is, so what differs between an old campaign and a new one is
  // the four keys inside that object and nothing else about the push.
  //
  // Accepting both is what lets a campaign written years ago keep reporting
  // through a tag upgraded underneath it. A campaign live on a client's site is
  // not something anyone can go back and re-key: it is running, it is
  // collecting, and rewriting its snippet to take a tag version would risk the
  // results it exists to produce. So the tag learns the older name instead.
  //
  // The canonical name wins wherever it carries a value and the legacy name is
  // read only where it does not, which is the fallback the rest of this file
  // already writes as `payload.experience_category || ''`. A payload carrying
  // neither spelling still reads as the empty string. That makes this a
  // no-op for every container pushing snake_case today: same reads, same
  // result, whether or not a legacy key is anywhere near the push.
  var EXPERIENCE_FIELDS = [
    { name: 'experience_segment',  legacy: 'experienceSegment' },
    { name: 'experience_category', legacy: 'experienceCategory' },
    { name: 'experience_action',   legacy: 'experienceAction' },
    { name: 'experience_label',    legacy: 'experienceLabel' }
  ];

  var EVENT_FIELDS = [
    { name: 'event_segment',  legacy: 'eventSegment' },
    { name: 'event_category', legacy: 'eventCategory' },
    { name: 'event_action',   legacy: 'eventAction' },
    { name: 'event_label',    legacy: 'eventLabel' }
  ];

  // Both streams normalise, though only ours has legacy campaigns behind it.
  // The client stream is new and nothing has ever pushed camelCase at it, so
  // the compatibility is dead weight there; it is carried anyway because
  // processOneExperience and processOneEvent are one code path taking a stream
  // descriptor, and gating this on carriesIdentity or on a new descriptor key
  // would split that path to withhold something nobody is pushing. One shape of
  // payload reaches the rest of this file, whichever stream it arrived on.
  //
  // Normalisation happens once, where a pushed item is first read, so nothing
  // downstream knows a second spelling exists: the experience map, the event
  // buffer and both emits are built from the canonical names exactly as they
  // were, and a payload restored from storage on a later page needs no second
  // pass. It also means the outbound shape is untouched. A legacy campaign's
  // push is normalised on the way in and emitted under the snake_case names, so
  // a client's downstream tags keep reading the one spelling they read today
  // rather than gaining a second one to handle.
  //
  // A new object rather than the pushed one, which belongs to the container:
  // this tag marks an item it has processed but does not rewrite the keys a
  // campaign put there, and a payload held in the map outlives the push it came
  // from.
  function readPayload(payload, fields) {
    var out = {};
    var i;

    for (i = 0; i < fields.length; i++) {
      out[fields[i].name] = payload[fields[i].name] || payload[fields[i].legacy] || '';
    }

    return out;
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

  // Removed rather than written as an empty object, for the reason
  // clearEventBuffer is, and reached only from flushPendingData, which gates on
  // the same thing flushBufferedEvents does.
  function clearPendingData() {
    removeStoredKey(KEY_DATA_PENDING);
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
    // did, but only when there is something real to store. The snapshot holds
    // no identifier, so the gate still does not decide whether it is kept. From
    // 2.6.5 it decides where: pre-consent this lands in the in-memory buffer
    // rather than in sessionStorage, so a visitor who never consents leaves
    // nothing behind on the device, measurement of their page load included.
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

  // Consent granted, so what the buffer is holding moves to sessionStorage
  // before anything is flushed. After this the gate is open, the facade above
  // points at the session's own storage, and every read from the flush onwards
  // sees exactly what 2.6.4 would have put there; a page load that arrives with
  // the gate already open buffers nothing and promotes nothing.
  //
  // Merged into what is already stored rather than written over it. The
  // experience map and the two segment lists accumulate across a session and
  // are read back into every GA send, so an earlier page load's entries have to
  // survive this. As the tag stands only the first page load of a session ever
  // promotes anything, the gate being open at init from then on, and there is
  // never anything there to overwrite. That stops being true the moment the
  // emission flag is not persisted and every page load starts shut, which is a
  // live question at the time of writing: a promotion that clobbered the
  // session would lose the attribution list rather than fail, and nothing
  // downstream could tell afterwards.
  //
  // Stored entries win on a collision, being the earlier ones, which is the
  // rule persistExperienceIfNew already applies within a page load.
  function promotePreConsentStore() {
    var buffered = preConsentStore;
    var key;

    // Detached before anything is written rather than emptied after. Every
    // write below goes through the facade, which now reads the gate as open and
    // so writes to sessionStorage, and leaving the old object in place would
    // keep a copy of what the visitor did before consenting alive in memory for
    // the rest of the page.
    preConsentStore = {};

    for (key in buffered) {
      if (!hasOwn(buffered, key)) continue;
      promoteOneValue(key, safeJsonParse(buffered[key], null));
    }
  }

  // One buffered value, merged into whatever the session already holds under
  // that key. Shape decides the merge, there being only two in the buffer: the
  // segment lists are arrays and everything else is an object.
  function promoteOneValue(key, value) {
    var stored;
    var i;
    var name;

    if (isArray(value)) {
      stored = loadJsonArray(key);

      for (i = 0; i < value.length; i++) {
        if (!arrayHas(stored, value[i])) stored.push(value[i]);
      }

      saveJsonArray(key, stored);
      return;
    }

    if (isObject(value)) {
      stored = loadJsonObject(key);

      for (name in value) {
        if (!hasOwn(value, name)) continue;
        if (hasOwn(stored, name)) continue;
        stored[name] = value[name];
      }

      saveJsonObject(key, stored);
      return;
    }

    // Neither, so it is not something this tag put there: nothing in the buffer
    // is written as anything but an object or an array. Left alone rather than
    // promoted as-is, since the stored value is the one the rest of the tag can
    // read back.
  }

  function enableEmission() {
    setEmissionEnabled(true);
    promotePreConsentStore();
    flushAllStreams();
  }

  // Direct rather than through the facade above, which picks its store by
  // reading the gate: this has to remove what is on the device whatever the
  // gate happens to say at the time.
  function removeStoredKey(key) {
    try {
      if (!window.sessionStorage) return;
      window.sessionStorage.removeItem(key);
    } catch (e) {
      // A browser that will not let us remove a key is one there is nothing
      // further to do about, and a throw here would cost the rest of the
      // withdrawal below.
    }
  }

  function removeConversioId() {
    try {
      if (!window.localStorage) return;
      window.localStorage.removeItem(KEY_CONVERSIO_ID);
    } catch (e) {
      // Guarded like every other localStorage access in this tag: it throws on
      // read as readily as on write where cookies are blocked.
    }
  }

  // Consent withdrawn, so what was written while it stood is removed. Up to
  // 2.6.4 nothing was: the gate closing stopped new data and left everything
  // already stored where it was, conversio_id included.
  //
  // That is half an answer once the buffer has moved off the device. The point
  // of 2.6.5 is that nothing reaches storage before the visitor agrees, and a
  // withdrawal that left the identifier behind would be the same question asked
  // from the other end. conversio_id is the first thing to go, being the one
  // thing this tag stores that is genuinely persistent and cross-session: it
  // outlives the tab, where everything else here dies with the session.
  //
  // The memory buffer is emptied as well, for the visitor who refuses without
  // ever having granted. Nothing of theirs is on the device to remove, and what
  // they did before refusing should not sit in memory waiting for a grant that
  // would release it.
  function clearStoredState() {
    var i;
    var stream;

    preConsentStore = {};
    dataEventBuffered = false;

    removeStoredKey(KEY_DATA_PENDING);
    removeStoredKey(KEY_VITALS_LATEST);

    for (i = 0; i < STREAMS.length; i++) {
      stream = STREAMS[i];
      removeStoredKey(stream.keyExperienceMap);
      removeStoredKey(stream.keyExperienceList);
      removeStoredKey(stream.keyExperienceFired);
      removeStoredKey(stream.keyEventList);
      removeStoredKey(stream.keyEventBuffer);
    }

    removeConversioId();
  }

  // Order-independent, deliberately. Closing the gate repoints the facade at the
  // memory buffer, so a clear written in terms of saveJsonObject and friends
  // would have to run before setEmissionEnabled and would quietly stop working
  // the day someone swapped the two lines, emptying the buffer and leaving the
  // device exactly as the visitor found it. removeStoredKey and
  // removeConversioId go straight to the two stores instead, so this removes
  // what is there whichever way the gate reads and in whichever order the two
  // are called.
  //
  // setEmissionEnabled below removes the two emission keys rather than writing
  // 'false' into them, so a withdrawal leaves sessionStorage empty outright.
  // An earlier draft of this version kept them, on the reasoning that they were
  // the record of the decision and that losing them would read as 'never asked'
  // and let collection restart. That was wrong: 'never asked' is a shut gate
  // too, so the two states are indistinguishable to every reader here, and the
  // keys bought nothing in exchange for being left behind.
  function disableEmission() {
    clearStoredState();
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
  //
  // Plus vis, which is a marker rather than a measurement, and is why a null
  // paint timing can now be read. A page that loads in a background tab does
  // not paint until the visitor looks at it, so its paint timings are anchored
  // to that moment rather than to navigation, and browsers report no LCP for
  // such a load at all. vis:0 says the load started hidden, so a null lcp there
  // means it could not be measured rather than that measuring it failed, and
  // those loads can be filtered out of an average they would otherwise skew.
  // A load that started visible carries no marker, being the norm, exactly as a
  // measurement that succeeded carries none.

  // The visibility-state entries are the authoritative record where a browser
  // keeps them, since they say what the state was at navigation rather than at
  // whenever this tag happened to run. Only the entry at time zero answers the
  // question; a later one is a change the visitor made. Where there are none,
  // the reading taken when collection started is the best available answer, and
  // collection starts at tag init, which on a normal page is before first paint.
  function startedHidden(visibilityAtStart) {
    var entries;
    var i;

    try {
      entries = window.performance.getEntriesByType('visibility-state');
      for (i = 0; i < entries.length; i++) {
        if (entries[i].startTime === 0) return entries[i].name === 'hidden';
      }
    } catch (e) {
      // no visibility-state entries in this browser
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

    // A last look for anything the observers have not delivered, by entry type
    // rather than by walking the whole timeline: getEntries() carries the paint
    // entries but not the largest-contentful-paint ones, so the old scan for the
    // latter could never have found it. Asking for the type directly works
    // wherever a browser does expose it and costs nothing where it does not,
    // which is the honest way to write a fallback for something whose exposure
    // differs between browsers.
    function grabMissingFromEntries() {
      var entries;
      var i;

      if (lcp === null) {
        try {
          entries = window.performance.getEntriesByType('largest-contentful-paint');
          if (entries && entries.length) lcp = entries[entries.length - 1].startTime;
        } catch (e) { /* type not exposed here */ }
      }

      if (fcp === null) {
        try {
          entries = window.performance.getEntriesByType('paint');
          for (i = 0; i < entries.length; i++) {
            if (entries[i].name === 'first-contentful-paint') fcp = entries[i].startTime;
          }
        } catch (e) { /* type not exposed here */ }
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

      result = {
        lcp: (typeof lcp === 'number') ? lcp : null,
        fcp: (typeof fcp === 'number') ? fcp : null,
        cls: +cls.toFixed(3),
        ps: pageLoad
      };

      // Marked only when there is something to mark, so the parameter carries
      // the flag on the loads it explains and nothing on the rest.
      if (startedHidden(visibilityAtStart)) result.vis = 0;

      try {
        onDone(result);
      } catch (e) { /* consumer failure must not throw back into observers */ }
    }

    // Closes collection, unless nothing has painted yet and there are tries
    // left, in which case it waits and asks again. The entries are consulted
    // rather than only the observer variables, so a paint the observer has not
    // yet delivered still counts as painted and nothing is waited for twice.
    //
    // A page that never paints at all, a background tab the visitor never
    // opens, is held for the retries and then closed by the hard timeout with
    // the nulls it genuinely has. That trades a prompt but empty measurement
    // for a late but real one, on exactly the loads where nobody is looking.
    function finishOrWait() {
      if (finished) return;

      try {
        grabMissingFromEntries();
      } catch (e) { /* the check below simply fails closed */ }

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
    payload = readPayload(item[stream.payloadKey], EXPERIENCE_FIELDS);

    seg = persistExperienceIfNew(stream, payload);
    if (!seg) return;

    emitExperienceIfUnfired(stream, seg, payload);
  }

  function processOneEvent(stream, item) {
    var payload;

    if (!isEventTrigger(stream, item)) return;
    if (item[stream.eventFlag]) return;

    item[stream.eventFlag] = true;
    payload = readPayload(item[stream.payloadKey], EVENT_FIELDS);

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

  // --- AB Tasty experiences ----------------------------------------------
  // A shorthand for reporting an AB Tasty test as an experience, called from
  // the test's own JavaScript rather than from anywhere in here. Everything it
  // does could be done by the test pushing the experience itself; what it saves
  // is every test re-deriving the segment code from the campaign and variation
  // names, which is where the two drift apart.
  //
  // Either stream can be the destination, chosen by the conversio_experience
  // flag on the window (see abtastyUsesClientStream). The derivation is the same
  // for both, so the choice reaches only the event name, the payload key and the
  // category.
  //
  // The convention it reads is AB Tasty's own campaign name, 'CODE | Test name'
  // normally and 'Prefix | CODE | Test name' on a sampled test, together with
  // its variation name, 'Variation 2 | whatever' or 'Original'. Neither belongs
  // to this tag: both are typed into AB Tasty by whoever set the test up, so a
  // name carrying no code at the expected position is a setup error rather than
  // a case to report around, and the call is dropped instead of keying an
  // experience on 'undefined' that nothing downstream could ever untangle.

  // Whether this is a sampled run. Read off the window rather than taken as an
  // argument because that is where the calling test sets it, immediately before
  // the call. A string counts too: a value coming from a GTM variable or a
  // hand-written snippet is as likely to be 'true' as true, and the loose
  // comparison that would have accepted one accepts far too much else.
  function readAbtastySampleFlag() {
    var flag;
    try {
      flag = window.conversio_sample;
    } catch (e) {
      return false;
    }
    return flag === true || flag === 'true';
  }

  // Whether the experience is the client's rather than ours, read off the
  // window at call time like the sample flag and set by the calling test the
  // same way. Ours unless the flag says otherwise: a test that sets nothing
  // reports where every AB Tasty test reported before this flag existed, so the
  // absent case cannot quietly divert an experience into the client's own
  // reporting, where it would sit unnoticed until someone read the numbers.
  //
  // This is the opposite default to readAbtastySampleFlag, and for the same
  // reason: each reads as its own normal case. Most tests are not sampled, and
  // most experiences are ours.
  function abtastyUsesClientStream() {
    var flag;
    try {
      flag = window.conversio_experience;
    } catch (e) {
      return false;
    }
    return flag === false || flag === 'false';
  }

  // Pushed through dl rather than a fresh window.dataLayer lookup, so the push
  // is the hooked one this tag installed and the experience is processed even
  // if something has since reassigned window.dataLayer.
  //
  // The three names that differ between the streams are written out here rather
  // than read off the stream descriptors. This function pushes one shape of
  // event and the descriptors describe every shape either stream accepts, the
  // Conversio one accepting a second experience name that a container may still
  // be pushing: sending this through them would put the choice of which of those
  // to push somewhere that has to stay correct for every other caller too.
  // Everything past the push is descriptor-driven as before.
  function pushAbtastyExperience(useClient, gv, testCode, testData) {
    var item = { event: useClient ? 'client_experience' : 'conversio_experience' };

    item[useClient ? 'client' : 'conversio'] = {
      experience_category: useClient ? 'Client Experience' : 'Conversio Experience',
      experience_action: testCode + ' | ' + gv.testID + ' | ' + testData.name,
      experience_label: gv.testID + ' | ' + testData.variationName,
      experience_segment: gv.testSegment
    };

    dl.push(item);
  }

  // Returns whether an experience was reported, so a caller that wants to know
  // can ask. Nothing is logged either way: this file has no logging, and a tag
  // that writes to a client's console on every page is a support call waiting
  // to happen. A second call for the same test is harmless, experiences being
  // de-duplicated by segment downstream (see persistExperienceIfNew).
  function reportAbtastyTest(testId, sampled, useClient) {
    var tests;
    var testData;
    var nameParts;
    var testCode;
    var varName;
    var varData;
    var expSeg;

    // AB Tasty is present wherever this is called from, being what called it,
    // but the lookup can still come back empty: a test that has stopped, or an
    // id that no longer matches a campaign on the page, is a miss rather than
    // an error, and a public entry point on a client's site must not throw at
    // whatever ran the line after it.
    try {
      tests = window.ABTasty.getTestsOnPage();
    } catch (e) {
      return false;
    }

    if (!isObject(tests)) return false;

    testData = tests[testId];
    if (!isObject(testData)) return false;
    if (typeof testData.name !== 'string') return false;
    if (typeof testData.variationName !== 'string') return false;

    nameParts = testData.name.split(' | ');
    testCode = sampled ? nameParts[1] : nameParts[0];
    if (!testCode) return false;

    varName = testData.variationName.split(' | ')[0];
    varData = varName.split(' ');
    expSeg = testCode;

    // Original and Control are one segment; a numbered variation gets its
    // number. Any other variation name leaves the segment as the test code
    // alone, which is what a name outside the convention has always produced
    // here: 'Variation' with no number after it takes that same path rather
    // than reporting '.XVundefined'.
    if (varName.indexOf('Original') >= 0 || varName.indexOf('Control') >= 0) {
      expSeg = expSeg + '.XCO';
    } else if (varData[0].indexOf('Variation') >= 0 && varData[1]) {
      expSeg = expSeg + '.XV' + varData[1];
    }

    if (sampled) expSeg = expSeg + '.S';

    pushAbtastyExperience(
      useClient,
      { testID: testId, testSegment: expSeg },
      testCode,
      testData
    );

    return true;
  }

  // The direct entry point, unchanged: it reads both flags off the window at
  // call time, which is what an AB Tasty test setting them on the line above
  // expects. It executes immediately, so reading at call time and reading at
  // push time are the same moment and there is nothing to capture.
  //
  // The queued entry point below cannot do that, and the difference is the
  // whole reason its flags travel with the item. See runAbtastyQueueItem.
  function conversioAbtastyTracking(testId) {
    return reportAbtastyTest(
      testId,
      readAbtastySampleFlag(),
      abtastyUsesClientStream()
    );
  }

  // --- the AB Tasty queue -------------------------------------------------
  // A test snippet cannot call a function that does not exist yet, and AB Tasty
  // is built to run as early as it can, usually synchronously in the head so a
  // variation is painted rather than flickering into place. This tag arrives
  // through a container that is typically async. So the test winning that race
  // is the ordinary case rather than the exception, and a snippet guarding the
  // call with a typeof check, which is the only safe way to call a function
  // that may be absent, reports nothing at all on the loads where it loses.
  // Silently: no error, no console output, one missing experience.
  //
  // So the queue inverts it. A test pushes what it wants reported to an array
  // it creates if nobody has yet, and this tag drains that array when it
  // initialises and then replaces it with something whose push reports
  // immediately. Neither order can lose: pushed before the tag, the item waits
  // in the array; pushed after, it goes straight through. It is the pattern
  // dataLayer itself uses, and for the same reason.
  //
  // An item's flags travel with the item rather than being read off the window
  // when it runs. This is the one place the two entry points genuinely differ,
  // and it is a correctness requirement rather than a preference: a queued item
  // may sit for seconds before this tag drains it, and two tests queueing
  // before the tag arrives would both read whichever value the window happened
  // to hold at drain time. Whatever the second test set would be reported for
  // the first. Captured at push time, each item carries its own answer.
  //
  // Both flags read exactly as the window ones do, naming the two spellings a
  // GTM variable is as likely to produce as a boolean and letting everything
  // else be the default: absent sample is unsampled, absent experience is ours.
  // A bare test id is the shorthand for both defaults.
  function runAbtastyQueueItem(item) {
    var testId;

    if (typeof item === 'string' || typeof item === 'number') {
      return reportAbtastyTest(String(item), false, false);
    }

    if (!isObject(item)) return false;

    testId = item.testId;
    if (typeof testId === 'number') testId = String(testId);
    if (typeof testId !== 'string' || !testId) return false;

    return reportAbtastyTest(
      testId,
      item.sample === true || item.sample === 'true',
      item.experience === false || item.experience === 'false'
    );
  }

  // The consent queue. Same arrangement as the AB Tasty queue below, for the
  // same reason: a consent platform cannot call a function that does not exist
  // yet. The controls at the foot of this file are assigned when this script
  // executes, and the loader delivers it through a container rather than inline,
  // so a CMP resolving already-stored consent early in the page loses that race
  // routinely rather than exceptionally. A typeof guard in the client's own tag
  // would stop the crash and turn it into silent data loss instead: no error,
  // no emission, nothing sent for the whole session, and a loader serving a
  // clean 200 throughout.
  //
  // Pushed before this tag, a command waits; pushed after, it applies on the
  // push. So one snippet in the client's consent tag is correct either way,
  // which matters because that tag is wired once per client by people who
  // cannot know which order they will get.
  //
  // Consent remains the client's to signal and theirs to decide. This changes
  // only how the signal arrives.
  function runConsentQueueItem(item) {
    var cmd;

    // A GTM variable holding a consent state is as likely to resolve to a
    // boolean as to a word, so both read the same way and there is one rule
    // rather than two.
    if (item === true) { enableEmission(); return true; }
    if (item === false) { disableEmission(); return true; }

    if (typeof item !== 'string') return false;

    cmd = item.toLowerCase();

    if (cmd === 'enable' || cmd === 'enabled' || cmd === 'grant' || cmd === 'granted') {
      enableEmission();
      return true;
    }

    if (cmd === 'disable' || cmd === 'disabled' || cmd === 'deny' || cmd === 'denied') {
      disableEmission();
      return true;
    }

    // Flushes without moving the gate, for a platform that re-signals an
    // already-granted consent and wants whatever buffered since then released.
    if (cmd === 'flush') {
      flushAllStreams();
      return true;
    }

    // Anything unrecognised is stepped over rather than falling back to a
    // default, because the only useful default here would be a grant. A queue
    // that reads a typo as consent is worse than one that ignores it: the
    // visitor never agreed, and nothing downstream could tell the difference.
    return false;
  }

  // Drained once, at init, in the order the commands were pushed, so a platform
  // that grants and then withdraws within one page lands on the withdrawal
  // rather than on whichever this happens to walk last.
  //
  // A bad item is stepped over rather than ending the drain, and the whole
  // drain is guarded, since this reads a structure client code built and init
  // must survive whatever it finds there.
  function drainConsentQueue() {
    var queue;
    var i;

    try {
      queue = window.conversioConsentQueue;
    } catch (e) {
      queue = null;
    }

    if (isArray(queue)) {
      for (i = 0; i < queue.length; i++) {
        try {
          runConsentQueueItem(queue[i]);
        } catch (e) {
          // one bad command is not the rest of them
        }
      }
    }

    // From here the queue is live rather than a buffer, so a command pushed
    // after this point applies on the push. The return value is deliberately
    // not contractual, for the same reason as the AB Tasty queue: it is the
    // array's new length before this runs and a boolean after, and the two
    // cannot be made to agree without lying about one of them.
    window.conversioConsentQueue = {
      push: function (item) {
        try {
          return runConsentQueueItem(item);
        } catch (e) {
          return false;
        }
      }
    };
  }

  // Drained once, at init. Anything already queued is reported in the order it
  // was pushed, so two tests on one page report in the order they ran rather
  // than in whatever order this happens to walk.
  //
  // A bad item is stepped over rather than ending the drain: one test snippet
  // pushing something malformed must not cost every other test on the page its
  // experience. The whole drain is guarded too, since this reads a structure
  // client code built and init must survive whatever it finds there.
  function drainAbtastyQueue() {
    var queue;
    var i;

    try {
      queue = window.conversioAbtastyQueue;
    } catch (e) {
      queue = null;
    }

    if (isArray(queue)) {
      for (i = 0; i < queue.length; i++) {
        try {
          runAbtastyQueueItem(queue[i]);
        } catch (e) {
          // one bad item is not the rest of them
        }
      }
    }

    // From here the queue is live rather than a buffer: a test pushing after
    // this point is reported on the push. The same one-line snippet therefore
    // works whenever it runs, which is the point of the whole arrangement.
    //
    // The return value is deliberately not part of the contract: before this
    // runs a push returns the array's new length, after it the boolean this
    // returns. Nothing should read it, and the two cannot be made to agree
    // without lying about one of them.
    window.conversioAbtastyQueue = {
      push: function (item) {
        try {
          return runAbtastyQueueItem(item);
        } catch (e) {
          return false;
        }
      }
    };
  }

  // Public gate controls
  window.__conversioEnableEmission__ = enableEmission;
  window.__conversioDisableEmission__ = disableEmission;
  window.__conversioFlushEmission__ = flushAllStreams;

  // Public AB Tasty helper. Exposed under its plain name rather than the
  // __conversio*__ convention above, which marks the controls a consent
  // platform calls: this one is called by hand from an AB Tasty test, where the
  // name is typed out in full every time. The queue drained at init carries the
  // same plain name for the same reason.
  //
  // Both entry points stay. The queue is the one to write against, having no
  // race to lose and no window flags to mis-scope, but a test already calling
  // the function by name keeps working exactly as it did: same argument, same
  // flags off the window, same return, same derivation underneath.
  window.conversioAbtastyTracking = conversioAbtastyTracking;

  // Bootstrap
  // Settings go up first, before any dataLayer processing, so a tag triggered
  // by the events below can already read window.conversioSettings.
  exposeClientSettings();

  // Consent next, and specifically between the settings above and the dataLayer
  // processing below. After the settings because enableEmission flushes, and a
  // flush can send to GA4, which needs the tracking ID already on the window.
  // Before the processing because otherwise this page's items are read with the
  // gate shut, buffered into memory, then immediately promoted and flushed back
  // out: the same end state by a longer route, with a window in which the
  // buffer holds exactly what is about to be released.
  //
  // Guarded for the same reason as the AB Tasty drain: the queue is a structure
  // client code built, and whatever is in there, this tag still initialises.
  try {
    drainConsentQueue();
  } catch (e) {
    // ignore
  }

  processExistingDataLayer();
  hookPush();

  // After hookPush, because a queued experience is pushed through dl and has to
  // meet the hooked push to be processed, and before the vitals below, which
  // are best-effort and must never stand between a test and its experience.
  // Guarded because the queue is a structure client code built: whatever is in
  // there, this tag still initialises.
  try {
    drainAbtastyQueue();
  } catch (e) {
    // ignore
  }

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
