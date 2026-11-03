// Local fixture for the automation tab (PRD §3.21 "Otomasi": welcome,
// birthday, win-back, points-expiry reminder).
//
// MOCK ONLY, AND DELIBERATELY SO. The CRM contract (bead legend-zk25) ships
// `campaignAutomationSchema` but no automation endpoint, so there is nothing
// to fetch and no endpoint path may be invented. The tab reads this local
// fixture, labels itself as a local preview, and keeps its toggles in this
// browser only — nothing is sent to the API. The follow-up bead
// "WS-08 BE: campaign automation triggers + contract endpoints" replaces this
// module with a real read/write endpoint.
import * as React from "react";
import { campaignAutomationSchema } from "@starter/shared/crm";
import type { CampaignAutomation, CampaignChannel } from "@starter/shared/crm";

export type AutomationSetting = {
  readonly trigger: CampaignAutomation;
  readonly channel: CampaignChannel;
  readonly enabled: boolean;
  /** Estimated customers the trigger would reach on its next run. */
  readonly audienceEstimate: number;
  /** Last time the trigger ran; null before the first run. */
  readonly lastRunAt: string | null;
};

/**
 * Four triggers, one per `campaignAutomationSchema` value. The record is
 * keyed by the contract enum, so a new trigger fails to compile until it has a
 * card. The audience estimates mirror the CRM segment fixtures where a segment
 * exists (birthday 87, win-back 128) and are sample figures elsewhere; the tab
 * says "Contoh data" in mock mode and never presents them as live counts.
 */
const AUTOMATION_CARDS: Record<
  CampaignAutomation,
  Omit<AutomationSetting, "trigger">
> = {
  welcome: {
    channel: "whatsapp_template",
    enabled: true,
    audienceEstimate: 24,
    lastRunAt: "2026-10-31T03:05:00.000Z",
  },
  birthday: {
    channel: "email",
    enabled: true,
    audienceEstimate: 87,
    lastRunAt: "2026-11-01T01:00:00.000Z",
  },
  win_back: {
    channel: "email",
    enabled: true,
    audienceEstimate: 128,
    lastRunAt: "2026-10-28T02:00:00.000Z",
  },
  points_expiry_reminder: {
    channel: "web_push",
    enabled: false,
    audienceEstimate: 46,
    lastRunAt: null,
  },
};

export const automationFixtures: readonly AutomationSetting[] =
  campaignAutomationSchema.options.map((trigger) => ({
    trigger,
    ...AUTOMATION_CARDS[trigger],
  }));

const STORAGE_KEY = "legend-campaign-automations";

type AutomationOverrides = Partial<Record<CampaignAutomation, boolean>>;

/** Stored overrides; an unreadable store simply means "fixtures". */
export function readAutomationOverrides(): AutomationOverrides {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as AutomationOverrides;
  } catch {
    return {};
  }
}

/** SSR/hydration snapshot: the fixtures, before this browser's overrides. */
const SERVER_OVERRIDES: AutomationOverrides = Object.freeze({});
/**
 * `useSyncExternalStore` compares snapshots by identity, so the parsed store is
 * cached and replaced only when this module writes it.
 */
let cachedOverrides: AutomationOverrides | null = null;
const listeners = new Set<() => void>();

function currentOverrides(): AutomationOverrides {
  cachedOverrides ??= readAutomationOverrides();
  return cachedOverrides;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function writeAutomationOverrides(overrides: AutomationOverrides) {
  cachedOverrides = overrides;
  for (const listener of listeners) listener();
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Private mode or a full quota: the tab keeps the in-memory value.
  }
}

/**
 * Fixtures plus this browser's toggles, read through an external store so the
 * server render (fixtures) and hydration agree and no setState-in-effect runs.
 * The localStorage preview never requests anything from the API.
 */
export function useAutomationSettings() {
  const overrides = React.useSyncExternalStore(
    subscribe,
    currentOverrides,
    () => SERVER_OVERRIDES,
  );

  const settings = automationFixtures.map((setting) => ({
    ...setting,
    enabled: overrides[setting.trigger] ?? setting.enabled,
  }));

  const toggle = (trigger: CampaignAutomation, enabled: boolean) => {
    writeAutomationOverrides({ ...currentOverrides(), [trigger]: enabled });
  };

  return { settings, toggle };
}
