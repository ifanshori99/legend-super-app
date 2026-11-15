// Query keys of the employee PWA, in a file with no imports so the root node
// tests can load them without the API client. Hierarchical under "hris" so one
// invalidation (after a clock or a correction) refreshes the whole Beranda.

export const hrisKeys = {
  all: ["hris"] as const,
  // Keyed by the session user: a second account on the same tab never reads
  // the first account's cached profile (and, through it, their queue).
  profile: (userId: string) => [...hrisKeys.all, "profile", userId] as const,
  dayLogs: (employeeId: string, businessDate: string) =>
    [...hrisKeys.all, "day-logs", employeeId, businessDate] as const,
  logPages: (employeeId: string) =>
    [...hrisKeys.all, "log-pages", employeeId] as const,
  correctionPages: (employeeId: string) =>
    [...hrisKeys.all, "correction-pages", employeeId] as const,
  pendingCorrections: (employeeId: string) =>
    [...hrisKeys.all, "corrections", "pending", employeeId] as const,
  shifts: (employeeId: string, from: string, to: string) =>
    [...hrisKeys.all, "shifts", employeeId, from, to] as const,
  announcements: () => [...hrisKeys.all, "announcements"] as const,
  positions: () => [...hrisKeys.all, "positions"] as const,
};
