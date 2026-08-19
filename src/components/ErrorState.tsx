/**
 * Renders a Worker-side failure as the right one of three messages.
 *
 * `NetworkError` and an auth `ApiError` are genuinely different events with
 * different fixes, and everything else is a third case; flattening them into
 * one string is how a dashboard ends up telling someone to check their
 * connection when the real answer is that their session expired.
 */

import { ApiError, NetworkError } from "../api";
import { Notice } from "./Notice";

export function ErrorState({
  error,
  onRetry,
  onSignOut,
  what,
}: {
  error: unknown;
  onRetry?: () => void;
  onSignOut?: () => void;
  /** What was being loaded, e.g. "your balance". */
  what?: string;
}) {
  const subject = what ?? "this page";

  if (error instanceof NetworkError) {
    return (
      <Notice
        tone="warn"
        eyebrow="Network"
        title="Can't reach the Slay Money API"
        actions={
          onRetry ? (
            <button className="btn ghost inline" onClick={onRetry}>
              Try again
            </button>
          ) : null
        }
      >
        <p>
          The request for {subject} never made it to the Worker. You may be offline, or the
          API may be unreachable from this network. Nothing was changed.
        </p>
      </Notice>
    );
  }

  if (error instanceof ApiError && error.isAuth) {
    return (
      <Notice
        tone="warn"
        eyebrow="Session"
        title="Your session has expired"
        actions={
          onSignOut ? (
            <button className="btn primary inline" onClick={onSignOut}>
              Sign in again
            </button>
          ) : null
        }
      >
        <p>The Worker rejected the stored credentials. Sign in with your email to continue.</p>
      </Notice>
    );
  }

  const message =
    error instanceof ApiError
      ? `${error.message} (HTTP ${error.status})`
      : error instanceof Error
        ? error.message
        : String(error);

  return (
    <Notice
      tone="error"
      eyebrow="API"
      title={`Couldn't load ${subject}`}
      actions={
        onRetry ? (
          <button className="btn ghost inline" onClick={onRetry}>
            Try again
          </button>
        ) : null
      }
    >
      <p className="mono-sm">{message}</p>
    </Notice>
  );
}
