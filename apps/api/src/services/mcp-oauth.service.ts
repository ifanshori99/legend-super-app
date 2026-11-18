// OAuth 2.1 for MCP clients (WS-12 part M, bead legend-xkbt; MCP-01, MCP-02,
// MCP-05): authorization code + PKCE S256 only, approved clients only, exact
// redirect_uri match, single-use codes (10 minutes), tokens hashed at rest.
//
// Codes and tokens are looked up before any tenant context exists through the
// SECURITY DEFINER functions in ai.custom.sql; the full row is then re-read
// under tenant RLS.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  MCP_SCOPES,
  MCP_SCOPE_LABELS_ID,
  mcpRedirectUriSchema,
  type McpScope,
} from "@starter/shared/ai";
import { tenantIdSchema, userIdSchema } from "@starter/shared/core";
import { env } from "../config/env.ts";
import {
  isAiPlatformLockedShared,
  isMcpModuleDisabled,
} from "./ai-platform-lock.ts";
import { listCallableTools } from "./ai-tool-invoke.service.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";
import { db } from "../db/index.ts";
import { mcpAuthCodes, mcpClients, mcpTokens } from "../db/schema/ai.ts";
import { withTenant } from "../db/tenant.ts";
import {
  emitMcpEvent,
  loadMcpSettings,
  sha256Hex,
  tenantScopeById,
  toMcpClient,
} from "./mcp-common.ts";

/** RFC 6749 error carried to the route; `redirect` = safe to send to redirect_uri. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
    readonly redirectUri: string | null = null,
  ) {
    super(description);
    this.name = "OAuthError";
  }
}

/**
 * Platform lock refusal (founder W16 Q7). Answers 403 with the description
 * `AI_PLATFORM_DISABLED`; `redirectUri` is passed only once it is known to be
 * registered for the client, so the route may then redirect with the error.
 */
function platformLockedError(redirectUri: string | null = null): OAuthError {
  return new OAuthError(
    "access_denied",
    "AI_PLATFORM_DISABLED",
    403,
    redirectUri,
  );
}

/** `redirect_uri?error=...&state=...` for an error the client may see. */
export function oauthErrorRedirect(
  error: OAuthError,
  state: string | undefined,
): string {
  const url = new URL(error.redirectUri!);
  url.searchParams.set("error", error.error);
  url.searchParams.set("error_description", error.description);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CODE_TTL_SQL = sql`now() + interval '10 minutes'`;
const MAX_PENDING_DYNAMIC_CLIENTS = 50;

const scopeSet = new Set<string>(MCP_SCOPES);

export type AuthorizeParams = {
  responseType?: string;
  clientId?: string;
  redirectUri?: string;
  scope?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
};

/**
 * Check an authorization request against the tenant and the client. Never
 * issues anything and needs no user: the GET endpoint uses it before it sends
 * the browser to the consent screen, `issueAuthorizationCode` before a code.
 * Errors carry `redirectUri` only when it is registered for the client.
 */
export async function validateAuthorizationRequest(
  tenantIdRaw: string,
  params: AuthorizeParams,
  { requirePkce = true }: { requirePkce?: boolean } = {},
) {
  const tenantId = tenantIdSchema.parse(tenantIdRaw);
  if (!params.clientId || !params.redirectUri)
    throw new OAuthError(
      "invalid_request",
      "client_id and redirect_uri are required.",
    );
  const context = tenantScopeById(tenantId);
  const settings = await loadMcpSettings(tenantId);
  const clientRow = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(mcpClients)
      .where(
        and(
          eq(mcpClients.tenantId, tenantId),
          eq(mcpClients.clientId, params.clientId!),
        ),
      )
      .limit(1);
    return row;
  });
  // Platform lock: answered before any other refusal. The redirect_uri is
  // not trusted until the client registered it, so an unknown client or an
  // unregistered redirect_uri gets a plain 403 JSON (never a redirect to an
  // unvalidated URI); a registered one gets the OAuth-safe error redirect
  // below (`error=access_denied`, `error_description=AI_PLATFORM_DISABLED`).
  if (
    settings.platformLocked &&
    !(clientRow && clientRow.redirectUris.includes(params.redirectUri))
  )
    throw platformLockedError();
  if (!clientRow)
    throw new OAuthError("invalid_client", "Unknown client.", 400);
  // Never redirect to a URI the client did not register.
  if (!clientRow.redirectUris.includes(params.redirectUri))
    throw new OAuthError(
      "invalid_request",
      "redirect_uri is not registered for this client.",
    );
  const redirectUri = params.redirectUri;
  const fail = (error: string, description: string): never => {
    throw new OAuthError(error, description, 400, redirectUri);
  };
  if (settings.platformLocked) throw platformLockedError(redirectUri);
  if (!settings.mcpEnabled || !settings.aiEnabled)
    fail("access_denied", "MCP is turned off for this organisation.");
  if (clientRow.status !== "approved")
    fail("unauthorized_client", "MCP_CLIENT_NOT_APPROVED");
  if (params.responseType !== "code")
    fail("unsupported_response_type", "Only response_type=code is supported.");
  // The consent preview may omit PKCE; a code is never issued without it.
  if (requirePkce || params.codeChallengeMethod !== undefined) {
    if (params.codeChallengeMethod !== "S256")
      fail("invalid_request", "code_challenge_method must be S256.");
  }
  if (
    (requirePkce || params.codeChallenge !== undefined) &&
    (!params.codeChallenge || !CHALLENGE_RE.test(params.codeChallenge))
  )
    fail("invalid_request", "A valid code_challenge is required.");

  const requested = (params.scope ?? "")
    .split(/\s+/)
    .filter((s) => s.length > 0);
  if (requested.some((s) => !scopeSet.has(s)))
    fail("invalid_scope", "Unknown scope.");
  const allowed = new Set(clientRow.allowedScopes);
  const granted = requested.length
    ? requested.filter((s) => allowed.has(s))
    : [...clientRow.allowedScopes];
  if (granted.length === 0)
    fail("invalid_scope", "No requested scope is approved for this client.");
  return { tenantId, context, clientRow, redirectUri, granted, fail };
}

