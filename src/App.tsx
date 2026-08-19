/**
 * Shell + session gate.
 *
 * Bootstrapping probes /api/wallet once and sorts the outcome into three
 * states that are never merged, because each one needs a different thing from
 * the user:
 *
 *   signed-out — the Worker rejected our credentials      → sign in
 *   offline    — the request never reached the Worker     → retry
 *   ready      — we have a session                        → render the app
 *
 * (The extension-absent state is the fourth, and it belongs to the Connections
 * page alone; it says nothing about the account.)
 */

import { useCallback, useEffect, useState } from "react";
import { ApiError, NetworkError, auth, session, wallet, type Wallet } from "./api";
import { Notice, Spinner } from "./components/Notice";
import { Sidebar } from "./components/Sidebar";
import { Activity } from "./pages/Activity";
import { Connections } from "./pages/Connections";
import { Overview } from "./pages/Overview";
import { SignIn } from "./pages/SignIn";
import { Integrate } from "./pages/Integrate";
import { Keys } from "./pages/Keys";
import { routeFromHash, type Route } from "./routes";

type Boot =
  | { kind: "checking" }
  | { kind: "signed-out" }
  | { kind: "offline"; message: string }
  | { kind: "broken"; message: string }
  | { kind: "ready"; wallet: Wallet };

export function App() {
  const [boot, setBoot] = useState<Boot>({ kind: "checking" });
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));

  /* Hash routing — enough for three pages, and it survives a refresh. */
  useEffect(() => {
    const onHash = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((next: Route) => {
    window.location.hash = `#/${next}`;
    setRoute(next);
  }, []);

  const check = useCallback(async () => {
    setBoot({ kind: "checking" });
    try {
      const w = await wallet.me();
      setBoot({ kind: "ready", wallet: w });
    } catch (err) {
      if (err instanceof NetworkError) {
        setBoot({ kind: "offline", message: err.message });
      } else if (err instanceof ApiError && err.isAuth) {
        session.clear();
        setBoot({ kind: "signed-out" });
      } else if (err instanceof ApiError) {
        setBoot({ kind: "broken", message: `${err.message} (HTTP ${err.status})` });
      } else {
        setBoot({ kind: "broken", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const signOut = useCallback(async () => {
    await auth.signOut();
    setBoot({ kind: "signed-out" });
    navigate("overview");
  }, [navigate]);

  if (boot.kind === "checking") {
    return (
      <div className="auth-shell">
        <Spinner label="Checking your session" />
      </div>
    );
  }

  if (boot.kind === "signed-out") {
    return <SignIn onSignedIn={() => void check()} />;
  }

  /**
   * Connections works without the Worker.
   *
   * Its data comes from the browser extension, on this device — no session, no
   * network. Gating it behind a Worker-backed sign-in meant that when the
   * Worker was unreachable (CORS, outage, offline) the one feature that did
   * not depend on it became unreachable too. Anyone trying to revoke a site's
   * access during an incident would have been stuck.
   */
  if ((boot.kind === "offline" || boot.kind === "broken") && route === "connections") {
    return (
      <div className="shell">
        <Sidebar
          route={route}
          onNavigate={navigate}
          onSignOut={() => void signOut()}
          handle={null}
        />
        <main className="main">
          <Notice tone="warn" title="Signed-out mode">
            The Slay API is unreachable, so account data is unavailable. This
            page still works — connections are stored by the extension on this
            device, not on a server.
          </Notice>
          <Connections />
        </main>
      </div>
    );
  }

  if (boot.kind === "offline" || boot.kind === "broken") {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="brand">
            <span className="brand-word">Slay</span>
            <span className="brand-dot" />
          </div>
          {boot.kind === "offline" ? (
            <Notice
              tone="warn"
              eyebrow="Network"
              title="Can't reach the Slay Money API"
              actions={
                <>
                  <button className="btn primary inline" onClick={() => void check()}>
                    Try again
                  </button>
                  <button className="btn ghost" onClick={() => navigate("connections")}>
                    Manage connections instead
                  </button>
                </>
              }
            >
              <p>
                The dashboard couldn't contact the Worker, so it can't tell whether you're signed
                in. You may be offline. Nothing about your account has changed.
              </p>
            </Notice>
          ) : (
            <Notice
              tone="error"
              eyebrow="API"
              title="The API returned an error"
              actions={
                <>
                  <button className="btn primary inline" onClick={() => void check()}>
                    Try again
                  </button>
                  <button className="btn ghost" onClick={() => navigate("connections")}>
                    Manage connections instead
                  </button>
                  <button className="btn ghost inline" onClick={() => void signOut()}>
                    Sign out
                  </button>
                </>
              }
            >
              <p className="mono-sm">{boot.message}</p>
            </Notice>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <Sidebar
        route={route}
        onNavigate={navigate}
        onSignOut={() => void signOut()}
        handle={boot.wallet.handle}
      />
      <main className="main">
        {route === "overview" ? (
          <Overview onSignOut={() => void signOut()} onSeeAll={() => navigate("activity")} />
        ) : null}
        {route === "activity" ? <Activity onSignOut={() => void signOut()} /> : null}
        {route === "keys" ? <Keys onSignOut={() => void signOut()} /> : null}
        {route === "integrate" ? <Integrate /> : null}
        {route === "connections" ? <Connections /> : null}
      </main>
    </div>
  );
}
