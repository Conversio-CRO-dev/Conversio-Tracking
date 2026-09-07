//<script>
// CONVERSIO SESSION INITIATION TAG | Client: XXXXXX : version 1.5 - updated 07-09-2026
(function () {
  'use strict';

  // The queue is the signal from 2.6.3 on, and the reason this tag changed. Up
  // to 1.4 this called __conversioEnableEmission__ behind a typeof guard, which
  // is correct only if the runtime tag has already executed. Served by the
  // loader it often has not: the tag arrives through a DNS lookup, a TLS
  // handshake and a Worker hop that a pasted-inline copy never had, while this
  // tag fires on the client's consent trigger, which for a visitor whose
  // consent is already stored resolves in the first few hundred milliseconds.
  // The guard then skips, nothing is written, the consent platform does not
  // fire again this session, and the visitor emits nothing at all while the
  // loader serves them a clean 200 throughout. Pushing instead means the
  // command waits for the tag rather than missing it.
  (window.conversioConsentQueue = window.conversioConsentQueue || []).push('granted');

  // Kept for a client pinned to a bundle older than 2.6.3, which has no queue
  // to drain, so the push above lands in an array nothing ever reads. That is
  // not only the un-migrated case: rolling a client back a version is a normal
  // part of releasing, and a push-only tag would take their consent down on top
  // of whatever the rollback was for. On 2.6.3 this is redundant rather than
  // harmful, granting twice being idempotent: the gate is already open, the
  // segment map already holds what it flushed, and conversio_data is guarded to
  // one per page load, so the second grant emits nothing a first did not.
  //
  // Deliberately not conditional on what the push returned. That value is not
  // part of the queue's contract, being the array's new length before the tag
  // loads and a boolean after, so nothing here can read it to decide.
  if (typeof window.__conversioEnableEmission__ === 'function') {
    window.__conversioEnableEmission__();
  }
})();
//</script>
