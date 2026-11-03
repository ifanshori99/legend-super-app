// Pure helpers of the CRM campaign screens (bead legend-hbad; PRD v1.7 §3.21
// "Kampanye", "Otomasi", LOY-04, AI-12). No React and no DOM at import time,
// and only bare package imports, so the helpers stay testable and the forms
// stay thin.
//
// The screens show exactly what the CRM contract stores: campaign status,
// channel, content, optional A/B variant, schedule and results. The consent
// rule is not re-implemented: `campaignSendDecision` in @starter/shared/crm is
// the single source of truth for who may receive a promotional campaign
// (LOY-04), and `transitionCampaign` is the only state machine for campaign
// actions.

import type { EndpointInput } from "@starter/shared/api";
import { DEFAULT_BUSINESS_DAY_CLOCK } from "@starter/shared/core";
import type { MessageKey, TranslateVars } from "@starter/shared/i18n";
import type {
  Campaign,
  CampaignAction,
  CampaignAutomation,
  CampaignChannel,
  CampaignContent,
  CampaignResults,
  CampaignSendStatus,
  CampaignStatus,
  CustomerConsent,
  CustomerProfile,
  createCampaign,
} from "@starter/shared/crm";
import { campaignSendDecision, transitionCampaign } from "@starter/shared/crm";

type CreateCampaignBody = EndpointInput<typeof createCampaign>["body"];

export const CAMPAIGN_CHANNELS: readonly CampaignChannel[] = [
  "web_push",
  "email",
  "whatsapp_template",
];

export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  "draft",
  "scheduled",
  "running",
  "completed",
  "cancelled",
];

export const CAMPAIGN_ACTIONS: readonly CampaignAction[] = [
  "schedule",
  "start",
  "complete",
  "cancel",
];

export const CAMPAIGN_SEND_STATUSES: readonly CampaignSendStatus[] = [
  "queued",
  "sent",
  "delivered",
  "failed",
  "skipped_no_consent",
];

/** Every catalog key starts at the module's namespace. */
const KEY = "crmCampaigns" as const;

export function channelLabelKey(channel: CampaignChannel): MessageKey {
  return `${KEY}.channels.${channel}`;
}

export function channelHintKey(channel: CampaignChannel): MessageKey {
  return `${KEY}.channelHints.${channel}`;
}

export function campaignStatusLabelKey(status: CampaignStatus): MessageKey {
  return `${KEY}.status.${status}`;
}

export function sendStatusLabelKey(status: CampaignSendStatus): MessageKey {
  return `${KEY}.sends.status.${status}`;
}

export function sendExplanationKey(status: CampaignSendStatus): MessageKey {
  return `${KEY}.sends.explanation.${status}`;
}

export function campaignActionLabelKey(action: CampaignAction): MessageKey {
  return `${KEY}.actions.${action}`;
}

export function automationNameKey(trigger: CampaignAutomation): MessageKey {
  return `${KEY}.automations.triggers.${trigger}`;
}

export function automationRuleKey(trigger: CampaignAutomation): MessageKey {
  return `${KEY}.automations.rules.${trigger}`;
}

/** True when the URL asks mock mode for a non-normal scenario (?mock=empty). */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}

/** WhatsApp is the only channel that needs a provider template name. */
export function needsTemplateRef(channel: CampaignChannel): boolean {
  return channel === "whatsapp_template";
}

const MAX_NAME = 150;
const MAX_BODY = 2_000;
const MAX_TEMPLATE = 100;

// ---- Date and time --------------------------------------------------------

const DATE_TIME_FORMATS = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormat(timeZone: string): Intl.DateTimeFormat {
  const cached = DATE_TIME_FORMATS.get(timeZone);
  if (cached) return cached;
  const format = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  DATE_TIME_FORMATS.set(timeZone, format);
  return format;
}