/**
 * Issue a code for the signed-in user who confirmed on the consent screen.
 * Returns the full redirect URL (`redirect_uri?code=...&state=...`). The user
 * must hold a role in the tenant and `ai.ask`, the tenant AI switch must be
 * on, and a required second factor must be verified in this session. Granted
 * scopes are cut to the scopes of tools the user's permissions allow.
 */
type ValidatedRequest = Awaited<
  ReturnType<typeof validateAuthorizationRequest>
>;

/**
 * What this user may grant: the user must hold a role in the tenant and
 * `ai.ask`, a required second factor must be verified in this session, and the
 * scopes are cut to the scopes of tools the user's permissions allow.
 */
async function grantableScopes(
  access: AccessSnapshot,
  validated: ValidatedRequest,
): Promise<string[]> {
  const { clientRow, granted, fail } = validated;
  if (access.permissions.length === 0)
    fail("access_denied", "You have no role in this organisation.");
  if (!access.permissions.includes("ai.ask"))
    fail("access_denied", "Your account cannot use Tanya AI.");
  if (access.mfaRequired && !access.mfaVerified)
    fail("access_denied", "Verify your second factor before connecting.");
  const callable = await listCallableTools(
    { access, channel: "mcp", mcpClientId: clientRow.id, now: new Date() },
    { scopes: granted },
  );
  const reachable = new Set<string>(callable.map((tool) => tool.scope));
  const scopes = [...new Set(granted)].filter((s) => reachable.has(s));
  if (scopes.length === 0)
    fail("invalid_scope", "None of the scopes is allowed for your account.");
  return scopes;
}

/** Consent screen preview: the client and the scopes the user may grant. */
export async function previewAuthorizationRequest(
  access: AccessSnapshot,
  params: AuthorizeParams,
) {
  const validated = await validateAuthorizationRequest(
    access.tenant.tenantId,
    params,
    { requirePkce: false },
  );
  const scopes = await grantableScopes(access, validated);
  return {
    clientName: validated.clientRow.name,
    redirectUri: validated.redirectUri,
    scopes: scopes.map((scope) => ({
      scope: scope as McpScope,
      label: MCP_SCOPE_LABELS_ID[scope as McpScope],
    })),
  };
}

/**
 * Issue a code for the signed-in user who confirmed on the consent screen.
 * Returns the full redirect URL (`redirect_uri?code=...&state=...`).
 */
