import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanupReport,
  listCandidates,
  runSafetyCheck,
  type EvidenceStore,
  type FlagDefinition,
} from "./index.js";

function def(
  partial: Partial<FlagDefinition> & { flag_key: string },
): FlagDefinition {
  return {
    parent_key: "",
    rollout_percentage: 100,
    target_value: "true",
    variation_count: 1,
    deprecated: 0,
    archived: 0,
    environment: "production",
    captured_at: "2025-01-01T00:00:00Z",
    datafile_revision: "rev1",
    ...partial,
  };
}

const now = new Date("2026-10-14T00:00:00Z");
const windowStart = "2026-07-16"; // 90 days before now

function baseStore(overrides: Partial<EvidenceStore> = {}): EvidenceStore {
  return {
    definitions: [
      def({
        flag_key: "promo_banner_2025",
        rollout_percentage: 0,
        target_value: "false",
        deprecated: 1,
      }),
      def({
        flag_key: "one_click_buy",
        rollout_percentage: 100,
        target_value: "true",
        deprecated: 1,
      }),
      def({ flag_key: "wishlist", parent_key: "" }),
      def({ flag_key: "wishlist_sharing", parent_key: "wishlist" }),
      def({
        flag_key: "wishlist_sharing_qr",
        parent_key: "wishlist_sharing",
      }),
      def({
        flag_key: "shipping_estimator",
        rollout_percentage: 60,
        target_value: "",
        variation_count: 2,
      }),
      def({
        flag_key: "search_ranking_v2",
        rollout_percentage: 5,
        target_value: "",
        variation_count: 1,
      }),
      def({
        flag_key: "checkout_redesign",
        rollout_percentage: 0,
        target_value: "false",
      }),
    ],
    activity: [
      {
        day: "2026-09-01",
        flag_key: "one_click_buy",
        app: "web",
        build_id: "b-modern",
        outcome: "evaluated",
        variation: "true",
        event_count: 5000,
      },
      {
        day: "2026-09-01",
        flag_key: "wishlist_sharing",
        app: "web",
        build_id: "b-modern",
        outcome: "blocked_by_parent",
        variation: "",
        event_count: 100,
      },
      {
        day: "2026-09-01",
        flag_key: "checkout_redesign",
        app: "web",
        build_id: "b-sticky",
        outcome: "evaluated",
        variation: "false",
        event_count: 200,
      },
      {
        day: "2026-09-01",
        flag_key: "search_ranking_v2",
        app: "web",
        build_id: "b-modern",
        outcome: "evaluated",
        variation: "true",
        event_count: 8,
      },
      {
        day: "2026-09-01",
        flag_key: "shipping_estimator",
        app: "web",
        build_id: "b-modern",
        outcome: "evaluated",
        variation: "estimate_simple",
        event_count: 500,
      },
    ],
    adoption: [
      {
        snapshot_date: "2026-09-01",
        app: "web",
        build_id: "b-modern",
        released_at: "2026-06-01T00:00:00Z",
        active_sessions: 9000,
        session_share: 0.9,
      },
      {
        snapshot_date: "2026-09-01",
        app: "web",
        build_id: "b-sticky",
        released_at: "2025-01-01T00:00:00Z",
        active_sessions: 400,
        session_share: 0.04,
      },
    ],
    firstSeen: {
      promo_banner_2025: "2025-01-01",
      one_click_buy: "2025-01-01",
      wishlist: "2025-01-01",
      wishlist_sharing: "2025-01-01",
      wishlist_sharing_qr: "2025-01-01",
      shipping_estimator: "2025-01-01",
      search_ranking_v2: "2025-01-01",
      checkout_redesign: "2025-01-01",
    },
    ...overrides,
  };
}

