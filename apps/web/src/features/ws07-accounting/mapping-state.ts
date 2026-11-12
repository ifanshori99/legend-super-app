// Pure logic of the account-role mapping screen (bead legend-fzvh, S6 of
// sub-539-u5a): draft handling, the per-role check against the chart, the
// Indonesian wording for the contract's English issue strings and the API
// error mapping. No React and no `@/` aliases, so tests/legend-fzvh-account-
// mappings-ui.test.mjs loads it with native Node type stripping.
//
// The checks mirror `accountMappingIssues` in @starter/shared/accounting (the
// API enforces them) plus "inactive", which the contract does not check but
// the picker must not offer. The error mapping is duck-typed on `status` and
// `code` (an `ApiError` has both), so tests can pass plain objects.
import {
  POSTING_ACCOUNT_ROLES,
  allowedAccountTypesForRole,
  headerAccountIds,
  type Account,
  type AccountMapping,
  type AccountType,
  type PostingAccountRole,
} from "@starter/shared/accounting";

export type MappingDraft = Partial<Record<PostingAccountRole, string>>;

export type MappingIssue =
  | "header"
  | "inactive"
  | "wrongType"
  | "notFound"
  | "duplicate";

/** Every posting role, in the contract's order (assets first, then liabilities…). */
export const MAPPING_ROLES = Object.keys(
  POSTING_ACCOUNT_ROLES,
) as PostingAccountRole[];

export function isPostingRole(value: string): value is PostingAccountRole {
  return Object.hasOwn(POSTING_ACCOUNT_ROLES, value);
}

/** Message key of a role's label, e.g. `accounting.mapping.roles.cash_on_hand`. */
export function roleLabelKey(role: PostingAccountRole): string {
  return `accounting.mapping.roles.${role}`;
}

/** Message key of the "Jenis akun" cell: the fixed type, a list, or any type. */
export function roleTypeLabelKey(role: PostingAccountRole): string {
  const allowed = allowedAccountTypesForRole(role);
  if (allowed === null) return "accounting.mapping.types.any";
  if (allowed.length === 1) return `accounting.mapping.types.${allowed[0]}`;
  const set = [...allowed].sort().join("+");
  if (set === "liability+revenue")
    return "accounting.mapping.types.liabilityOrRevenue";
  if (set === "expense+liability")
    return "accounting.mapping.types.expenseOrLiability";
  return "accounting.mapping.types.any";
}

/** Saved mappings → draft (role → account id). Unknown roles are dropped. */
export function draftFromMappings(
  mappings: readonly Pick<AccountMapping, "role" | "accountId">[],
): MappingDraft {
  const draft: MappingDraft = {};
  for (const mapping of mappings)
    if (isPostingRole(mapping.role)) draft[mapping.role] = mapping.accountId;
  return draft;
}

function chosen(draft: MappingDraft, role: PostingAccountRole): string {
  return draft[role] ?? "";
}

/** How many roles have an account; `missing` drives the tag and the warning. */
export function mappingCounts(draft: MappingDraft) {
  const total = MAPPING_ROLES.length;
  const mapped = MAPPING_ROLES.filter((role) => chosen(draft, role) !== "")
    .length;
  return { mapped, total, missing: total - mapped };
}

/** True when the draft differs from the saved mapping (enables save/cancel). */
export function isDraftDirty(saved: MappingDraft, draft: MappingDraft): boolean {
  return MAPPING_ROLES.some((role) => chosen(saved, role) !== chosen(draft, role));
}

/**
 * What to send when the saved mapping changed under an open draft: the latest
 * server state plus only the roles the user changed from `baseline` (the
 * mapping the draft started from). Untouched roles follow the server, so a
 * stale draft cannot overwrite another admin's change.
 */
export function mergeDraftOnto(
  baseline: MappingDraft,
  draft: MappingDraft,
  latest: MappingDraft,
): MappingDraft {
  const merged: MappingDraft = {};
  for (const role of MAPPING_ROLES) {
    const value =
      chosen(draft, role) !== chosen(baseline, role)
        ? chosen(draft, role)
        : chosen(latest, role);
    if (value !== "" || chosen(draft, role) !== chosen(baseline, role))
      merged[role] = value;
  }
  return merged;
}

/** The PUT body: only roles with an account; a cleared role is left out. */
export function buildReplaceBody(draft: MappingDraft) {
  return {
    mappings: MAPPING_ROLES.flatMap((role) => {
      const accountId = chosen(draft, role);
      return accountId === "" ? [] : [{ role, accountId }];
    }),
  };
}

