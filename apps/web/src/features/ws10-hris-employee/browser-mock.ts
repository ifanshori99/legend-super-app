// Mock-only controls the mock runtime installs (features/ws10-hris-employee/
// mock.ts). They are used for the clickable mockup and the Playwright spec;
// `API_MOCK` is inlined at build time, so a production bundle never reaches
// `window.__legendHrisMock`.
import { API_MOCK } from "@/lib/api/mock-flag";

export type HrisMockControl = {
  /** The outlet screen's current 30-second QR code. */
  currentQrToken(): string;
  /** Registers this device as bound, the way a supervisor would (F25). */
  bindDevice(deviceIdHash: string): void;
};

export function hrisMockControl(): HrisMockControl | null {
  if (!API_MOCK || typeof window === "undefined") return null;
  return (
    (window as unknown as { __legendHrisMock?: HrisMockControl })
      .__legendHrisMock ?? null
  );
}
