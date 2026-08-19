/**
 * One box for every non-happy state, with a tone that says which kind it is.
 *
 * There are three failure modes in this app and they are never collapsed into
 * a single "Something went wrong": signed out (fixable by signing in), offline
 * (fixable by retrying), and extension absent (fixable only by installing it,
 * and not a failure of the account at all). Each caller picks its own title
 * and body; this component only owns the shape.
 */

import type { ReactNode } from "react";

export type Tone = "info" | "warn" | "error";

export function Notice(props: {
  tone?: Tone;
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const tone = props.tone ?? "info";
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : undefined}>
      {props.eyebrow ? <span className="eyebrow">{props.eyebrow}</span> : null}
      <h3 className="notice-title">{props.title}</h3>
      {props.children ? <div className="notice-body">{props.children}</div> : null}
      {props.actions ? <div className="notice-actions">{props.actions}</div> : null}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="loading-dot" />
      <span className="loading-label">{label}</span>
    </div>
  );
}