/** Accounts a role may use: active, a leaf, of an allowed type, by code. */
export function eligibleAccounts(
  role: PostingAccountRole,
  accounts: readonly Account[],
): Account[] {
  const allowed = allowedAccountTypesForRole(role);
  const headers = headerAccountIds(accounts);
  return accounts
    .filter(
      (account) =>
        account.isActive &&
        !headers.has(account.id) &&
        (allowed === null || allowed.includes(account.type)),
    )
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
}

/** What is wrong with the account chosen for one role (null = fine or empty). */
export function roleIssue(
  role: PostingAccountRole,
  accountId: string,
  accounts: readonly Account[],
  legalEntityId: string,
): MappingIssue | null {
  if (accountId === "") return null;
  const account = accounts.find((row) => row.id === accountId);
  if (!account || account.legalEntityId !== legalEntityId) return "notFound";
  const allowed = allowedAccountTypesForRole(role);
  if (allowed !== null && !allowed.includes(account.type as AccountType))
    return "wrongType";
  if (headerAccountIds(accounts).has(account.id)) return "header";
  if (!account.isActive) return "inactive";
  return null;
}

/** Issues of the whole draft, keyed by role (empty = safe to save). */
export function draftIssues(
  draft: MappingDraft,
  accounts: readonly Account[],
  legalEntityId: string,
): Partial<Record<PostingAccountRole, MappingIssue>> {
  const issues: Partial<Record<PostingAccountRole, MappingIssue>> = {};
  for (const role of MAPPING_ROLES) {
    const issue = roleIssue(role, chosen(draft, role), accounts, legalEntityId);
    if (issue) issues[role] = issue;
  }
  return issues;
}

/**
 * Wording for the contract's English `accountMappingIssues` strings, so a
 * message from the API or a shared check lands on the right row. Unknown text
 * returns null (the banner still shows).
 */
export function parseContractIssue(
  text: string,
): { role: PostingAccountRole; issue: MappingIssue } | null {
  const twice = /^Role (\w+) mapped twice$/.exec(text);
  const other = /^Role (\w+): (.+)$/.exec(text);
  const match = twice ?? other;
  const role = match?.[1];
  if (!role || !isPostingRole(role)) return null;
  if (twice) return { role, issue: "duplicate" };
  const detail = other?.[2] ?? "";
  if (detail.startsWith("account not in this legal entity"))
    return { role, issue: "notFound" };
  if (detail.startsWith("needs a ")) return { role, issue: "wrongType" };
  if (detail.startsWith("header account")) return { role, issue: "header" };
  return null;
}

/**
 * A 422 message holds the contract's issues joined by ";": one issue per row.
 * Parts that name no known role are skipped (the banner still shows).
 */
export function parseContractIssues(
  message: string | undefined,
): Partial<Record<PostingAccountRole, MappingIssue>> {
  const issues: Partial<Record<PostingAccountRole, MappingIssue>> = {};
  for (const part of (message ?? "").split(";")) {
    const parsed = parseContractIssue(part.trim());
    if (parsed) issues[parsed.role] = parsed.issue;
  }
  return issues;
}

export type MappingSaveError =
  | "invalid"
  | "forbidden"
  | "network"
  | "unknown";

/** API failure of the save → which banner to show. */
export function mappingSaveError(error: unknown): MappingSaveError {
  const e = (error ?? {}) as { status?: unknown; code?: unknown };
  if (e.status === 403) return "forbidden";
  if (e.status === 400 || e.status === 409 || e.status === 422)
    return "invalid";
  if (e.status === 0 || e.code === "NETWORK_ERROR") return "network";
  return "unknown";
}

/** Message keys for the banner of each save error. */
export const SAVE_ERROR_KEYS: Record<
  MappingSaveError,
  { title: string; hint: string }
> = {
  invalid: {
    title: "accounting.mapping.invalidTitle",
    hint: "accounting.mapping.invalidHint",
  },
  forbidden: {
    title: "accounting.mapping.forbiddenTitle",
    hint: "accounting.mapping.forbiddenHint",
  },
  network: {
    title: "accounting.mapping.failedTitle",
    hint: "accounting.mapping.failedHint",
  },
  unknown: {
    title: "accounting.mapping.failedTitle",
    hint: "accounting.mapping.failedHint",
  },
};

export type MappingScreenState = "loading" | "error" | "ready";

/** Entity list and the two reads → one state (empty entity list is handled by the page). */
export function mappingScreenState(input: {
  mappingsPending: boolean;
  accountsPending: boolean;
  mappingsError: boolean;
  accountsError: boolean;
}): MappingScreenState {
  if (input.mappingsError || input.accountsError) return "error";
  if (input.mappingsPending || input.accountsPending) return "loading";
  return "ready";
}
