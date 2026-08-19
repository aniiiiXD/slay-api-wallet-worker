/**
 * Agent API keys — issue, restrict, freeze, rotate, revoke.
 *
 * This screen is the rebuild the note in routes.ts asked for. The previous
 * Agents pages were deleted because every endpoint behind them 404'd and they
 * ran on fixtures; these endpoints were checked against production first and
 * answer 401, not 404. There are no fixtures here. When the Worker has nothing
 * to say, the screen says so.
 *
 * ── Three things the UI exists to get right ──────────────────────────────
 *
 * 1. THE SECRET IS SHOWN ONCE. It comes back only on create and rotate; the
 *    Worker hashes it on arrival and no endpoint returns it again. So it is
 *    presented as a modal that must be dismissed deliberately, saying plainly
 *    that closing it ends the only chance to copy it. A toast would be wrong —
 *    it disappears on its own.
 *
 * 2. TRADING APPROVAL IS NOT THE KEY. The account must separately be approved
 *    to move money programmatically, and the Worker re-checks that on every
 *    write. A key with `tx:write` on an unapproved account gets 403 forever
 *    and looks broken. The screen shows the account's state up front and
 *    explains what tx:write will and will not do until it changes.
 *
 * 3. AMOUNTS ARE DECIMAL STRINGS. CC has six decimal places. Nothing here
 *    parses a limit to a number — they are typed, validated by shape, and
 *    sent as strings, because a float round-trip is how "25" quietly becomes
 *    a different cap.
 */

import { useState } from "react";
import {
  API_URL,
  agents,
  trading,
  type TradingStatus,
  CAPABILITIES,
  type Agent,
  type AgentWithSecret,
  type Capability,
  type NewAgent,
} from "../api";
import { useAsync } from "../components/useAsync";
import { ErrorState } from "../components/ErrorState";
import { Notice, Spinner } from "../components/Notice";

/** A positive decimal string — the same shape the Worker's isDecimal accepts. */
const isDecimal = (v: string) => /^\d+(\.\d+)?$/.test(v.trim()) && v.trim() !== "";

const CAP_HELP: Record<Capability, string> = {
  "balance:read": "Read the wallet balance.",
  "tx:read": "Read transaction history and look up transfers.",
  "tx:write": "Move money. Requires both spend caps below.",
};

function when(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString();
}

/* ────────── the one-time secret ────────── */

function SecretModal({
  created,
  onClose,
}: {
  created: AgentWithSecret;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-labelledby="secret-title">
      <div className="modal">
        <span className="eyebrow">Copy it now</span>
        <h2 id="secret-title">{created.name}</h2>
        <p className="dim">
          This is the only time this secret is shown. It is hashed on the
          server and cannot be retrieved — if you lose it, rotate the key.
        </p>
        <pre className="code-block secret">{created.secret}</pre>
        <div className="modal-actions">
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText(created.secret).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied" : "Copy secret"}
          </button>
          <button className="btn ghost inline" onClick={onClose}>
            I've saved it
          </button>
        </div>
        {created.oldExpiresAt ? (
          <p className="dim small">
            The previous key keeps working until{" "}
            {new Date(created.oldExpiresAt).toLocaleString()}, so you can deploy
            this one without downtime.
          </p>
        ) : null}
      </div>
    </div>
  );
}


/* ────────── applying for the account grant ────────── */

/**
 * The other half of the gate.
 *
 * Minting a key is self-service; being allowed to move money with one is not.
 * The screen used to state the second fact and offer no way to act on it —
 * a user read "this account isn't approved", and that was the end of the road.
 * `POST /api/trading/apply` existed the whole time with nothing calling it.
 *
 * Deliberately not a one-click button. An operator approving this is setting
 * a ceiling on how much a program may move from this wallet, and they need to
 * know what it is for and how big it is expected to get. Two fields is the
 * least that can honestly be asked.
 */
