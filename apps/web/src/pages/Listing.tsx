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
  const loyalty = useFlag("loyalty_stamp_banner");

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p>Catalog surface used to exercise abandoned promo traffic.</p>
        </div>
      </div>

      {/* delete_gated fixture is 0% in Featurevisor; render gated copy once the
          SDK is ready so BEFORE CDN QA can see the string. Surgeon removes this. */}
      {loyalty.ready ? (
        <div className="panel" style={{ marginTop: "1rem" }}>
          <strong>Loyalty stamp card</strong>
          <p className="muted">
            Collect stamps on every order this season (loyalty_stamp_banner).
          </p>
          <FlagCallout
            flagKey="loyalty_stamp_banner"
            enabled={loyalty.enabled}
            variation={loyalty.variation}
            outcome={loyalty.outcome}
            blockedBy={loyalty.blockedBy}
          />
        </div>
      ) : null}

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
