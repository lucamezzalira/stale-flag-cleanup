import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDiffSubstance } from "./diff-substance.js";

describe("checkDiffSubstance", () => {
  it("passes when each flag deletes YAML and apps change", () => {
    const r = checkDiffSubstance(
      ["listing_outlet_banner", "checkout_secure_seal"],
      [
        "featurevisor/features/listing_outlet_banner.yml",
        "featurevisor/features/checkout_secure_seal.yml",
        "apps/web/src/pages/Listing.tsx",
        "apps/web/src/pages/Checkout.tsx",
        "featurevisor/.featurevisor/REVISION",
      ],
    );
    assert.equal(r.ok, true);
  });

  it("fails revision-only dirty sets", () => {
    const r = checkDiffSubstance(["listing_outlet_banner"], [
      "featurevisor/.featurevisor/REVISION",
      "featurevisor/.featurevisor/existing-state-production.json",
    ]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.flag, "listing_outlet_banner");
      assert.match(r.detail, /missing deletion/);
    }
  });

  it("fails YAML delete without apps/packages change", () => {
    const r = checkDiffSubstance(["listing_outlet_banner"], [
      "featurevisor/features/listing_outlet_banner.yml",
      "featurevisor/.featurevisor/REVISION",
    ]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.detail, /no apps\/ or packages\//);
    }
  });

  it("fails already-removed flags with no YAML in the diff", () => {
    const r = checkDiffSubstance(["listing_outlet_banner"], [
      "apps/web/src/pages/Listing.tsx",
      "featurevisor/.featurevisor/REVISION",
    ]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.detail, /missing deletion/);
    }
  });
});