export async function issueAuthorizationCode(
  access: AccessSnapshot,
  params: AuthorizeParams,
): Promise<string> {
  const validated = await validateAuthorizationRequest(
    access.tenant.tenantId,
    params,
  );
  const { tenantId, context, clientRow, redirectUri } = validated;
  const userId = userIdSchema.parse(access.userId);
  const scopes = await grantableScopes(access, validated);

  const code = randomBytes(32).toString("base64url");
  await withTenant(db, context, async (tx) => {
    // Re-check under a shared tenant row lock: a lock change that commits
    // between the validation above and this insert cannot slip a code out.
    if (await isAiPlatformLockedShared(tx, tenantId))
      throw platformLockedError(redirectUri);
    await tx.insert(mcpAuthCodes).values({
      tenantId,
      mcpClientId: clientRow.id,
      userId,
      codeHash: sha256Hex(code),
      codeChallenge: params.codeChallenge!,
      codeChallengeMethod: "S256",
      redirectUri,
      scopes,
      expiresAt: CODE_TTL_SQL as never,
    });
  });
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (params.state) url.searchParams.set("state", params.state);
  return url.toString();
}

export type TokenExchangeInput = {
  grantType?: string;
  code?: string;
  redirectUri?: string;
  clientId?: string;
  codeVerifier?: string;
};

export type IssuedToken = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
};

function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(
    Buffer.from(sha256Hex(verifier), "hex").toString("base64url"),
  );
  const expected = Buffer.from(challenge);
  return (
    computed.length === expected.length && timingSafeEqual(computed, expected)
  );
}

/** Exchange a code for an access token (RFC 6749 §4.1.3 + PKCE). */
export async function exchangeAuthorizationCode(
  input: TokenExchangeInput,
): Promise<IssuedToken> {
  if (input.grantType !== "authorization_code")
    throw new OAuthError(
      "unsupported_grant_type",
      "Only authorization_code is supported.",
    );
  if (
    !input.code ||
    !input.clientId ||
    !input.redirectUri ||
    !input.codeVerifier
  )
    throw new OAuthError(
      "invalid_request",
      "code, client_id, redirect_uri and code_verifier are required.",
    );
  if (!VERIFIER_RE.test(input.codeVerifier))
    throw new OAuthError("invalid_grant", "Invalid code_verifier.");

  const resolved = await db.execute<{ id: string; tenant_id: string }>(
    sql`SELECT id, tenant_id FROM app.mcp_resolve_auth_code(${sha256Hex(input.code)})`,
  );
  const hit = resolved.rows[0];
  if (!hit)
    throw new OAuthError("invalid_grant", "Invalid authorization code.");
  const tenantId = tenantIdSchema.parse(hit.tenant_id);
  const context = tenantScopeById(tenantId);
  const settings = await loadMcpSettings(tenantId);
  const ttl = Math.min(env.MCP_TOKEN_TTL_SECONDS, 86_400);
  const raw = `mcp_${randomBytes(24).toString("hex")}`;
  const now = new Date();

  const outcome = await withTenant(db, context, async (tx) => {
    // Take the shared tenant row lock first (platform lock check), before the
    // code row is read or burned: a locked tenant leaves the code untouched,
    // and no token is issued after a lock change commits.
    const platformLocked = await isAiPlatformLockedShared(tx, tenantId);
    // `mcp` module off: same answer as an unknown code (981 / legend-hbuq3).
    // Checked before the platform lock answer, so a tenant with the module off
    // never learns the platform state (invalid_grant, not AI_PLATFORM_DISABLED).
    // Still before the code row is read or burned: a module switched off
    // mid-exchange leaves the code unused and issues no token or event.
    if (await isMcpModuleDisabled(tx, tenantId))
      return { error: "module_disabled" as const };
    if (platformLocked) return { error: "platform_locked" as const };
    // Lock the code row: concurrent exchanges of one code issue one token.
    const [row] = await tx
      .select()
      .from(mcpAuthCodes)
      .where(
        and(eq(mcpAuthCodes.id, hit.id), eq(mcpAuthCodes.tenantId, tenantId)),
      )
      .for("update")
      .limit(1);
    if (!row || row.usedAt !== null) return { error: "used" as const };
    const burn = () =>
      tx
        .update(mcpAuthCodes)
        .set({ usedAt: sql`now()` })
        .where(eq(mcpAuthCodes.id, row.id));
    await burn();
    if (row.expiresAt.getTime() < Date.now())
      return { error: "expired" as const };
    const [client] = await tx
      .select()
      .from(mcpClients)
      .where(
        and(
          eq(mcpClients.tenantId, tenantId),
          eq(mcpClients.id, row.mcpClientId),
        ),
      )
      .limit(1);
    if (
      !client ||
      client.clientId !== input.clientId ||
      row.redirectUri !== input.redirectUri ||
      !pkceMatches(input.codeVerifier!, row.codeChallenge)
    )
      return { error: "mismatch" as const };
    if (client.status !== "approved" || !settings.mcpEnabled)
      return { error: "not_approved" as const };
    const scopes = row.scopes.filter((s) => client.allowedScopes.includes(s));
    if (scopes.length === 0) return { error: "not_approved" as const };
    const [token] = await tx
      .insert(mcpTokens)
      .values({
        tenantId,
        mcpClientId: client.id,
        userId: row.userId,
        tokenHash: sha256Hex(raw),
        tokenPrefix: raw.slice(0, 12),
        scopes,
        expiresAt: sql`now() + make_interval(secs => ${ttl})` as never,
      })
      .returning();
    if (!token) throw new Error("mcp token insert returned no row");
    await emitMcpEvent(tx, context, "mcp_token.issued", {
      aggregateId: token.id,
      actor: { type: "user", id: row.userId },
      now,
      payload: {
        mcpTokenId: token.id,
        mcpClientId: client.id,
        userId: row.userId,
        tokenPrefix: token.tokenPrefix,
        scopes,
        expiresAt: token.expiresAt.toISOString(),
        issuedAt: token.createdAt.toISOString(),
      },
    });
    return { token, scopes };
  });

  if ("error" in outcome && outcome.error === "platform_locked")
    throw platformLockedError();
  if ("error" in outcome && outcome.error === "module_disabled")
    throw new OAuthError("invalid_grant", "Invalid authorization code.");
  if ("error" in outcome)
    throw new OAuthError(
      outcome.error === "not_approved"
        ? "unauthorized_client"
        : "invalid_grant",
      outcome.error === "not_approved"
        ? "MCP_CLIENT_NOT_APPROVED"
        : "The authorization code is invalid, used or expired.",
    );
  const { token, scopes } = outcome;
  return {
    access_token: raw,
    token_type: "Bearer",
    expires_in: Math.max(
      1,
      Math.round(
        (token.expiresAt.getTime() - token.createdAt.getTime()) / 1000,
      ),
    ),
    scope: scopes.join(" "),
  };
}

