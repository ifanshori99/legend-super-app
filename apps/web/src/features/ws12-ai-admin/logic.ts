// Pure rules of the AI & MCP admin page (WS-12, bead legend-hi82). No React, no
// router and no `@/` alias, so tests load this file with plain Node ESM. The
// API decides everything that matters; these helpers only shape what the admin
// sees (token counts for the revoke dialog, budget percent, form checks).

export type McpTokenState = "active" | "expired" | "revoked";

/** revokedAt wins; otherwise a token past its expiry is expired (MCP-02). */
export function mcpTokenState(
  t: { expiresAt: string; revokedAt: string | null },
  now: Date,
): McpTokenState {
  if (t.revokedAt !== null) return "revoked";
  return Date.parse(t.expiresAt) <= now.getTime() ? "expired" : "active";
}

type TokenLike = {
  clientId: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
};

/**
 * What revoking one client ends (founder decision Q11): every active token of
 * that client, so every session of the app disconnects. `users` counts the
 * distinct people who will have to approve access again.
 */
export function clientRevokeImpact(
  tokens: readonly TokenLike[],
  clientId: string,
  now: Date,
): { activeTokens: number; users: number } {
  const active = tokens.filter(
    (token) =>
      token.clientId === clientId && mcpTokenState(token, now) === "active",
  );
  return {
    activeTokens: active.length,
    users: new Set(active.map((token) => token.userId)).size,
  };
}

/** Whole percent of the monthly cap used; not clamped above 100. */
export function budgetPercent(
  spentIdr: number,
  capIdr: number | null,
): number | null {
  if (capIdr === null || capIdr <= 0) return null;
  return Math.max(0, Math.floor((spentIdr * 100) / capIdr));
}

/** Latest `lastUsedAt` among the active tokens of one client, or null. */
export function clientLastUsedAt(
  tokens: readonly (TokenLike & { lastUsedAt: string | null })[],
  clientId: string,
  now: Date,
): string | null {
  let latest: string | null = null;
  for (const token of tokens) {
    if (token.clientId !== clientId || token.lastUsedAt === null) continue;
    if (mcpTokenState(token, now) !== "active") continue;
    if (latest === null || Date.parse(token.lastUsedAt) > Date.parse(latest))
      latest = token.lastUsedAt;
  }
  return latest;
}

/** The bar fills to 100 at most; the number beside it is not clamped. */
export function meterWidth(percent: number | null): number {
  if (percent === null) return 0;
  return Math.min(100, Math.max(0, percent));
}

export type ScopeSummaryItem = { domain: string; draft: boolean };

/**
 * "mcp:sales:read" -> { domain: "sales", draft: false }. Repeats are dropped;
 * a value that is not a scope is skipped. The page turns the domain into a
 * catalog label.
 */