describe("runSafetyCheck", () => {
  it("marks quiet deprecated flags safe_to_remove via lifecycle after evidence checks", () => {
    const store = baseStore();
    const promo = runSafetyCheck(store, {
      flag_key: "promo_banner_2025",
      now,
    });
    assert.equal(promo.verdict, "safe_to_remove");
    assert.equal(promo.route, "lifecycle");
    assert.equal(promo.collapse_direction, "delete_gated_branch");

    // Heavy modern traffic with evaluating_share >= 0.5 still allows lifecycle
    // once minority-build evidence has passed.
    const oneClick = runSafetyCheck(store, {
      flag_key: "one_click_buy",
      now,
    });
    assert.equal(oneClick.verdict, "safe_to_remove");
    assert.equal(oneClick.route, "lifecycle");
    assert.equal(oneClick.collapse_direction, "keep_gated_branch");
  });

  it("blocks deprecated flags still evaluated by a live minority cohort", () => {
    const store = baseStore({
      definitions: [
        ...baseStore().definitions,
        def({
          flag_key: "nav_winter_ribbon",
          rollout_percentage: 100,
          target_value: "true",
          deprecated: 1,
        }),
      ],
      activity: [
        ...baseStore().activity,
        {
          day: "2026-09-01",
          flag_key: "nav_winter_ribbon",
          app: "web",
          build_id: "b-sticky",
          outcome: "evaluated",
          variation: "true",
          event_count: 300,
        },
      ],
      firstSeen: {
        ...baseStore().firstSeen!,
        nav_winter_ribbon: "2025-01-01",
      },
    });
    const row = runSafetyCheck(store, { flag_key: "nav_winter_ribbon", now });
    assert.equal(row.verdict, "blocked");
    assert.equal(row.route, "abandoned");
    assert.match(row.reason, /deprecated/i);
    assert.match(row.reason, /4%/);
    assert.match(row.reason, /Deprecation makes a flag a candidate/);
    const share = row.evidence.evaluating_share as number;
    assert.ok(share > 0 && share <= 1.0001);
    assert.equal(row.evidence.evaluating_share_pct, "4%");
  });

  it("marks deprecated flag with one evaluation and no live hits inconclusive", () => {
    const store = baseStore({
      definitions: [
        ...baseStore().definitions,
        def({
          flag_key: "thin_deprecated_flag",
          rollout_percentage: 0,
          target_value: "false",
          deprecated: 1,
        }),
      ],
      activity: [
        ...baseStore().activity,
        {
          day: "2026-09-01",
          flag_key: "thin_deprecated_flag",
          app: "web",
          build_id: "b-dead",
          outcome: "evaluated",
          variation: "false",
          event_count: 1,
        },
      ],
      firstSeen: {
        ...baseStore().firstSeen!,
        thin_deprecated_flag: "2025-01-01",
      },
    });
    const row = runSafetyCheck(store, {
      flag_key: "thin_deprecated_flag",
      now,
    });
    assert.equal(row.verdict, "inconclusive");
    assert.match(row.reason, /only 1/);
  });

  it("marks non-deprecated zero-evaluation flags safe via abandoned", () => {
    const store = baseStore({
      definitions: [
        ...baseStore().definitions,
        def({
          flag_key: "listing_outlet_banner",
          rollout_percentage: 0,
          target_value: "false",
          deprecated: 0,
        }),
      ],
      firstSeen: {
        ...baseStore().firstSeen!,
        listing_outlet_banner: "2025-01-01",
      },
    });
    const row = runSafetyCheck(store, {
      flag_key: "listing_outlet_banner",
      now,
    });
    assert.equal(row.verdict, "safe_to_remove");
    assert.equal(row.route, "abandoned");
    assert.equal(row.collapse_direction, "delete_gated_branch");
  });

  it("marks non-deprecated settled flags safe via settled with share in 0.5..1", () => {
    const store = baseStore({
      definitions: [
        ...baseStore().definitions.filter((d) => d.flag_key !== "one_click_buy"),
        def({
          flag_key: "checkout_secure_seal",
          rollout_percentage: 100,
          target_value: "true",
          deprecated: 0,
        }),
      ],
      activity: [
        ...baseStore().activity.filter((a) => a.flag_key !== "one_click_buy"),
        {
          day: "2026-09-01",
          flag_key: "checkout_secure_seal",
          app: "web",
          build_id: "b-modern",
          outcome: "evaluated",
          variation: "true",
          event_count: 5000,
        },
      ],
      firstSeen: {
        ...baseStore().firstSeen!,
        checkout_secure_seal: "2025-01-01",
      },
    });
    const row = runSafetyCheck(store, {
      flag_key: "checkout_secure_seal",
      now,
    });
    assert.equal(row.verdict, "safe_to_remove");
    assert.equal(row.route, "settled");
    assert.equal(row.collapse_direction, "keep_gated_branch");
    const share = row.evidence.evaluating_share as number;
    assert.ok(share >= 0.5 && share <= 1.0001);
  });

  it("keeps evaluating_share at most 1 when many builds evaluate", () => {
    const adoption = [
      {
        snapshot_date: "2026-09-01",
        app: "web",
        build_id: "b1",
        released_at: "2026-06-01T00:00:00Z",
        active_sessions: 4000,
        session_share: 0.4,
      },
      {
        snapshot_date: "2026-09-01",
        app: "web",
        build_id: "b2",
        released_at: "2026-07-01T00:00:00Z",
        active_sessions: 3500,
        session_share: 0.35,
      },
      {
        snapshot_date: "2026-09-01",
        app: "web",
        build_id: "b3",
        released_at: "2026-08-01T00:00:00Z",
        active_sessions: 2500,
        session_share: 0.25,
      },
      // older snapshots with high shares must not inflate the sum
      {
        snapshot_date: "2026-08-01",
        app: "web",
        build_id: "b1",
        released_at: "2026-06-01T00:00:00Z",
        active_sessions: 9000,
        session_share: 0.9,
      },
      {
        snapshot_date: "2026-08-01",
        app: "web",
        build_id: "b2",
        released_at: "2026-07-01T00:00:00Z",
        active_sessions: 8000,
        session_share: 0.8,
      },
    ];
    const store = baseStore({
      definitions: [
        ...baseStore().definitions.filter((d) => d.flag_key !== "one_click_buy"),
        def({
          flag_key: "checkout_secure_seal",
          rollout_percentage: 100,
          target_value: "true",
          deprecated: 0,
        }),
      ],
      activity: [
        {
          day: "2026-09-01",
          flag_key: "checkout_secure_seal",
          app: "web",
          build_id: "b1",
          outcome: "evaluated",
          variation: "true",
          event_count: 2000,
        },
        {
          day: "2026-09-01",
          flag_key: "checkout_secure_seal",
          app: "web",
          build_id: "b2",
          outcome: "evaluated",
          variation: "true",
          event_count: 2000,
        },
        {
          day: "2026-09-01",
          flag_key: "checkout_secure_seal",
          app: "web",
          build_id: "b3",
          outcome: "evaluated",
          variation: "true",
          event_count: 2000,
        },
      ],
      adoption,
      firstSeen: {
        ...baseStore().firstSeen!,
        checkout_secure_seal: "2025-01-01",
      },
    });
    const row = runSafetyCheck(store, {
      flag_key: "checkout_secure_seal",
      now,
    });
    const share = row.evidence.evaluating_share as number;
    assert.ok(share <= 1.0001, `evaluating_share=${share}`);
    assert.ok(share >= 0.5);
    assert.equal(row.evidence.evaluating_share_pct, "100%");
  });

  it("returns inconclusive for parent-gated before descendant blocking", () => {
    const store = baseStore();
    const sharing = runSafetyCheck(store, {
      flag_key: "wishlist_sharing",
      now,
    });
    assert.equal(sharing.verdict, "inconclusive");
    assert.match(sharing.reason, /parent wishlist/);
  });

  it("blocks flags with living descendants", () => {
    const store = baseStore();
    const wishlist = runSafetyCheck(store, { flag_key: "wishlist", now });
    assert.equal(wishlist.verdict, "blocked");
    assert.match(wishlist.reason, /wishlist_sharing/);
    assert.match(wishlist.reason, /wishlist_sharing_qr/);
  });

  it("blocks mid-ramp multi-variation flags", () => {
    const store = baseStore();
    const shipping = runSafetyCheck(store, {
      flag_key: "shipping_estimator",
      now,
    });
    assert.equal(shipping.verdict, "blocked");
    assert.equal(shipping.collapse_direction, "none");
  });

  it("blocks sticky minority live-build evaluations", () => {
    const store = baseStore();
    const redesign = runSafetyCheck(store, {
      flag_key: "checkout_redesign",
      now,
    });
    assert.equal(redesign.verdict, "blocked");
    assert.match(redesign.reason, /b-sticky/);
  });

  it("returns inconclusive for thin evidence", () => {
    const store = baseStore();
    const sparse = runSafetyCheck(store, {
      flag_key: "search_ranking_v2",
      now,
    });
    assert.equal(sparse.verdict, "inconclusive");
  });

  it("returns inconclusive when firstSeen is inside the window", () => {
    const store = baseStore({
      firstSeen: {
        brand_new_flag: windowStart,
      },
      definitions: [
        def({
          flag_key: "brand_new_flag",
          rollout_percentage: 0,
          target_value: "false",
        }),
      ],
      activity: [],
    });
    const result = runSafetyCheck(store, {
      flag_key: "brand_new_flag",
      now,
    });
    assert.equal(result.verdict, "inconclusive");
    assert.match(result.reason, /first appeared/);
  });

  it("returns blocked for missing definitions", () => {
    const store = baseStore({ definitions: [] });
    const result = runSafetyCheck(store, { flag_key: "gone", now });
    assert.equal(result.verdict, "blocked");
    assert.equal(result.route, "none");
  });
});

describe("listCandidates / cleanupReport", () => {
  it("returns all non-archived flags", () => {
    const store = baseStore();
    const candidates = listCandidates(store, { now });
    assert.equal(candidates.length, 8);
    assert.ok(candidates.some((c) => c.flag_key === "shipping_estimator"));
    assert.ok(candidates.some((c) => c.flag_key === "search_ranking_v2"));
  });

  it("cleanupReport matches per-flag safety checks", () => {
    const store = baseStore();
    const report = cleanupReport(store, {
      flag_key: "unused",
      now,
    });
    for (const row of report) {
      const direct = runSafetyCheck(store, { flag_key: row.flag_key, now });
      assert.equal(row.verdict, direct.verdict, row.flag_key);
      assert.equal(row.route, direct.route, row.flag_key);
      assert.equal(
        row.collapse_direction,
        direct.collapse_direction,
        row.flag_key,
      );
    }
  });
});