/** "5 Nov 2026, 09.00" on the outlet's wall clock. */
export function formatDateTime(
  iso: string,
  timeZone: string = DEFAULT_BUSINESS_DAY_CLOCK.timeZone,
): string {
  return dateTimeFormat(timeZone).format(new Date(iso));
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function wallClock(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour") % 24,
    minute: field("minute"),
  };
}

/**
 * `datetime-local` value for an instant on the outlet's wall clock. The
 * schedule form edits the outlet clock, never the device clock, which can sit
 * in another zone.
 */
export function toDateTimeLocalValue(
  iso: string,
  timeZone: string = DEFAULT_BUSINESS_DAY_CLOCK.timeZone,
): string {
  const wall = wallClock(new Date(iso), timeZone);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** Parses a `datetime-local` value on the outlet's wall clock to an ISO instant. */
export function fromDateTimeLocalValue(
  value: string,
  timeZone: string = DEFAULT_BUSINESS_DAY_CLOCK.timeZone,
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  if (Number.isNaN(asUtc)) return null;
  // Offset of the zone at that moment; a second pass settles a DST edge.
  const offsetAt = (instant: number) => {
    const wall = wallClock(new Date(instant), timeZone);
    return (
      Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) -
      instant
    );
  };
  let instant = asUtc - offsetAt(asUtc);
  instant = asUtc - offsetAt(instant);
  return Number.isNaN(instant) ? null : new Date(instant).toISOString();
}

// ---- A/B split ------------------------------------------------------------

/** 10.000 basis points = 100% (basisPointsSchema in @starter/shared/core). */
export const SPLIT_BP_BASE = 10_000;

/** "40" or "40,5" → 4000 / 4050 basis points; null when outside (0, 100%). */
export function parseSplitPercent(input: string): number | null {
  const normalized = input.trim().replace(",", ".");
  if (normalized === "") return null;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const bp = Math.round(value * 100);
  if (!Number.isSafeInteger(bp) || bp <= 0 || bp >= SPLIT_BP_BASE) return null;
  return bp;
}

/** 4_050 → "40,5%". */
export function formatSplitPercent(splitBp: number): string {
  const value = new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 2,
  }).format(splitBp / 100);
  return `${value}%`;
}

// ---- Campaign form --------------------------------------------------------

export type CampaignForm = {
  name: string;
  segmentId: string;
  channel: CampaignChannel;
  title: string;
  body: string;
  templateRef: string;
  /** `datetime-local` value in the outlet zone; empty means "no schedule". */
  scheduledAt: string;
  abEnabled: boolean;
  variantBTitle: string;
  variantBBody: string;
  variantBTemplateRef: string;
  /** Percent of the audience that receives variant B, as typed. */
  splitPercent: string;
};

export type CampaignField = keyof CampaignForm;

/** Field → catalog key of the message that says how to fix it. */
export type CampaignFieldErrors = Partial<Record<CampaignField, MessageKey>>;

export function emptyCampaignForm(
  channel: CampaignChannel = "web_push",
): CampaignForm {
  return {
    name: "",
    segmentId: "",
    channel,
    title: "",
    body: "",
    templateRef: "",
    scheduledAt: "",
    abEnabled: false,
    variantBTitle: "",
    variantBBody: "",
    variantBTemplateRef: "",
    splitPercent: "50",
  };
}

export function hasFieldErrors(errors: CampaignFieldErrors): boolean {
  return Object.values(errors).some(Boolean);
}

