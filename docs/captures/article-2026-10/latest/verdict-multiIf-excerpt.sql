-- Paste-ready verdict branch from flag_safety_check.pipe (after thin-before-minority swap).
-- Route and reason multiIfs follow the same order.
multiIf(
    coalesce(d.def_rows, 0) = 0, 'blocked',
    d.parent_key != '' AND coalesce(a.blocked_events, 0) > 0 AND coalesce(a.evaluated_events, 0) = 0, 'inconclusive',
    coalesce(de.descendant_count, 0) > 0, 'blocked',
    d.target_value = '' AND (d.variation_count > 1 OR coalesce(a.evaluated_events, 0) >= {{ Int32(min_events_floor, 20) }}), 'blocked',
    (coalesce(a.evaluated_events, 0) + coalesce(a.blocked_events, 0)) > 0
      AND (coalesce(a.evaluated_events, 0) + coalesce(a.blocked_events, 0)) < {{ Int32(min_events_floor, 20) }}, 'inconclusive',
    fs.first_seen IS NOT NULL AND fs.first_seen >= toDate(now() - toIntervalDay({{ Int32(window_days, 90) }})), 'inconclusive',
    coalesce(a.evaluated_events, 0) > 0 AND coalesce(a.evaluated_events, 0) < {{ Int32(min_events_floor, 20) }}, 'inconclusive',
    coalesce(a.evaluated_events, 0) > 0 AND coalesce(ls.live_hit_count, 0) > 0 AND coalesce(ls.evaluating_share, 0) < 0.5, 'blocked',
    (d.deprecated = 1 OR d.archived = 1) AND d.target_value = '', 'blocked',
    d.deprecated = 1 OR d.archived = 1, 'safe_to_remove',
    coalesce(a.evaluated_events, 0) = 0, 'safe_to_remove',
    coalesce(a.evaluated_events, 0) >= {{ Int32(min_events_for_settled, 1000) }}
      AND coalesce(a.distinct_variations, 0) = 1
      AND d.rollout_percentage IN (0, 100)
      AND coalesce(ls.evaluating_share, 0) >= 0.5, 'safe_to_remove',
    'inconclusive'
) AS verdict
