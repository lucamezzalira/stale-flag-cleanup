import { FlagCallout } from "../FlagCallout";
import { useFlag } from "../flags";

const PRODUCTS = [
  { id: 1, name: "Classic Tee", code: "TEE-01", scoreV1: 10, scoreV2: 40 },
  { id: 2, name: "Canvas Tote", code: "TOT-02", scoreV1: 20, scoreV2: 10 },
  { id: 3, name: "Wool Cap", code: "CAP-03", scoreV1: 30, scoreV2: 20 },
  { id: 4, name: "Field Jacket", code: "JKT-04", scoreV1: 25, scoreV2: 35 },
];

export function SearchPage() {
  const ranking = useFlag("search_ranking_v2");
  const sorted = [...PRODUCTS].sort((a, b) =>
    ranking.enabled ? b.scoreV2 - a.scoreV2 : b.scoreV1 - a.scoreV1,
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Search</h1>
          <p>
            Same catalog, different order depending on{" "}
            <code>search_ranking_v2</code>.
          </p>
        </div>
      </div>

      <FlagCallout
        flagKey="search_ranking_v2"
        enabled={ranking.enabled}
        variation={ranking.variation}
        outcome={ranking.outcome}
        blockedBy={ranking.blockedBy}
      />

      <div className="grid" style={{ marginTop: "1rem" }}>
        {sorted.map((p, index) => (
          <article className="product" key={p.id}>
            <div className="product-visual">
              #{index + 1} · {p.code}
            </div>
            <div className="product-body">
              <h2>{p.name}</h2>
              <p className="muted">
                Rank score{" "}
                {ranking.enabled ? p.scoreV2 : p.scoreV1}
              </p>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
