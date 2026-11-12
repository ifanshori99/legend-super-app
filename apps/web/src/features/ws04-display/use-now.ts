import { useEffect, useState } from "react";

/** Re-renders once a second so countdowns and expiry stay true. */
export function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
