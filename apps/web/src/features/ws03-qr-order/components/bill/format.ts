// Date and time for the guest screens, in the outlet's own time zone (PRD:
// business dates and wall-clock times use the outlet time zone).
export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}
