// Tenant and outlet context for the app shells (bead legend-ri1p).
//
// One typed, SSR-safe source for what a shell may show: the tenant brand, the
// outlet this screen works in (name, IANA time zone and the owner Q39
// business_day_cutoff) and the device/station the screen runs on. The value
// comes from a config source; today that is the mock module
// (lib/mock/tenant-context.ts) until the API serves outlet scope. With no
// config the provider fails closed: the catalog brand and no outlet, so the
// operations shell keeps its neutral "Outlet belum dipilih" copy.
//
// Business dates (contracts.md D-CORE-7) must use the outlet clock, never the
// device clock. A sibling bead (legend-1mi5) consumes:
//
//   const { clock } = useOutletClock();       // { timeZone, cutoff }
//   const today = businessDateOf(new Date(), clock);
//
// No `window` at module scope: the same value renders on the server and after
// hydration.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  DEFAULT_BUSINESS_DAY_CLOCK,
  type BusinessDayClock,
  type BusinessDayCutoff,
  type OutletId,
} from "@starter/shared/core";
import type { StationId } from "@starter/shared/access";
import { createTranslator } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";

/** An outlet as the shells show it: its name plus the business-date settings. */
export type TenantOutlet = {
  id: OutletId;
  name: string;
  /** IANA zone (outlets.timezone), e.g. "Asia/Jakarta". */
  timeZone: string;
  /** Owner Q39 business-day start, "HH:mm" in the outlet time zone. */
  businessDayCutoff: BusinessDayCutoff;
};

/** The terminal this screen runs on, when the device pairing is known. */
export type TenantDevice = { id?: string; label?: string };

/** The station this screen works (POS/KDS), when a station is selected. */
export type TenantStation = { id: StationId; name: string };

/**
 * What a config source supplies. Every field is optional: an older producer
 * may omit the cutoff (`outletRefSchema` defaults it to 04:00), and a screen
 * with no outlet (platform admin) simply has none.
 */
export type TenantContextConfig = {
  brandName?: string | null;
  outlet?: {
    id: OutletId;
    name: string;
    timeZone: string;
    businessDayCutoff?: BusinessDayCutoff;
  } | null;
  device?: TenantDevice | null;
  station?: TenantStation | null;
};

/** The resolved value consumers read; the brand always has a value. */
export type TenantContextValue = {
  brandName: string;
  outlet: TenantOutlet | null;
  device: TenantDevice | null;
  station: TenantStation | null;
};

/**
 * Live overrides for one subtree (a settings screen previewing a new cutoff):
 * they merge into the same value, so there is no second source of truth. An
 * outlet cannot be invented here — its id and name still come from config.
 */
export type TenantContextOverrides = {
  brandName?: string;
  outlet?: {
    timeZone?: string;
    businessDayCutoff?: BusinessDayCutoff;
  };
  device?: TenantDevice | null;
  station?: TenantStation | null;
};

const staticT = createTranslator();

/** Fail-closed value: catalog brand, no outlet, no device or station. */
export const EMPTY_TENANT_CONTEXT: TenantContextValue = Object.freeze({
  brandName: staticT("app.defaultBrand"),
  outlet: null,
  device: null,
  station: null,
});

const TenantContext = createContext<TenantContextValue>(EMPTY_TENANT_CONTEXT);

function resolveTenantContext(
  config: TenantContextConfig | null | undefined,
  overrides: TenantContextOverrides | undefined,
  fallbackBrandName: string,
): TenantContextValue {
  const configured = config?.outlet ?? null;
  const patch = overrides?.outlet;
  return {
    brandName: overrides?.brandName ?? config?.brandName ?? fallbackBrandName,
    outlet:
      configured === null
        ? null
        : {
            id: configured.id,
            name: configured.name,
            timeZone: patch?.timeZone ?? configured.timeZone,
            businessDayCutoff:
              patch?.businessDayCutoff ??
              configured.businessDayCutoff ??
              DEFAULT_BUSINESS_DAY_CLOCK.cutoff,
          },
    device:
      overrides?.device !== undefined
        ? overrides.device
        : (config?.device ?? null),
    station:
      overrides?.station !== undefined
        ? overrides.station
        : (config?.station ?? null),
  };
}

/**
 * Mounts the tenant/outlet context. `config` is the resolved source (null in
 * SSR/no-config renders → fail-closed default); `overrides` patches it for one
 * subtree without creating a second source of truth.
 */
export function TenantProvider({
  config = null,
  overrides,
  children,
}: {
  config?: TenantContextConfig | null;
  overrides?: TenantContextOverrides;
  children: ReactNode;
}) {
  const t = useT();
  const value = useMemo(
    () => resolveTenantContext(config, overrides, t("app.defaultBrand")),
    [config, overrides, t],
  );
  return (
    <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
  );
}

/** The tenant/outlet context every shell reads. */
export function useTenantContext(): TenantContextValue {
  return useContext(TenantContext);
}

/** The outlet settings a business date needs (contracts.md D-CORE-7). */
export type OutletClock = {
  /** Outlet IANA zone, or the documented default when no outlet is set. */
  timeZone: string;
  /** Owner Q39 cutoff "HH:mm", or the documented default "04:00". */
  businessDayCutoff: BusinessDayCutoff;
  /** Ready for businessDateOf / businessDayRange: `{ timeZone, cutoff }`. */
  clock: BusinessDayClock;
  /** False when no outlet is configured (the values are the defaults). */
  fromOutlet: boolean;
};

/**
 * Inputs for business-date maths: the outlet's IANA zone and its
 * business-day cutoff. Never compute "today" from the device clock.
 *
 *   const { clock } = useOutletClock();
 *   const today = businessDateOf(new Date(), clock);
 *
 * With no outlet configured it returns DEFAULT_BUSINESS_DAY_CLOCK (Jakarta,
 * 04:00), the shared contract's fallback, and `fromOutlet` false so a caller
 * that must not guess can fail closed instead.
 */
export function useOutletClock(): OutletClock {
  const { outlet } = useTenantContext();
  return useMemo(() => {
    const timeZone = outlet?.timeZone ?? DEFAULT_BUSINESS_DAY_CLOCK.timeZone;
    const businessDayCutoff =
      outlet?.businessDayCutoff ?? DEFAULT_BUSINESS_DAY_CLOCK.cutoff;
    return {
      timeZone,
      businessDayCutoff,
      clock: { timeZone, cutoff: businessDayCutoff },
      fromOutlet: outlet !== null,
    };
  }, [outlet]);
}
