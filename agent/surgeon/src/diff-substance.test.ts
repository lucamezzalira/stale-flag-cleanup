import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkDiffSubstance,
  flagTouchedInAppDiff,
} from "./diff-substance.js";

describe("checkDiffSubstance", () => {
  const listingDiff = `diff --git a/apps/web/src/pages/Listing.tsx b/apps/web/src/pages/Listing.tsx
--- a/apps/web/src/pages/Listing.tsx
+++ b/apps/web/src/pages/Listing.tsx
@@ -1,3 +1,2 @@
-  useFlag("listing_outlet_banner");
+  // removed
`;

  const checkoutDiff = `diff --git a/apps/web/src/pages/Checkout.tsx b/apps/web/src/pages/Checkout.tsx
--- a/apps/web/src/pages/Checkout.tsx
+++ b/apps/web/src/pages/Checkout.tsx
@@ -1,3 +1,2 @@
-  useFlag("checkout_secure_seal");
+  // kept seal text
`;

  it("passes when each flag deletes YAML and its own apps change", () => {
    const r = checkDiffSubstance(
      ["listing_outlet_banner", "checkout_secure_seal"],
      [
        "featurevisor/features/listing_outlet_banner.yml",
        "featurevisor/features/checkout_secure_seal.yml",
        "apps/web/src/pages/Listing.tsx",
        "apps/web/src/pages/Checkout.tsx",
        "featurevisor/.featurevisor/REVISION",
      ],
      listingDiff + checkoutDiff,
    );
    assert.equal(r.ok, true);
  });

  it("fails when only another flag's apps change is in the batch", () => {
    const r = checkDiffSubstance(
      ["listing_outlet_banner", "checkout_secure_seal"],
      [
        "featurevisor/features/listing_outlet_banner.yml",
        "featurevisor/features/checkout_secure_seal.yml",
        "apps/web/src/pages/Listing.tsx",
        "featurevisor/.featurevisor/REVISION",
      ],
      listingDiff,
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.flag, "checkout_secure_seal");
      assert.match(r.detail, /naming checkout_secure_seal/);
    }
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

  it("fails YAML delete without apps/packages change for that flag", () => {
    const r = checkDiffSubstance(
      ["listing_outlet_banner"],
      [
        "featurevisor/features/listing_outlet_banner.yml",
        "featurevisor/.featurevisor/REVISION",
      ],
      "",
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.detail, /naming listing_outlet_banner/);
    }
  });

  it("fails already-removed flags with no YAML in the diff", () => {
    const r = checkDiffSubstance(
      ["listing_outlet_banner"],
      ["apps/web/src/pages/Listing.tsx", "featurevisor/.featurevisor/REVISION"],
      listingDiff,
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.detail, /missing deletion/);
    }
  });

  it("flagTouchedInAppDiff ignores featurevisor-only hunks", () => {
    const diff = `diff --git a/featurevisor/features/listing_outlet_banner.yml b/featurevisor/features/listing_outlet_banner.yml
--- a/featurevisor/features/listing_outlet_banner.yml
+++ /dev/null
@@ -1 +0,0 @@
-listing_outlet_banner
`;
    assert.equal(flagTouchedInAppDiff("listing_outlet_banner", diff), false);
  });
});
