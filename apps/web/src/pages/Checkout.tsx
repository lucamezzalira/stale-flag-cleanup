import { FlagCallout } from "../FlagCallout";
import { useFlag } from "../flags";

export function CheckoutPage() {
  const redesign = useFlag("checkout_redesign");
  const shipping = useFlag("shipping_estimator");

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{redesign.enabled ? "Checkout" : "Checkout (classic)"}</h1>
          <p>
            Layout, purchase CTA hint, and shipping estimate variation on one
            path.
          </p>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <section className="panel">
            <h2>Order</h2>
            <div className="panel-row">
              <span>Classic Tee</span>
              <span className="price">$28</span>
            </div>
            <div className="panel-row">
              <span>Canvas Tote</span>
              <span className="price">$42</span>
            </div>
            <div className="panel-row">
              <strong>Total</strong>
              <strong className="price">$70</strong>
            </div>
            <div style={{ marginTop: "1rem" }}>
              <button type="button" className="btn">
                One-click buy
              </button>
              <p className="muted" style={{ marginTop: "0.5rem" }}>
                Express pay hint: skip the address book.
              </p>
            </div>
            <p className="muted" style={{ marginTop: "0.75rem" }}>
              Secure seal: encrypted checkout · Free returns · Carbon-neutral
              ship
            </p>
          </section>

          <section className="panel">
            <h2>Layout</h2>
            <p className="muted">
              {redesign.enabled
                ? "Redesign shell: denser summary, accent actions."
                : "Classic shell: stacked steps."}
            </p>
            <FlagCallout
              flagKey="checkout_redesign"
              enabled={redesign.enabled}
              variation={redesign.variation}
              outcome={redesign.outcome}
              blockedBy={redesign.blockedBy}
            />
          </section>
        </div>

        <section className="panel">
          <h2>Shipping estimate</h2>
          {!shipping.enabled ? (
            <div className="empty-state">Estimator not shown for this bucket.</div>
          ) : shipping.variation === "estimate_detailed" ? (
            <div className="stack">
              <div className="panel-row">
                <span>Window</span>
                <span>2-4 business days</span>
              </div>
              <div className="panel-row">
                <span>Tracking</span>
                <span>Included</span>
              </div>
              <div className="panel-row">
                <span>Cost</span>
                <span className="price">$5.00</span>
              </div>
            </div>
          ) : (
            <p>
              ~3 days · <span className="price">$5</span>
            </p>
          )}
          <FlagCallout
            flagKey="shipping_estimator"
            enabled={shipping.enabled}
            variation={shipping.variation}
            outcome={shipping.outcome}
            blockedBy={shipping.blockedBy}
          />
        </section>
      </div>
    </div>
  );
}