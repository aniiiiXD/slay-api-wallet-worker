/**
 * The smallest thing that counts as data loading: run a promise, expose
 * { data, error, loading, reload }, and ignore results from a run that has
 * been superseded or unmounted. No state library, by design.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncState<T> = {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
};

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
  opts?: {
    /**
     * Re-run silently every N ms. A background refresh never touches
     * `loading` and never replaces good data with an error — flashing a
     * spinner over live numbers every minute would make "live" feel broken,
     * and a transient poll failure shouldn't blank a page that was fine.
     */
    refreshMs?: number;
  }
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // Keep the latest fn without making it a dependency of the effect —
  // callers pass an inline arrow, which would otherwise refetch every render.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const ms = opts?.refreshMs;
    if (!ms) return;
    const id = setInterval(() => {
      fnRef
        .current()
        .then((value) => setData(value))
        .catch(() => {
          /* keep the last good data — see the note above */
        });
    }, ms);
    return () => clearInterval(id);
  }, [opts?.refreshMs]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((value) => {
        if (!live) return;
        setData(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err);
        setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