export function validateCampaignForm(
  form: CampaignForm,
  timeZone: string = DEFAULT_BUSINESS_DAY_CLOCK.timeZone,
): CampaignFieldErrors {
  const errors: CampaignFieldErrors = {};
  const name = form.name.trim();
  if (name === "") errors.name = `${KEY}.create.validation.name`;
  else if (name.length > MAX_NAME)
    errors.name = `${KEY}.create.validation.nameTooLong`;

  if (form.segmentId === "")
    errors.segmentId = `${KEY}.create.validation.segment`;

  const title = form.title.trim();
  if (title === "") errors.title = `${KEY}.create.validation.title`;
  else if (title.length > MAX_NAME)
    errors.title = `${KEY}.create.validation.titleTooLong`;

  const body = form.body.trim();
  if (body === "") errors.body = `${KEY}.create.validation.body`;
  else if (body.length > MAX_BODY)
    errors.body = `${KEY}.create.validation.bodyTooLong`;

  if (needsTemplateRef(form.channel)) {
    const templateRef = form.templateRef.trim();
    if (templateRef === "")
      errors.templateRef = `${KEY}.create.validation.templateRef`;
    else if (templateRef.length > MAX_TEMPLATE)
      errors.templateRef = `${KEY}.create.validation.templateRefTooLong`;
  }

  if (
    form.scheduledAt.trim() !== "" &&
    fromDateTimeLocalValue(form.scheduledAt, timeZone) === null
  )
    errors.scheduledAt = `${KEY}.create.validation.schedule`;

  if (form.abEnabled) {
    if (form.variantBTitle.trim() === "")
      errors.variantBTitle = `${KEY}.create.validation.variantBTitle`;
    if (form.variantBBody.trim() === "")
      errors.variantBBody = `${KEY}.create.validation.variantBBody`;
    else if (form.variantBBody.trim().length > MAX_BODY)
      errors.variantBBody = `${KEY}.create.validation.bodyTooLong`;
    if (
      needsTemplateRef(form.channel) &&
      form.variantBTemplateRef.trim() === ""
    )
      errors.variantBTemplateRef = `${KEY}.create.validation.variantBTemplateRef`;
    if (parseSplitPercent(form.splitPercent) === null)
      errors.splitPercent = `${KEY}.create.validation.split`;
  }

  return errors;
}

function contentFromForm(
  form: Pick<CampaignForm, "channel" | "title" | "body" | "templateRef">,
): CampaignContent {
  return {
    title: form.title.trim(),
    body: form.body.trim(),
    templateRef: needsTemplateRef(form.channel)
      ? form.templateRef.trim()
      : null,
  };
}

/** Validated form → the POST /api/campaigns body. Call after validation. */
export function campaignBody(
  form: CampaignForm,
  timeZone: string = DEFAULT_BUSINESS_DAY_CLOCK.timeZone,
): CreateCampaignBody {
  const abTest =
    form.abEnabled && parseSplitPercent(form.splitPercent) !== null
      ? {
          variantB: contentFromForm({
            channel: form.channel,
            title: form.variantBTitle,
            body: form.variantBBody,
            templateRef: form.variantBTemplateRef,
          }),
          splitBp: parseSplitPercent(form.splitPercent) as number,
        }
      : null;
  return {
    name: form.name.trim(),
    segmentId: form.segmentId,
    channel: form.channel,
    content: contentFromForm(form),
    abTest,
    scheduledAt:
      form.scheduledAt.trim() === ""
        ? null
        : fromDateTimeLocalValue(form.scheduledAt, timeZone),
  };
}

// ---- AI-12 local draft ----------------------------------------------------

/**
 * Sample provider template name used by the local draft. A real WhatsApp
 * campaign must reference an approved template; the draft hint asks the user
 * to replace it (AI-12).
 */
export const AI_WHATSAPP_TEMPLATE_REF = "legend_penawaran_segmen";

export type DraftTranslator = (key: MessageKey, vars?: TranslateVars) => string;

/**
 * AI-12: a deterministic draft from a local template per channel, using the
 * segment name. It never calls a model and never varies between runs, so the
 * screen can label it "Draf" with an edit hint instead of claiming live AI
 * output.
 */
