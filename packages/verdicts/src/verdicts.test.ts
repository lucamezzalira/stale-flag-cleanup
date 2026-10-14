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
  it("marks deprecated lifecycle flags safe_to_remove before live-build checks", () => {
    const store = baseStore();
    const promo = runSafetyCheck(store, {
      flag_key: "promo_banner_2025",
      now,
    });
    assert.equal(promo.verdict, "safe_to_remove");
    assert.equal(promo.route, "lifecycle");
    assert.equal(promo.collapse_direction, "delete_gated_branch");

    const oneClick = runSafetyCheck(store, {
      flag_key: "one_click_buy",
      now,
    });
    assert.equal(oneClick.verdict, "safe_to_remove");
    assert.equal(oneClick.route, "lifecycle");
    assert.equal(oneClick.collapse_direction, "keep_gated_branch");
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
