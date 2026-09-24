-- What changed since the last run. This is what the nightly job exports.
--
-- Replace PROJECT. Output is exactly the three fields manage-audiences.mjs
-- reads, so the whole distribution step is this query piped into that CLI.
--
-- WHY A DIFF AND NOT THE TABLE
--
-- KV writes bill at roughly $5 per million. A million visitors rewritten nightly
-- is 30M writes a month, about $150 per client, for data that mostly did not
-- change. A day's real churn is a few percent of that. The read side is
-- unaffected either way: the Worker reads one key per lookup whatever was
-- written.
--
-- THE CASE THAT IS EASY TO MISS
--
-- Someone who falls out of every audience. If the diff only ever emitted
-- additions and changes, their old record would sit in KV unchanged and they
-- would go on being lapsed_90d after they had purchased. The FULL OUTER JOIN
-- below is there for them: present last run, absent this one, emitted with an
-- empty list so the write clears them.
--
-- Someone who stops visiting is a different problem and is not solved here.
-- Nothing emits a row for a visitor the derivation no longer sees at all, so
-- their record is cleared by the TTL manage-audiences.mjs sets rather than by
-- anything in this file.

DECLARE this_run, last_run TIMESTAMP;

SET this_run = (
  SELECT MAX(computed_at) FROM `PROJECT.conversio_v3.audience_membership`
);

-- NULL on the very first run, which is correct rather than a special case: no
-- row matches a NULL comparison, `previous` comes back empty, and every visitor
-- reads as newly seen.
SET last_run = (
  SELECT MAX(computed_at) FROM `PROJECT.conversio_v3.audience_membership`
  WHERE computed_at < this_run
);

WITH current AS (
  SELECT
    conversio_id,
    audiences,
    -- Sorted, so two runs that hold the same audiences in a different order
    -- compare equal. Without the ORDER BY the diff would emit most of the table
    -- every night for no reason, which is the whole cost this query exists to
    -- avoid.
    (SELECT STRING_AGG(code, ',' ORDER BY code) FROM UNNEST(audiences) AS code) AS fingerprint
  FROM `PROJECT.conversio_v3.audience_membership`
  WHERE computed_at = this_run
),

previous AS (
  SELECT
    conversio_id,
    (SELECT STRING_AGG(code, ',' ORDER BY code) FROM UNNEST(audiences) AS code) AS fingerprint
  FROM `PROJECT.conversio_v3.audience_membership`
  WHERE computed_at = last_run
)

SELECT
  COALESCE(c.conversio_id, p.conversio_id) AS conversio_id,

  -- Absent from this run means they are in nothing now. An empty list is a real
  -- answer and the write clears them; omitting the row would leave them as they
  -- were.
  IF(c.conversio_id IS NULL, ARRAY<STRING>[], c.audiences) AS audiences,

  UNIX_SECONDS(this_run) AS ts

FROM current AS c
FULL OUTER JOIN previous AS p
  ON c.conversio_id = p.conversio_id
WHERE
  -- newly seen
  p.conversio_id IS NULL
  -- fell out of everything
  OR c.conversio_id IS NULL
  -- membership changed
  OR IFNULL(c.fingerprint, '') != IFNULL(p.fingerprint, '');


-- ---------------------------------------------------------------------------
-- Before scheduling this, run it once as a count
-- ---------------------------------------------------------------------------
-- A diff that is most of the table means something is wrong upstream: an
-- audience definition that is not deterministic, a computed_at that moves when
-- the membership does not, or a derivation that rebuilds every row each night.
-- All three look identical from here and all three cost the same as having no
-- diff at all.
--
--   SELECT
--     (SELECT COUNT(*) FROM `PROJECT.conversio_v3.audience_membership`
--       WHERE computed_at = this_run) AS rows_this_run,
--     COUNT(*) AS rows_to_write
--   FROM ( <the SELECT above> )
--
-- Single figures per cent is healthy on a real dataset. Anything approaching
-- 100% should be understood before it is automated, not after the first bill.


-- ---------------------------------------------------------------------------
-- Full rebuild, for a first load or a recovery
-- ---------------------------------------------------------------------------
-- Writes every visitor rather than the diff. Use it to seed a new client, or
-- after an outage long enough that the deltas in between are gone. It costs a
-- write per visitor, so it is a deliberate act rather than a schedule.
--
--   SELECT conversio_id, audiences, UNIX_SECONDS(computed_at) AS ts
--   FROM `PROJECT.conversio_v3.audience_membership`
--   WHERE computed_at = (
--     SELECT MAX(computed_at) FROM `PROJECT.conversio_v3.audience_membership`
--   );
