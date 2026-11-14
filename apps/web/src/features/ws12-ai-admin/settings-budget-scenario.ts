// Budget scenario of the "Pengaturan AI" page mockup, read from `?state=`
// (VITE_API_MOCK=true only). Shared by the governance mock (cap) and the usage
// mock (this month's spend) so the budget card shows one consistent picture.
//   empty | device | failed | expired    AI not active yet: cap Rp 0, spent Rp 0
//   connected | detected | disabled      Rp 125.000 used of a Rp 500.000 cap (25%)
// Any other URL (the admin page, no `?state=`) keeps the default fixtures.

export type SettingsBudgetScenario = { capIdr: number; usedIdr: number };

const OFF_STATES = new Set(["empty", "device", "failed", "expired"]);
const ON_STATES = new Set(["connected", "detected", "disabled"]);

export function settingsBudgetScenario(): SettingsBudgetScenario | null {
  const search = (globalThis as { location?: { search?: string } }).location
    ?.search;
  if (search === undefined) return null;
  const state = new URLSearchParams(search).get("state");
  if (state === null) return null;
  if (OFF_STATES.has(state)) return { capIdr: 0, usedIdr: 0 };
  if (ON_STATES.has(state)) return { capIdr: 500_000, usedIdr: 125_000 };
  return null;
}
