import * as React from "react";

/** Reuse the key after a failed request; a changed request is a new attempt. */
export function useAttemptKey() {
  const attempt = React.useRef<{ signature: string; key: string } | null>(null);
  return React.useMemo(
    () => ({
      keyFor(payload: unknown): string {
        const signature = JSON.stringify(payload);
        if (attempt.current?.signature !== signature)
          attempt.current = { signature, key: crypto.randomUUID() };
        return attempt.current.key;
      },
      settle() {
        attempt.current = null;
      },
    }),
    [],
  );
}