export function aiDraftContent(input: {
  channel: CampaignChannel;
  segmentName: string;
  t: DraftTranslator;
}): CampaignContent {
  const vars = { segment: input.segmentName };
  const { channel, t } = input;
  if (channel === "email")
    return {
      title: t(`${KEY}.ai.emailTitle`, vars),
      body: t(`${KEY}.ai.emailBody`, vars),
      templateRef: null,
    };
  if (channel === "whatsapp_template")
    return {
      title: t(`${KEY}.ai.whatsappTitle`, vars),
      body: t(`${KEY}.ai.whatsappBody`, vars),
      templateRef: AI_WHATSAPP_TEMPLATE_REF,
    };
  return {
    title: t(`${KEY}.ai.web_pushTitle`, vars),
    body: t(`${KEY}.ai.web_pushBody`, vars),
    templateRef: null,
  };
}

// ---- Actions --------------------------------------------------------------

/** True when `transitionCampaign` accepts the action for this status. */
export function canTransitionCampaign(
  status: CampaignStatus,
  action: CampaignAction,
): boolean {
  try {
    transitionCampaign(status, action);
    return true;
  } catch {
    return false;
  }
}

/** The actions the detail screen may offer, in a stable order. */
export function campaignActions(status: CampaignStatus): CampaignAction[] {
  return CAMPAIGN_ACTIONS.filter((action) =>
    canTransitionCampaign(status, action),
  );
}

// ---- Results and consent (LOY-04) -----------------------------------------

const ZERO_SEND_COUNTS: Record<CampaignSendStatus, number> = {
  queued: 0,
  sent: 0,
  delivered: 0,
  failed: 0,
  skipped_no_consent: 0,
};

/**
 * Per-status send counts from the results summary. The contract records
 * `sent` as everything handed to the provider, including delivered and failed
 * sends, so "in queue" is what is left after sent and skipped (LOY-04).
 */
export function sendStatusCounts(
  results: CampaignResults | undefined,
): Record<CampaignSendStatus, number> {
  if (!results) return ZERO_SEND_COUNTS;
  return {
    queued: Math.max(
      0,
      results.recipients - results.sent - results.skippedNoConsent,
    ),
    sent: Math.max(0, results.sent - results.delivered - results.failed),
    delivered: results.delivered,
    failed: results.failed,
    skipped_no_consent: results.skippedNoConsent,
  };
}

/** A campaign has results once at least one recipient was counted. */
export function hasResults(results: CampaignResults | undefined): boolean {
  return results !== undefined && results.recipients > 0;
}

export function totalSkippedNoConsent(
  results: readonly (CampaignResults | undefined)[],
): number {
  return results.reduce(
    (total, item) => total + (item?.skippedNoConsent ?? 0),
    0,
  );
}

export type ConsentSkipReason = "membership_inactive" | "no_marketing_consent";

/** Catalog explanation of why `campaignSendDecision` skipped a recipient. */
export function consentSkipReasonKey(reason: ConsentSkipReason): MessageKey {
  return reason === "membership_inactive"
    ? `${KEY}.consent.reasonInactive`
    : `${KEY}.consent.reasonNoConsent`;
}

/**
 * LOY-04 over the fixture customer list: how many of `profiles` the server
 * would skip at `at`. `campaignSendDecision` is the contract's rule, so the
 * mock derives its consent-aware results with the same function the API uses.
 */
export function countConsentSkips(
  profiles: readonly CustomerProfile[],
  consents: readonly CustomerConsent[],
  at: string,
): number {
  return profiles.filter((profile) => {
    const own = consents.filter(
      (consent) => consent.customerProfileId === profile.id,
    );
    return !campaignSendDecision(profile, own, at).eligible;
  }).length;
}

/** Sort: running first, then scheduled, draft, completed, cancelled; newest first. */
export function sortCampaigns(campaigns: readonly Campaign[]): Campaign[] {
  const rank: Record<CampaignStatus, number> = {
    running: 0,
    scheduled: 1,
    draft: 2,
    completed: 3,
    cancelled: 4,
  };
  return [...campaigns].sort(
    (left, right) =>
      rank[left.status] - rank[right.status] ||
      Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
}
