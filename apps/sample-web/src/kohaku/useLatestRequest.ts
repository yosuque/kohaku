import { useCallback, useRef, useState } from "react";

/**
 * The request-generation guard shared by DashboardPage (runCompose + handleEvent) and ChatPage's
 * StreamingAssistant (handleEvent).
 * `run()` increments a monotonic sequence number per call; if a newer `run()` starts before an older one settles,
 * the older one's `onResult` / `onError` / `onSettled` (including the `loading` teardown) are skipped entirely —
 * the display never rolls back to a stale response, even when responses arrive out of order.
 *
 * Multiple call sites in the same component (e.g. DashboardPage's runCompose and handleEvent) are expected to
 * share ONE `useLatestRequest()` instance, so that starting either one supersedes an in-flight run of the other.
 */
export interface RunOptions<T> {
  /** Runs synchronously before the task starts, unconditionally (not guarded by the sequence check) — for
   * clearing a previous error/result before starting a new attempt (matches the prior inline `setError(null)`). */
  onStart?: () => void;
  /** Runs only if this call is still the latest when the task resolves. */
  onResult: (result: T) => void;
  /** Runs only if this call is still the latest when the task rejects. */
  onError?: (error: unknown) => void;
  /** Runs only if this call is still the latest, after onResult/onError (settles `loading` to false first). */
  onSettled?: () => void;
}

export interface UseLatestRequest {
  loading: boolean;
  run: <T>(task: () => Promise<T>, opts: RunOptions<T>) => Promise<void>;
}

export function useLatestRequest(): UseLatestRequest {
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  const run = useCallback(async <T>(task: () => Promise<T>, opts: RunOptions<T>): Promise<void> => {
    const seq = ++seqRef.current;
    setLoading(true);
    opts.onStart?.();
    try {
      const result = await task();
      if (seq !== seqRef.current) return;
      opts.onResult(result);
    } catch (e) {
      if (seq === seqRef.current) opts.onError?.(e);
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
        opts.onSettled?.();
      }
    }
  }, []);

  return { loading, run };
}
