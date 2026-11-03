// Catalog access for the outlet settings screen (bead legend-1mi5).
//
// The copy lives in the shared catalog under `orgOutlet.*` but this bead may
// not edit packages/shared (the coordinator adds the keys), and `MessageKey`
// is a typed union. Keys are therefore built at runtime and used only when the
// catalog really has them (`isMessageKey`); until then the closest existing
// key keeps the screen readable instead of showing a raw key. The exact key +
// Indonesian copy is in the bead report.
import { useMemo } from "react";
import {
  isMessageKey,
  type MessageKey,
  type TranslateVars,
} from "@starter/shared/i18n";
import { useT } from "@/components/i18n";

/** Temporary stand-ins while `orgOutlet.*` is not in the catalog yet. */
const FALLBACKS: Readonly<Record<string, MessageKey>> = {
  "orgOutlet.title": "auditSettings.hub.groups.outlet",
  "orgOutlet.subtitle": "auditSettings.hub.groups.outletHint",
  "orgOutlet.listTitle": "auditSettings.hub.groups.outlet",
  "orgOutlet.fields.name": "inventory.units.columns.name",
  "orgOutlet.fields.address": "website.home.addressTitle",
  "orgOutlet.fields.timeZone": "notification.preferences.timeZone",
  // "Jam mulai" + the hint below ("hari dimulai pukul 04.00, …") reads as the
  // hour the business day starts until "Jam tutup buku" is in the catalog.
  "orgOutlet.fields.cutoff": "promo.editor.timeStart",
  "orgOutlet.saved": "opname.detail.line.saved",
  "orgOutlet.timeZoneHint": "notification.preferences.timeZone",
  "orgOutlet.cutoffHint": "promo.editor.startsOnHint",
  "orgOutlet.previewTitle": "opname.create.businessDate",
  "orgOutlet.previewHint": "opname.create.businessDateHint",
  "orgOutlet.saveFailed": "state.errorHint",
  "orgOutlet.offline": "promo.offline.saveBlocked",
};

export type OrgOutletT = (key: string, vars?: TranslateVars) => string;

export function useOrgOutletT(): OrgOutletT {
  const t = useT();
  return useMemo(
    () => (key, vars) => {
      if (isMessageKey(key)) return t(key, vars);
      const fallback = FALLBACKS[key];
      return fallback ? t(fallback, vars) : key;
    },
    [t],
  );
}
