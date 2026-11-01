// Collects `features/<ws>-<name>/nav.ts` (default export: AreaNavEntry[]) so a
// feature adds its menu item in its own folder instead of editing a shared
// list. Vite resolves the glob at build time; no match is fine.
import type { AreaNavEntry } from "./nav.ts";

const modules = import.meta.glob<AreaNavEntry[]>("../../features/*/nav.ts", {
  eager: true,
  import: "default",
});

export const registeredNav: readonly AreaNavEntry[] =
  Object.values(modules).flat();
