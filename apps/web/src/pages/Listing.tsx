import { FlagCallout } from "../FlagCallout";
import { useFlag } from "../flags";

const PRODUCTS = [
  { name: "Classic Tee", price: "$28", code: "TEE-01" },
  { name: "Canvas Tote", price: "$42", code: "TOT-02" },
  { name: "Wool Cap", price: "$36", code: "CAP-03" },
  { name: "Field Jacket", price: "$168", code: "JKT-04" },
  { name: "Trail Bottle", price: "$24", code: "BTL-05" },
  { name: "Desk Lamp", price: "$88", code: "LMP-06" },
];

export function ListingPage() {
  const winter = useFlag("nav_winter_ribbon");

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p>Catalog surface used to exercise abandoned promo traffic.</p>
        </div>
      </div>

      {winter.enabled ? (
        <div className="banner" style={{ marginBottom: "1rem" }}>
          <div>
            <strong>Winter ribbon still live</strong>
            <span>Deprecated in Featurevisor but sticky builds keep reading it.</span>
          </div>
        </div>
      ) : null}
      <FlagCallout
        flagKey="nav_winter_ribbon"
        enabled={winter.enabled}
        variation={winter.variation}
        outcome={winter.outcome}
        blockedBy={winter.blockedBy}
      />

      <div className="grid" style={{ marginTop: "1rem" }}>
        {PRODUCTS.map((p) => (
          <article className="product" key={p.code}>
            <div className="product-visual">{p.code}</div>
            <div className="product-body">
              <h2>{p.name}</h2>
              <div className="price">{p.price}</div>
              <button type="button" className="btn secondary">
                Add to cart
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}