// Theme runtime: light/dark/system preference (persisted), and the Tenant
// Theme CSS layer. See DESIGN.md "Theming" for how the layers stack.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ScriptOnce } from "@tanstack/react-router";
import {
  THEME_STORAGE_KEY,
  buildTenantThemeCss,
  formatFailure,
  type TenantThemeConfig,
  type ThemePreference,
} from "@starter/shared/theme";

const PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];
const CHANGE_EVENT = "legend-theme-change";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return PREFERENCES.includes(value as ThemePreference)
      ? (value as ThemePreference)
      : "system";
  } catch {
    // Storage can be blocked (private mode, kiosk policies): follow the OS.
    return "system";
  }
}

function applyTheme(preference: ThemePreference) {
  const dark =
    preference === "dark" ||
    (preference === "system" && matchMedia(DARK_QUERY).matches);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", !dark);
}

// Runs before first paint (SSR'd into <body>), so dark-mode visitors never
// see a white flash. Kept dependency-free: it is serialized as a string.
const bootScript = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});}catch(e){}if(p!=="light"&&p!=="dark")p="system";var d=p==="dark"||(p==="system"&&matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);var r=document.documentElement;r.classList.toggle("dark",d);r.classList.toggle("light",!d);})()`;

export function ThemeBootScript() {
  return <ScriptOnce>{bootScript}</ScriptOnce>;
}

function subscribe(onChange: () => void) {
  const media = matchMedia(DARK_QUERY);
  const sync = () => {
    applyTheme(readPreference());
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, sync);
  window.addEventListener("storage", sync); // other tabs
  media.addEventListener("change", sync); // OS switch while on "system"
  return () => {
    window.removeEventListener(CHANGE_EVENT, sync);
    window.removeEventListener("storage", sync);
    media.removeEventListener("change", sync);
  };
}

export function useTheme() {
  // The server cannot know the stored choice, so it renders "system" and the
  // client corrects it right after hydration without a mismatch.
  const preference = useSyncExternalStore(
    subscribe,
    readPreference,
    () => "system" as const,
  );
  const setPreference = useCallback((next: ThemePreference) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Not persisted, but still applied for this page view.
    }
    applyTheme(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return { preference, setPreference, preferences: PREFERENCES };
}

/**
 * Renders a Tenant Theme's CSS layer, scoped to `[data-tenant="<id>"]`.
 * A theme that fails WCAG 2.2 AA renders nothing, so the Base Theme stays
 * active (PRD: tema yang gagal tidak dapat diaktifkan).
 */
export function TenantThemeStyle({ tenant }: { tenant: TenantThemeConfig }) {
  const result = useMemo(() => buildTenantThemeCss(tenant), [tenant]);
  if (!result.ok) {
    if (import.meta.env.DEV)
      console.warn(
        `[theme] Tenant theme "${tenant.id}" refused: ${result.reason}`,
        result.check.invalid,
        result.check.failures.map(formatFailure),
      );
    return null;
  }
  // Safe to inline: ids and colors are validated by buildTenantThemeCss and
  // font stacks come from a fixed list, so no tenant text reaches the CSS.
  return (
    <style
      data-tenant-theme={tenant.id}
      dangerouslySetInnerHTML={{ __html: result.css }}
    />
  );
}