export function scopeSummary(scopes: readonly string[]): ScopeSummaryItem[] {
  const seen = new Set<string>();
  const out: ScopeSummaryItem[] = [];
  for (const scope of scopes) {
    const parts = scope.split(":");
    if (parts.length !== 3 || parts[0] !== "mcp") continue;
    const domain = parts[1] ?? "";
    const draft = parts[2] === "draft";
    if (domain === "" || (!draft && parts[2] !== "read")) continue;
    const key = `${domain}:${draft ? "draft" : "read"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ domain, draft });
  }
  return out;
}

/**
 * The full kill-switch list after one toggle: `PATCH disabledToolCodes`
 * replaces the whole list, so it is rebuilt from what the admin sees.
 */
export function disabledCodesAfterToggle(
  tools: readonly { code: string; isEnabled: boolean }[],
  code: string,
  enabled: boolean,
): string[] {
  const disabled = new Set(
    tools.filter((tool) => !tool.isEnabled).map((tool) => tool.code),
  );
  if (enabled) disabled.delete(code);
  else disabled.add(code);
  return [...disabled];
}

const EMPLOYEE_TYPE_ROLES: ReadonlySet<string> = new Set([
  "employee",
  "cashier",
  "waiter",
  "barista_cook",
  "facility_attendant",
]);

export type LimitRange = { min: number; max: number };

/**
 * Daily request limit per user for the two groups the admin sees. Roles
 * without an entry use the default; when enabled features set different
 * numbers the range is returned (the page prints "20–30").
 */
export function dailyLimitSummary(
  features: readonly {
    isEnabled: boolean;
    dailyLimitByRole: Partial<Record<string, number>>;
  }[],
  defaults: { employee: number; management: number },
): { employee: LimitRange; management: LimitRange } {
  const employee = [defaults.employee];
  const management = [defaults.management];
  for (const feature of features) {
    if (!feature.isEnabled) continue;
    for (const [role, limit] of Object.entries(feature.dailyLimitByRole)) {
      if (limit === undefined) continue;
      (EMPLOYEE_TYPE_ROLES.has(role) ? employee : management).push(limit);
    }
  }
  const range = (values: number[]): LimitRange => ({
    min: Math.min(...values),
    max: Math.max(...values),
  });
  return { employee: range(employee), management: range(management) };
}

// ---- Caps form -------------------------------------------------------------

export type CapsDraft = {
  monthlyBudgetIdr: string;
  warnPct: string;
  stopPct: string;
  rateLimit: string;
  maxRows: string;
};
export type CapsField = keyof CapsDraft;
export type CapsErrorKind = "budget" | "percent" | "order" | "rate" | "rows";
export type CapsValue = {
  monthlyBudgetIdr: number;
  budgetWarnPct: number;
  budgetStopPct: number;
  mcpRateLimitPerMinute: number;
  maxRowsPerResponse: number;
};

const WHOLE_NUMBER = /^\d{1,15}$/;

function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!WHOLE_NUMBER.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Same rules as the contract: budget 0 or more, percent 1..100, warn below
 * stop, rate limit and row cap within their maximum. The API checks again.
 */
export function validateCaps(
  draft: CapsDraft,
  limits: { maxRateLimit: number; maxRows: number },
):
  | { ok: true; value: CapsValue }
  | { ok: false; errors: Partial<Record<CapsField, CapsErrorKind>> } {
  const errors: Partial<Record<CapsField, CapsErrorKind>> = {};
  const budget = wholeNumber(draft.monthlyBudgetIdr);
  const warn = wholeNumber(draft.warnPct);
  const stop = wholeNumber(draft.stopPct);
  const rate = wholeNumber(draft.rateLimit);
  const rows = wholeNumber(draft.maxRows);
  if (budget === null) errors.monthlyBudgetIdr = "budget";
  if (warn === null || warn < 1 || warn > 100) errors.warnPct = "percent";
  if (stop === null || stop < 1 || stop > 100) errors.stopPct = "percent";
  if (
    errors.warnPct === undefined &&
    errors.stopPct === undefined &&
    warn !== null &&
    stop !== null &&
    warn >= stop
  )
    errors.warnPct = "order";
  if (rate === null || rate < 1 || rate > limits.maxRateLimit)
    errors.rateLimit = "rate";
  if (rows === null || rows < 1 || rows > limits.maxRows)
    errors.maxRows = "rows";
  if (
    Object.keys(errors).length > 0 ||
    budget === null ||
    warn === null ||
    stop === null ||
    rate === null ||
    rows === null
  )
    return { ok: false, errors };
  return {
    ok: true,
    value: {
      monthlyBudgetIdr: budget,
      budgetWarnPct: warn,
      budgetStopPct: stop,
      mcpRateLimitPerMinute: rate,
      maxRowsPerResponse: rows,
    },
  };
}

/** Revoke reason: trimmed, 3 to 500 characters (revokeMcpClientSchema). */
export function isValidRevokeReason(reason: string): boolean {
  const length = reason.trim().length;
  return length >= 3 && length <= 500;
}
