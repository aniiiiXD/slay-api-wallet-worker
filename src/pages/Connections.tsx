/**
 * Connections — data source B, and the only page in this app that does not
 * talk to the Worker.
 *
 * Grants live in the extension's own storage on this machine. They are never
 * sent to the Worker, so no amount of authenticating here would let a hosted
 * page read them: the dashboard has to ask the extension, and if the extension
 * is not there, the honest answer is "this data is not visible from here" —
 * not an empty list. An empty list would read as "you have no connections",
 * which is a different and possibly false claim.
 *
 * Revocation is immediate and total. The grant is deleted; the next call from
 * that origin has to go through a fresh consent screen in the extension.
 */

import { useCallback, useEffect, useState } from "react";
import { Notice, Spinner } from "../components/Notice";
import {
  ExtensionUnavailableError,
  ProviderError,
  SCOPE_COPY,
  describeProviderError,
  getProvider,
  resetDetection,
  slay,
  type Connection,
} from "../slay";
import { formatDateTime, formatRelative } from "../format";

type Status =
  | { kind: "detecting" }
  | { kind: "absent" }
  | { kind: "loading" }
  | { kind: "ready"; connections: Connection[] }
  | { kind: "blocked"; message: string }
  | { kind: "failed"; message: string };

export function Connections() {
  const [status, setStatus] = useState<Status>({ kind: "detecting" });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setActionError(null);
    const provider = await getProvider();
    if (!provider) {
      setStatus({ kind: "absent" });
      return;
    }
    setStatus({ kind: "loading" });
    try {
      const connections = await slay.listConnections();
      const sorted = [...connections].sort((a, b) => (b.grantedAt ?? 0) - (a.grantedAt ?? 0));
      setStatus({ kind: "ready", connections: sorted });
    } catch (err) {
      if (err instanceof ExtensionUnavailableError) {
        setStatus({ kind: "absent" });
      } else if (err instanceof ProviderError && err.isUnauthorized) {
        setStatus({ kind: "blocked", message: describeProviderError(err) });
      } else {
        setStatus({ kind: "failed", message: describeProviderError(err) });
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (origin: string) => {
    setBusy(origin);
    setActionError(null);
    try {
      const res = await slay.revokeConnection(origin);
      if (!res?.revoked) {
        // Say what actually happened. Reloading the list on a false would
        // make a failed revoke look like a success if the row went away for
        // some other reason.
        setActionError(
          `The extension did not revoke ${origin}. The grant may already be gone — reload to check.`
        );
      }
      setConfirming(null);
      await load();
    } catch (err) {
      setActionError(describeProviderError(err));
    } finally {
      setBusy(null);
    }
  };

  const retryDetection = () => {
    resetDetection();
    setStatus({ kind: "detecting" });
    void load();
  };

  return (
    <div className="stack-lg">
      <header className="page-head">
        <div>
          <span className="eyebrow">Connections</span>
          <h1 className="display">Sites with access.</h1>
        </div>
        {status.kind === "ready" ? (
          <button className="btn ghost inline" onClick={() => void load()}>
            Refresh
          </button>
        ) : null}
      </header>

      <p className="note source-note">
        <span className="source-tag">On-device</span>
        Read live from the browser extension. These grants are never uploaded to Slay Money's
        servers, so they exist only in this browser — signing in on another device will not show
        them.
      </p>

      {actionError ? (
        <Notice tone="error" title="That didn't work">
          <p>{actionError}</p>
        </Notice>
      ) : null}

      {status.kind === "detecting" ? <Spinner label="Looking for the extension" /> : null}
      {status.kind === "loading" ? <Spinner label="Reading connections" /> : null}

      {status.kind === "absent" ? (
        <Notice
          tone="info"
          eyebrow="Extension required"
          title="This data lives on your device"
          actions={
            <button className="btn ghost inline" onClick={retryDetection}>
              Check again
            </button>
          }
        >
          <p>
            The Slay Money extension isn't available in this browser, so there is nothing for the
            dashboard to read. Connection grants are stored by the extension itself and are never
            synced to the Worker — which is why your account, balance and history load fine on
            this page while this list cannot.
          </p>
          <p>
            Install the extension in this browser (or reload after installing it), and this page
            will show every site you've connected, with a way to cut each one off.
          </p>
        </Notice>
      ) : null}

      {status.kind === "blocked" ? (
        <Notice tone="warn" eyebrow="Not allowed" title="The extension refused this origin">
          <p>{status.message}</p>
          <p className="text-faint">
            The extension gates <span className="mono-sm">slay_listConnections</span> and{" "}
            <span className="mono-sm">slay_revokeConnection</span> to an allow-list on purpose:
            any page that could call them would be able to enumerate every other site you have
            connected.
          </p>
        </Notice>
      ) : null}

      {status.kind === "failed" ? (
        <Notice
          tone="error"
          eyebrow="Extension"
          title="Couldn't read your connections"
          actions={
            <button className="btn ghost inline" onClick={() => void load()}>
              Try again
            </button>
          }
        >
          <p>{status.message}</p>
        </Notice>
      ) : null}

      {status.kind === "ready" && status.connections.length === 0 ? (
        <Notice tone="info" title="No sites are connected">
          <p>
            The extension is installed and reachable, and it holds no grants. When you approve a
            site's connection request, it will appear here.
          </p>
        </Notice>
      ) : null}

      {status.kind === "ready" && status.connections.length > 0 ? (
        <ul className="conn-list">
          {status.connections.map((conn) => (
            <li key={conn.origin} className="conn-row card">
              <div className="conn-head">
                <span className="conn-origin" title={conn.origin}>
                  {conn.origin}
                </span>
                <span className="conn-when" title={formatDateTime(conn.grantedAt)}>
                  Granted {formatRelative(conn.grantedAt)}
                </span>
              </div>

              <div className="conn-scopes">
                {(conn.scopes ?? []).length === 0 ? (
                  <span className="conn-chip">no scopes</span>
                ) : (
                  conn.scopes.map((scope) => (
                    <span
                      key={scope}
                      className={`conn-chip ${scope === "ledger" || scope === "write" ? "strong" : ""}`}
                    >
                      {SCOPE_COPY[scope]?.label ?? scope}
                    </span>
                  ))
                )}
              </div>

              <div className="conn-detail">
                {(conn.scopes ?? []).map((scope) =>
                  SCOPE_COPY[scope] ? <span key={scope}>{SCOPE_COPY[scope]?.detail}</span> : null
                )}
              </div>

              {confirming === conn.origin ? (
                <div className="conn-confirm">
                  <p className="conn-warn">
                    Revoke access for {conn.origin}? It loses its grant immediately and must ask
                    again from scratch.
                  </p>
                  <div className="conn-actions">
                    <button
                      className="btn danger inline"
                      onClick={() => void revoke(conn.origin)}
                      disabled={busy === conn.origin}
                    >
                      {busy === conn.origin ? "Revoking…" : "Yes, revoke"}
                    </button>
                    <button
                      className="btn ghost inline"
                      onClick={() => setConfirming(null)}
                      disabled={busy === conn.origin}
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <div className="conn-actions">
                  <button
                    className="btn ghost inline"
                    onClick={() => {
                      setActionError(null);
                      setConfirming(conn.origin);
                    }}
                  >
                    Revoke
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
