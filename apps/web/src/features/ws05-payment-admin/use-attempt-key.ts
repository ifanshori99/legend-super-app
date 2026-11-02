import * as React from "react";
import { createAttemptKeyTracker } from "./attempt-key.ts";

/** Reuse the key after a failed request; a changed request is a new attempt. */
export function useAttemptKey() {
  return React.useMemo(() => createAttemptKeyTracker(), []);
}
