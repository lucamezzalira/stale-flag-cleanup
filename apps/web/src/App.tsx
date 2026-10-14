import { Link, Route, Routes, useLocation } from "react-router-dom";
import { useFlags } from "./flags";
import { ListingPage } from "./pages/Listing";
import { CheckoutPage } from "./pages/Checkout";
import { WishlistPage } from "./pages/Wishlist";
import { SearchPage } from "./pages/Search";

const LINKS = [
  { to: "/", label: "Products" },
  { to: "/search", label: "Search" },
  { to: "/wishlist", label: "Wishlist" },
  { to: "/checkout", label: "Checkout" },
];

export function App() {
  const { loading, error } = useFlags();
  const { pathname } = useLocation();

  if (loading) {
    return <div className="loading">Loading Featurevisor datafile…</div>;
  }
  if (error) {
    const datafileUrl =
      (import.meta.env.VITE_DATAFILE_URL as string | undefined) || "(unset)";
    return (
      <main className="error">
        Could not load flags: {error}
        <p className="muted">
          Datafile URL: <code>{datafileUrl}</code>
        </p>
        <p className="muted">
          Local: <code>pnpm datafile:serve</code> and point{" "}
          <code>VITE_DATAFILE_URL</code> at that server. Deployed: rebuild with{" "}
          <code>pnpm infra:sync</code> so the app uses the CloudFront datafile.
        </p>
      </main>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Northline Supply</span>
          <span className="brand-tag">stale-flag demo shop</span>
        </div>
        <nav className="nav">
          {LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={pathname === link.to ? "active" : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="cart-chip">Cart · 2</div>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<ListingPage />} />
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/wishlist" element={<WishlistPage />} />
          <Route path="/search" element={<SearchPage />} />
        </Routes>
      </main>
    </div>
  );
}
