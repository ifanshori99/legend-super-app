// One clock for the food-safety screens: expiry alerts and "today" checks
// refresh every minute without a per-row timer. Screens use it only for
// filtering and for text rendered after data loads, so SSR and hydration agree.
import * as React from "react";

export function useMinuteClock(): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
