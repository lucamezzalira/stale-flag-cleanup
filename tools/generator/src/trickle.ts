import { loadStore, saveSeed } from "@stale-flags/local-store";
import { createRng } from "./rng.ts";

/** Live trickle that only adds events to flags that should stay active. */
async function main(): Promise<void> {
  const seed = Number(process.env.SEED ?? 42);
  const rng = createRng(seed + Date.now() % 1000);
  console.log("Trickle mode: Ctrl+C to stop");

  for (;;) {
    const store = await loadStore();
    const day = new Date().toISOString().slice(0, 10);
    const build =
      store.adoption.sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date))[0]
        ?.build_id ?? "dev.local";

    const add = (
      flag: string,
      outcome: string,
      variation: string,
      n: number,
    ) => {
      store.activity.push({
        day,
        flag_key: flag,
        app: "web",
        build_id: build,
        outcome,
        variation,
        event_count: n,
      });
    };

    add("express_pay_hint", "evaluated", "true", 3 + Math.floor(rng() * 5));
    add("wishlist", "evaluated", "false", 1);
    add("wishlist_sharing", "blocked_by_parent", "", 1);
    if (rng() > 0.4) {
      add(
        "shipping_estimator",
        "evaluated",
        rng() > 0.4 ? "estimate_compact" : "estimate_detailed",
        1,
      );
    }

    await saveSeed({
      definitions: store.definitions,
      activity: store.activity,
      adoption: store.adoption,
      decisions: store.decisions,
    });
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
