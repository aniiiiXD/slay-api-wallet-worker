/**
 * Left sidebar navigation.
 *
 * Replaces the topbar. Sections are grouped (Money / Build / Access) because
 * the group is a real distinction to a reader — "where my money is" and "what
 * has access to it" are different questions — and the flat topbar hid it.
 *
 * Each item still carries its data source. That label is a property of the
 * product, not an implementation detail: "On-device" means the data physically
 * cannot be read by Slay's servers, and someone deciding whether to trust a
 * page deserves to see that without opening a README.
 */

import type { Route } from "../routes";
import { ROUTES, GROUPS } from "../routes";

export function Sidebar({
  route,
  onNavigate,
  onSignOut,
  handle,
}: {
  route: Route;
  onNavigate: (route: Route) => void;
  onSignOut: () => void;
  handle: string | null;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-word">Slay</span>
          <span className="brand-dot" />
        </div>
        <div className="brand-sub">Wallet dashboard</div>
      </div>

      <nav className="sidenav" aria-label="Dashboard sections">
        {GROUPS.map((group) => {
          const items = ROUTES.filter((r) => r.group === group);
          if (items.length === 0) return null;
          return (
            <div className="sidenav-group" key={group}>
              <div className="sidenav-group-title">{group}</div>
              {items.map((item) => (
                <button
                  key={item.id}
                  className={`sidenav-item ${route === item.id ? "active" : ""}`}
                  onClick={() => onNavigate(item.id)}
                  aria-current={route === item.id ? "page" : undefined}
                >
                  <span className="sidenav-label">{item.label}</span>
                  <span className="sidenav-source">{item.source}</span>
                </button>
              ))}
            </div>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        {handle ? <div className="sidebar-handle">@{handle}</div> : null}
        <button className="linkish" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
