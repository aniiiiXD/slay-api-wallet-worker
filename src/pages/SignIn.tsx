/**
 * Email → OTP, the same Better Auth flow the extension and the app use.
 * The verify response carries a bearer token, which api.ts stores; on this
 * origin that token — not the cookie — is what keeps the session alive.
 */

import { useState } from "react";
import { ApiError, NetworkError, auth } from "../api";

type Step = "email" | "code";

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const describe = (err: unknown): string => {
    if (err instanceof NetworkError) {
      return "Couldn't reach the Slay Money API. Check your connection and try again.";
    }
    if (err instanceof ApiError) return err.message;
    return err instanceof Error ? err.message : String(err);
  };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await auth.sendCode(value);
      setStep("code");
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = otp.trim();
    if (code.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const r = await auth.verifyCode(email.trim(), code);
      if (!r.token) {
        // A 200 without a token means we have no credential this origin can
        // replay. Say so rather than dropping the user into an empty dashboard.
        setError(
          "Signed in, but the API did not return a session token. The dashboard needs one — try again."
        );
        return;
      }
      onSignedIn();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-word">Slay</span>
          <span className="brand-dot" />
        </div>

        <span className="eyebrow">Dashboard</span>

        {step === "email" ? (
          <form className="stack" onSubmit={submitEmail}>
            <h1 className="display">Sign in to your wallet.</h1>
            <p className="note">
              We'll email you a six-digit code. Same account as the extension and the mobile
              app.
            </p>
            <label className="field">
              <input
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </label>
            <button className="btn primary" type="submit" disabled={busy || !email.trim()}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : (
          <form className="stack" onSubmit={submitCode}>
            <h1 className="display">Check your email.</h1>
            <p className="note">
              We sent a code to <span className="mono-sm">{email.trim()}</span>.
            </p>
            <label className="field">
              <input
                type="text"
                name="one-time-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                className="mono-input"
                maxLength={8}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/[^0-9]/g, ""))}
                required
                autoFocus
              />
            </label>
            <button className="btn primary" type="submit" disabled={busy || otp.trim().length < 4}>
              {busy ? "Verifying…" : "Verify and continue"}
            </button>
            <button
              className="linkish"
              type="button"
              onClick={() => {
                setStep("email");
                setOtp("");
                setError(null);
              }}
            >
              Use a different email
            </button>
          </form>
        )}

        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}

        <p className="auth-foot note">
          Connections and revocation live in the browser extension, not here — this dashboard
          never uploads them.
        </p>
      </div>
    </div>
  );
}