export type DynamicRegistrationInput = {
  clientName: string;
  redirectUris: string[];
  scopes: McpScope[];
};

/** RFC 7591 registration. Only while the tenant allows it; always `pending`. */
export async function registerDynamicClient(
  tenantIdRaw: string,
  input: DynamicRegistrationInput,
) {
  const tenantId = tenantIdSchema.parse(tenantIdRaw);
  const settings = await loadMcpSettings(tenantId);
  if (settings.platformLocked) throw platformLockedError();
  if (!settings.mcpEnabled || !settings.dynamicClientRegistrationEnabled)
    throw new OAuthError(
      "access_denied",
      "Dynamic client registration is turned off.",
      403,
    );
  for (const uri of input.redirectUris)
    if (!mcpRedirectUriSchema.safeParse(uri).success)
      throw new OAuthError("invalid_redirect_uri", "Invalid redirect_uri.");
  const context = tenantScopeById(tenantId);
  const clientId = `dyn_${randomBytes(12).toString("hex")}`;
  const now = new Date();
  return withTenant(db, context, async (tx) => {
    // Re-check under a shared tenant row lock (see issueAuthorizationCode).
    if (await isAiPlatformLockedShared(tx, tenantId))
      throw platformLockedError();
    const [pending] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(mcpClients)
      .where(
        and(
          eq(mcpClients.tenantId, tenantId),
          eq(mcpClients.registeredVia, "dynamic"),
          eq(mcpClients.status, "pending"),
        ),
      );
    if ((pending?.n ?? 0) >= MAX_PENDING_DYNAMIC_CLIENTS)
      throw new OAuthError(
        "access_denied",
        "Too many pending registrations. Ask an admin to review them.",
        429,
      );
    const [row] = await tx
      .insert(mcpClients)
      .values({
        tenantId,
        name: input.clientName,
        clientId,
        redirectUris: input.redirectUris,
        allowedScopes: input.scopes,
        status: "pending",
        registeredVia: "dynamic",
      })
      .returning();
    if (!row) throw new Error("mcp client insert returned no row");
    await emitMcpEvent(tx, context, "mcp_client.registered", {
      aggregateId: row.id,
      actor: { type: "system" },
      now,
      payload: {
        mcpClientId: row.id,
        registeredVia: "dynamic",
        registeredAt: row.createdAt.toISOString(),
      },
    });
    return toMcpClient(row);
  });
}
