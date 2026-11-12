// The four things the correction screen does; the route takes one as
// `?mode=` (the order detail screen links to `?mode=void`).
export const CORRECTION_MODES = ["diskon", "void", "refund", "struk"] as const;
export type CorrectionMode = (typeof CORRECTION_MODES)[number];

export function isCorrectionMode(value: unknown): value is CorrectionMode {
  return (CORRECTION_MODES as readonly unknown[]).includes(value);
}