function ApplyForm({
  state,
  onApplied,
}: {
  state: TradingStatus["state"];
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [useCase, setUseCase] = useState("");
  const [volume, setVolume] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problems: string[] = [];
  if (!useCase.trim()) problems.push("Describe what the program will do.");
  if (!isDecimal(volume)) problems.push("Give an expected monthly volume in CC, as a number.");

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await trading.apply(useCase.trim(), volume.trim());
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  /* A suspended grant is not re-applied for. The Worker refuses it, because a
   * form should not be able to erase an operator's decision — so offering the
   * button here would only produce a 403 and a confused user. */
  if (state === "suspended") {
    return (
      <p className="dim small">
        Re-applying does not lift a suspension. Contact support to have it
        reviewed.
      </p>
    );
  }

  if (!open) {
    return (
      <button className="btn inline" onClick={() => setOpen(true)}>
        {state === "rejected" ? "Apply again" : "Apply for approval"}
      </button>
    );
  }

  return (
    <div className="card key-form">
      <div className="card-head">
        <h2>Apply to move money programmatically</h2>
      </div>

      <label className="kf">
        <span>What will the program do?</span>
        <textarea
          value={useCase}
          onChange={(e) => setUseCase(e.target.value)}
          rows={3}
          placeholder="Paying out marketplace sellers nightly from our own wallet."
          autoFocus
        />
        <small>
          Read by a person, not a filter. Say what moves money and what triggers it.
        </small>
      </label>

      <label className="kf">
        <span>Expected monthly volume (CC)</span>
        <input
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
          placeholder="5000"
          inputMode="decimal"
        />
        <small>
          An estimate. It sets the ceiling you are reviewed against, not a cap
          you are held to — approval comes back with explicit per-transaction
          and per-day limits.
        </small>
      </label>

      {problems.length ? (
        <ul className="kf-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <Notice tone="error" title="Couldn't submit the application">
          {error}
        </Notice>
      ) : null}

      <div className="modal-actions">
        <button
          className="btn"
          disabled={problems.length > 0 || busy}
          onClick={() => void submit()}
        >
          {busy ? "Submitting…" : "Submit application"}
        </button>
        <button className="btn ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ────────── create ────────── */


function CreateForm({
  approved,
  onCreated,
  onCancel,
}: {
  approved: boolean;
  onCreated: (a: AgentWithSecret) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [caps, setCaps] = useState<Capability[]>(["balance:read"]);
  const [perTx, setPerTx] = useState("");
  const [perDay, setPerDay] = useState("");
  const [recipients, setRecipients] = useState("");
  const [ips, setIps] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canWrite = caps.includes("tx:write");

  /* Mirrors the Worker's validateRestrictions so the failure is immediate and
   * specific rather than a 422 after a round trip. The server still enforces
   * it — this is a convenience, not the boundary. */
  const problems: string[] = [];
  if (!name.trim()) problems.push("Give the key a name — it identifies it in logs.");
  if (caps.length === 0) problems.push("Choose at least one capability.");
  if (canWrite && !isDecimal(perTx)) problems.push("tx:write needs a per-transaction cap.");
  if (canWrite && !isDecimal(perDay)) problems.push("tx:write needs a daily cap.");

  const toggle = (c: Capability) =>
    setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const lines = (v: string) =>
    v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: NewAgent = {
        name: name.trim(),
        restrictions: {
          capabilities: caps,
          ...(canWrite
            ? { limits: { perTransactionCc: perTx.trim(), perDayCc: perDay.trim() } }
            : {}),
          allowedRecipients: lines(recipients).length ? lines(recipients) : null,
          allowedIps: lines(ips).length ? lines(ips) : null,
        },
      };
      onCreated(await agents.create(body));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="card key-form">
      <div className="card-head">
        <h2>New key</h2>
      </div>

      <label className="kf">
        <span>Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="payouts-worker"
          autoFocus
        />
        <small>Shown in logs and in the list. Not visible to the key holder.</small>
      </label>

      <fieldset className="kf">
        <legend>Capabilities</legend>
        {CAPABILITIES.map((c) => (
          <label key={c} className="kf-check">
            <input type="checkbox" checked={caps.includes(c)} onChange={() => toggle(c)} />
            <code>{c}</code>
            <small>{CAP_HELP[c]}</small>
          </label>
        ))}
      </fieldset>

      {canWrite ? (
        <>
          <div className="kf-row">
            <label className="kf">
              <span>Per transaction (CC)</span>
              <input
                value={perTx}
                onChange={(e) => setPerTx(e.target.value)}
                placeholder="25"
                inputMode="decimal"
              />
            </label>
            <label className="kf">
              <span>Per day (CC)</span>
              <input
                value={perDay}
                onChange={(e) => setPerDay(e.target.value)}
                placeholder="250"
                inputMode="decimal"
              />
            </label>
          </div>
          {!approved ? (
            <Notice tone="warn" title="This account can't move money yet">
              The key will be created and its reads will work, but every
              transfer returns <code>403 trading_not_approved</code> until the
              account is approved for programmatic trading. That check runs on
              every request, so approval takes effect without reissuing keys.
            </Notice>
          ) : null}
        </>
      ) : null}

      <label className="kf">
        <span>
          Allowed recipients <em>optional</em>
        </span>
        <textarea
          value={recipients}
          onChange={(e) => setRecipients(e.target.value)}
          rows={2}
          placeholder="karan, slay@team — one per line or comma separated"
        />
        <small>Leave empty to allow any recipient.</small>
      </label>

      <label className="kf">
        <span>
          Allowed IPs <em>optional</em>
        </span>
        <textarea
          value={ips}
          onChange={(e) => setIps(e.target.value)}
          rows={2}
          placeholder="203.0.113.7"
        />
        <small>Leave empty to allow any source address.</small>
      </label>

      {problems.length ? (
        <ul className="kf-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {error ? <Notice tone="error" title="Couldn't create the key">{error}</Notice> : null}

      <div className="modal-actions">
        <button className="btn" disabled={problems.length > 0 || busy} onClick={() => void submit()}>
          {busy ? "Creating…" : "Create key"}
        </button>
        <button className="btn ghost inline" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ────────── one row ────────── */

function KeyRow({
  agent,
  onChanged,
  onRotated,
}: {
  agent: Agent;
  onChanged: () => void;
  onRotated: (a: AgentWithSecret) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const lim = agent.restrictions.limits;

  return (
    <div className={`card key-row${agent.frozen ? " is-frozen" : ""}`}>
      <div className="key-head">
        <div>
          <h3>
            {agent.name}
            {agent.frozen ? <span className="key-chip warn">Frozen</span> : null}
          </h3>
          <code className="key-prefix">{agent.prefix}…</code>
        </div>
        <div className="key-actions">
          <button
            className="btn ghost inline"
            disabled={busy !== null}
            onClick={() =>
              void run("freeze", () => agents.freeze(agent.id, !agent.frozen))
            }
          >
            {agent.frozen ? "Unfreeze" : "Freeze"}
          </button>
          <button
            className="btn ghost inline"
            disabled={busy !== null}
            onClick={() =>
              void run("rotate", async () => onRotated(await agents.rotate(agent.id)))
            }
          >
            {busy === "rotate" ? "Rotating…" : "Rotate"}
          </button>
          {confirmRevoke ? (
            <>
              <button
                className="btn danger inline"
                disabled={busy !== null}
                onClick={() => void run("revoke", () => agents.revoke(agent.id))}
              >
                Confirm revoke
              </button>
              <button className="btn ghost inline" onClick={() => setConfirmRevoke(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className="btn ghost inline" onClick={() => setConfirmRevoke(true)}>
              Revoke
            </button>
          )}
        </div>
      </div>

      <div className="key-meta">
        {agent.restrictions.capabilities.map((c) => (
          <code key={c} className="key-chip">
            {c}
          </code>
        ))}
        {lim.perTransactionCc ? <span className="dim">≤ {lim.perTransactionCc} CC / tx</span> : null}
        {lim.perDayCc ? <span className="dim">≤ {lim.perDayCc} CC / day</span> : null}
        {agent.restrictions.allowedIps?.length ? (
          <span className="dim">{agent.restrictions.allowedIps.length} IP(s)</span>
        ) : null}
        {agent.restrictions.allowedRecipients?.length ? (
          <span className="dim">
            {agent.restrictions.allowedRecipients.length} recipient(s)
          </span>
        ) : null}
      </div>

      <div className="key-foot dim small">
        Created {when(agent.createdAt)} · Last used {when(agent.lastUsedAt)}
        {agent.lastUsedIp ? ` from ${agent.lastUsedIp}` : ""}
      </div>

      {error ? (
        <Notice tone="error" title="That didn't work">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}

/* ────────── page ────────── */

export function Keys({ onSignOut }: { onSignOut?: () => void }) {
  const list = useAsync(() => agents.list(), []);
  const status = useAsync(() => trading.status(), []);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<AgentWithSecret | null>(null);
  const [freezeAllBusy, setFreezeAllBusy] = useState(false);

  const approved = status.data?.state === "approved";
  const keys = list.data ?? [];

  return (
    <div className="stack-lg">
      <header className="page-head">
        <div>
          <span className="eyebrow">API keys</span>
          <h1 className="display">Let a program spend, on your terms.</h1>
        </div>
        <div className="key-actions">
          {keys.length > 0 ? (
            <button
              className="btn danger inline"
              disabled={freezeAllBusy}
              onClick={() => {
                setFreezeAllBusy(true);
                void agents
                  .freezeAll()
                  .then(() => list.reload())
                  .finally(() => setFreezeAllBusy(false));
              }}
              title="Freeze every key at once"
            >
              {freezeAllBusy ? "Freezing…" : "Freeze all"}
            </button>
          ) : null}
          {!creating ? (
            <button className="btn" onClick={() => setCreating(true)}>
              New key
            </button>
          ) : null}
        </div>
      </header>

      {/* The account-level gate, stated before anyone builds against a key. */}
      {status.data && !approved ? (
        <Notice
          tone="warn"
          eyebrow="Account"
          title={
            status.data.state === "suspended"
              ? "Programmatic trading is suspended"
              : status.data.state === "pending"
              ? "Programmatic trading is pending review"
              : "This account isn't approved to move money programmatically"
          }
        >
          Keys still work for reading balances and history. Transfers return{" "}
          <code>403 trading_not_approved</code> until this changes — it is
          checked on every request, so approval applies to existing keys
          immediately, with nothing to reissue.
          {status.data.reason ? <> Reason: {status.data.reason}</> : null}
          {status.data.state === "pending" ? (
            <p className="dim small">
              Applied{" "}
              {status.data.appliedAt
                ? new Date(status.data.appliedAt).toLocaleDateString()
                : "recently"}
              . A person reviews it; you will not need to reissue anything when
              it clears.
            </p>
          ) : (
            <div className="apply-cta">
              <ApplyForm state={status.data.state} onApplied={() => status.reload()} />
            </div>
          )}
        </Notice>
      ) : null}

      {creating ? (
        <CreateForm
          approved={approved}
          onCancel={() => setCreating(false)}
          onCreated={(a) => {
            setCreating(false);
            setSecret(a);
            list.reload();
          }}
        />
      ) : null}

      {list.loading ? <Spinner label="Loading keys" /> : null}

      {list.error ? (
        <ErrorState
          error={list.error}
          what="your API keys"
          onRetry={list.reload}
          {...(onSignOut ? { onSignOut } : {})}
        />
      ) : null}

      {!list.loading && !list.error && keys.length === 0 && !creating ? (
        <Notice eyebrow="Nothing yet" title="No keys issued">
          A key lets a server-side program read this wallet or spend from it
          under limits you set. It is shown once and can be frozen or revoked
          at any time.{" "}
          <a href={`${API_URL}/docs`} target="_blank" rel="noopener noreferrer">
            Read the API docs
          </a>
        </Notice>
      ) : null}

      {keys.map((a) => (
        <KeyRow
          key={a.id}
          agent={a}
          onChanged={list.reload}
          onRotated={(next) => {
            setSecret(next);
            list.reload();
          }}
        />
      ))}

      {secret ? <SecretModal created={secret} onClose={() => setSecret(null)} /> : null}
    </div>
  );
}
