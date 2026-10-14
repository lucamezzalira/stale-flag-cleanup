import { FlagCallout } from "../FlagCallout";
import { useFlag } from "../flags";

export function WishlistPage() {
  const wishlist = useFlag("wishlist");
  const sharing = useFlag("wishlist_sharing");
  const qr = useFlag("wishlist_sharing_qr");

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Wishlist</h1>
          <p>
            Nested flags: parent off short-circuits children with
            blocked_by_parent events.
          </p>
        </div>
      </div>

      <section className="panel">
        <h2>Saved items</h2>
        {wishlist.enabled ? (
          <div className="panel-row">
            <span>Classic Tee</span>
            <span className="price">$28</span>
          </div>
        ) : (
          <div className="empty-state">
            Wishlist section is hidden while the parent flag is off.
          </div>
        )}
        <FlagCallout
          flagKey="wishlist"
          enabled={wishlist.enabled}
          variation={wishlist.variation}
          outcome={wishlist.outcome}
          blockedBy={wishlist.blockedBy}
        />
      </section>

      <div className="split">
        <section className="panel">
          <h2>Share wishlist</h2>
          {sharing.enabled ? (
            <button type="button" className="btn secondary">
              Copy share link
            </button>
          ) : (
            <div className="empty-state">Share action unavailable.</div>
          )}
          <FlagCallout
            flagKey="wishlist_sharing"
            enabled={sharing.enabled}
            variation={sharing.variation}
            outcome={sharing.outcome}
            blockedBy={sharing.blockedBy}
          />
        </section>

        <section className="panel">
          <h2>QR share</h2>
          {qr.enabled ? (
            <div className="qr-box" aria-label="QR placeholder" />
          ) : (
            <div className="empty-state">QR option unavailable.</div>
          )}
          <FlagCallout
            flagKey="wishlist_sharing_qr"
            enabled={qr.enabled}
            variation={qr.variation}
            outcome={qr.outcome}
            blockedBy={qr.blockedBy}
          />
        </section>
      </div>
    </div>
  );
}
