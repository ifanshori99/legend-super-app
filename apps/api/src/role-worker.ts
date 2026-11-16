// Import right after ./load-env in the worker entrypoint, before anything that
// loads config/env. The production env check reads this marker to know the
// process is the worker (it never gets the payout grantor login). Only code
// sets it: an environment variable alone never exempts the api (legend-9n1mu).
(globalThis as { __LEGEND_PROCESS_ROLE?: string }).__LEGEND_PROCESS_ROLE =
  "worker";
