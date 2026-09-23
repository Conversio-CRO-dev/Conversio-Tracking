-- audience_membership: which audiences a visitor is in.
--
-- The derivation plane of the v3 architecture. One row per visitor, rewritten by
-- a nightly scheduled query; a Cloud Run job reads the delta and writes it to
-- Cloudflare KV, where the loader Worker serves it to the tag, which puts it in
-- a first-party cookie for the client's experimentation platform to target on.
--
-- Per client. Each client's GA4 export lives in their own project, so this table
-- does too, and the mapping from a table to a Conversio client key belongs in
-- the distribution job's config rather than in a column here. One table serving
-- several clients would put the key that separates them in the data, where a
-- mistaken join could cross it.
--
-- Replace PROJECT below. FIRST DRAFT: the seed row at the bottom is one real
-- browser and three invented audiences, for proving the chain end to end.

CREATE SCHEMA IF NOT EXISTS `PROJECT.conversio_v3`
OPTIONS (description = "Conversio v3 audience derivation. See bigquery/audience_membership.sql.");

CREATE TABLE IF NOT EXISTS `PROJECT.conversio_v3.audience_membership` (

  conversio_id STRING NOT NULL
    OPTIONS (description =
      "The visitor's Conversio id, as minted by the runtime tag and stored in "
      "localStorage on the client's domain. Shape: con_<16 chars of a-z2-7>."
      "<microseconds>. Per-origin, so an id here is meaningless against another "
      "client's table."),

  -- An ARRAY, deliberately, and not audience_1 / audience_2 / audience_3.
  --
  -- Membership is a set. Numbered columns make it an ordered tuple, which is
  -- wrong three ways: a fourth audience needs a schema change, position carries
  -- no meaning so the same code lands in different columns for different
  -- visitors, and every query becomes a chain of ORs across the columns. The
  -- serving layer wants a list anyway, so numbered columns would only have to be
  -- unpicked back into one.
  audiences ARRAY<STRING>
    OPTIONS (description =
      "Audience codes this visitor is in. Must match ^[a-z0-9][a-z0-9_-]{0,31}$ "
      "and must never contain a comma: these end up in a comma-delimited cookie "
      "value, where a comma would split one code into two and grant a membership "
      "the visitor does not have. The Worker re-checks and silently drops "
      "anything failing this, and caps the list at 24."),

  -- The single most load-bearing column, and the one a first draft leaves out.
  --
  -- It is served through to the tag and written into the cookie, where it is the
  -- only evidence of whether the pipeline is still running. A write time would
  -- read as fresh forever while serving three-week-old audiences; this diverges
  -- from now exactly when the derivation has stopped, which is what makes it
  -- the thing to alert on.
  computed_at TIMESTAMP NOT NULL
    OPTIONS (description =
      "When this row's audiences were COMPUTED, not when they were written or "
      "served. Freshness is measured against this everywhere downstream.")

)
-- Left off while this is one row, and both belong here at real cardinality:
--
--   PARTITION BY DATE(computed_at)
--   CLUSTER BY conversio_id
--
-- Partitioning makes "everything computed since the last distribution run" a
-- partition scan rather than a full one, which is the only query the job runs.
-- Clustering makes the single-visitor lookups used for debugging and for
-- erasure requests cheap.
OPTIONS (description =
  "One row per visitor: which audiences they are in, and when that was computed. "
  "Rewritten nightly. Read by the distribution job, never by a browser.");


-- ---------------------------------------------------------------------------
-- Seed row. THROWAWAY.
-- ---------------------------------------------------------------------------
-- One real browser on conversio.com and three invented audiences, so the chain
-- from here to a cookie can be proven before any real derivation exists. The
-- three codes are shaped like real ones and each stands for a different kind of
-- derivation: recency, value, and category affinity.
--
-- Delete this the moment real audience definitions land. A hand-inserted row
-- with no definition behind it is indistinguishable from a derived one once
-- anybody has forgotten it is here.

INSERT INTO `PROJECT.conversio_v3.audience_membership`
  (conversio_id, audiences, computed_at)
VALUES
  ('con_wu6iuxsffhwxljci.1789464054974051',
   ['lapsed_90d', 'high_aov', 'browsed_outerwear'],
   CURRENT_TIMESTAMP());


-- ---------------------------------------------------------------------------
-- What this becomes
-- ---------------------------------------------------------------------------
-- Each audience is its own SELECT emitting (conversio_id, code), version
-- controlled in bigquery/audiences/. They UNION ALL into a long form, which
-- aggregates into the shape above:
--
--   INSERT INTO `PROJECT.conversio_v3.audience_membership`
--   WITH members AS (
--     SELECT conversio_id, 'lapsed_90d'        AS code FROM ...
--     UNION ALL
--     SELECT conversio_id, 'high_aov'          AS code FROM ...
--     UNION ALL
--     SELECT conversio_id, 'browsed_outerwear' AS code FROM ...
--   )
--   SELECT conversio_id, ARRAY_AGG(DISTINCT code), CURRENT_TIMESTAMP()
--   FROM members
--   GROUP BY conversio_id;
--
-- Adding an audience is then one more SELECT and one more file, with no schema
-- change and nothing else rewritten. That is the reason for the array.
--
-- Blocked on a prerequisite that is not in this file: conversio_id reaches the
-- GA4 export today only when a visitor triggered a Conversio experience or a
-- mapped event, since it rides conversio_cro and nothing else. Until it is set
-- as a user-scoped custom dimension on ordinary hits, any audience derived here
-- covers only people already experimented on. See .claude/v3-architecture.md §6.1.


-- ---------------------------------------------------------------------------
-- What the distribution job writes, for reference
-- ---------------------------------------------------------------------------
-- KV key    aud:<clientKey>:<conversio_id>
-- KV value  {"ts": <computed_at as epoch seconds>, "a": ["lapsed_90d", ...]}
--
-- The Worker validates every code again on the way out, because a record
-- hand-edited through the Cloudflare dashboard never passed through this file.
-- See self-hosted/src/index.js and self-hosted/README.md.
