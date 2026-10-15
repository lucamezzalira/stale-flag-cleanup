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
  const sizeGuide = useFlag("size_guide_panel");

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p>Catalog surface used to exercise abandoned promo traffic.</p>
        </div>
      </div>

      {sizeGuide.enabled ? (
        <section className="panel" style={{ marginBottom: "1rem" }}>
          <h2>Size guide</h2>
          <p className="muted">
            Chest / waist / hip chart for apparel SKUs. Kill this panel when the
            experiment is done.
          </p>
          <div className="panel-row">
            <span>S</span>
            <span>34–36 in</span>
          </div>
          <div className="panel-row">
            <span>M</span>
            <span>38–40 in</span>
          </div>
          <div className="panel-row">
            <span>L</span>
            <span>42–44 in</span>
          </div>
        </section>
      ) : null}
      <FlagCallout
        flagKey="size_guide_panel"
        enabled={sizeGuide.enabled}
        variation={sizeGuide.variation}
        outcome={sizeGuide.outcome}
        blockedBy={sizeGuide.blockedBy}
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
