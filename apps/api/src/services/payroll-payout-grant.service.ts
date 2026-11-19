// One-time payout step grants (legend-911, P1-1 of the second opinion on 905).
//
// A trusted payout money step (correction, overpaid, return, proof closure,
// posting source, the withdraw of a correction or overpaid proposal, and the
// "not me" disown and unfreeze of legend-l2zru) no longer takes (actor,
// session) from the app: it spends a grant that only the grantor database login
// can issue (migration 0419, `app.payout_grant_issue`). The grant names the
// actor and session itself and is bound to the exact step, batch, item set,
// evidence key, ref and target.
//
// The issuer exists per request and works only after the request passed the
// payout step-up (`requireTenantStepUpPassword` records it, `payoutStepUpOf`).
// The secret returned by `issue` is a SQL argument for the very next trusted
// call: never log it, never return it to the browser, never put it in an error.
import type { Request } from "express";
import type { PoolClient } from "pg";
import { payoutGrantorPool } from "../db/grantor.ts";
import { HttpError } from "../lib/http-error.ts";
import { getAuth } from "../middleware/auth.ts";
import { payoutStepUpOf } from "../middleware/identity.ts";
import { getTenantContext } from "../middleware/tenant.ts";
import { PAYOUT_STEP_UP_MAX_AGE_MINUTES } from "./payroll-payout-evidence.ts";

export type PayoutGrantBinding = {
  kind:
    | "correction"
    | "overpaid"
    | "return"
    | "closure"
    | "posting_source"
    | "resolve"
    | "bank_confirm"
    | "batch_approve"
    | "disown"
    | "unfreeze"
    | "recon_clear"
    | "hold_release"
    | "return_withdraw";
  step: "propose" | "approve" | "record" | "confirm" | "withdraw";
  batchId: string | null;
  itemIds: readonly string[];
  evidenceKey: string | null;
  refId: string | null;
  targetId: string | null;
  /**
   * The outcome a grant covers (legend-r86qa): `failed` or `not_sent` for kind
   * `resolve`, `succeeded` for kind `bank_confirm`, the sha256 (hex) of the
   * reason for kind `disown`, `unfreeze` (legend-l2zru), `recon_clear`
   * (legend-xbagc), `hold_release` (legend-6o7pc) and `return_withdraw`
   * (legend-snwnn); NULL for every
   * other kind.
   */
  detail?: string | null;
};

export type PayoutGrantIssuer = {
  /** Resolves to the grant secret (64 hex), valid 2 minutes, usable once. */
  issue(binding: PayoutGrantBinding): Promise<string>;
};

const ISSUE_SQL = `SELECT app.payout_grant_issue(
  $1::text, $2::text, $3::uuid, $4::uuid[], $5::varchar, $6::uuid, $7::uuid,
  $8::varchar, $9::text, $10::text, $11::text) AS secret`;

const reauthRequired = () =>
  new HttpError(
    401,
    "REAUTH_REQUIRED",
    "Silakan autentikasi ulang untuk melanjutkan.",
  );

/** The database codes of `app.payout_grant_issue`, as client errors. */
function issueError(error: unknown): unknown {
  // lock_timeout (55P03) or statement_timeout (57014) of the grantor pool: no
  // grant was issued, the caller retries.
  const sqlState =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  if (sqlState === "55P03" || sqlState === "57014")
    return new HttpError(
      503,
      "PAYOUT_STEP_GRANT_UNAVAILABLE",
      "Izin langkah pembayaran belum dapat diterbitkan karena sistem sibuk. Coba lagi.",
    );
  const message =
    typeof error === "object" && error !== null
      ? (error as { message?: unknown }).message
      : undefined;
  const code =
    typeof message === "string" ? /^PAYOUT-(\d\d):/.exec(message) : null;
  switch (code?.[1]) {
    case "40":
    case "41":
      return reauthRequired();
    case "39":
    case "42":
      return new HttpError(
        403,
        "PAYOUT_ACTOR_REFUSED",
        "Anda tidak berhak menjalankan langkah pembayaran ini.",
      );
    case "79":
      // A frozen batch gets no grant (legend-l2zru).
      return new HttpError(
        409,
        "PAYOUT_BATCH_FROZEN",
        'Batch pembayaran ini dibekukan karena ada pengakuan "bukan saya". Finance perlu memeriksanya dan membuka pembekuan.',
      );
    case "81":
      // Disown of a log row that is not the caller's, or not on this batch:
      // answered like a row that does not exist.
      return new HttpError(
        404,
        "PAYOUT_APPROVAL_LOG_NOT_FOUND",
        "Catatan persetujuan tidak ditemukan.",
      );
    case "82":
      return new HttpError(
        409,
        "PAYOUT_UNFREEZE_REFUSED",
        "Anda tidak dapat membuka pembekuan batch ini.",
      );
    case "83":
      // A batch approval grant for a batch that no longer waits for approval
      // (a lost approve race): same answer as the approve path itself.
      return new HttpError(
        409,
        "PAYOUT_BATCH_STATE",
        "Batch belum diajukan atau sudah diproses.",
      );
    case "16":
      return new HttpError(
        403,
        "PAYOUT_SELF_APPROVAL",
        "Pembuat batch tidak boleh menyetujui batchnya sendiri.",
      );
    case "84":
      // The person who said "not me" to a main approval cannot approve it again.
      return new HttpError(
        403,
        "PAYOUT_DISOWNER_REFUSED",
        'Anda sudah menyatakan "bukan saya" pada persetujuan batch ini, jadi tidak boleh menyetujuinya lagi.',
      );
    case "85":
      return new HttpError(
        422,
        "PAYOUT_RECON_CLEAR_REASON_INVALID",
        "Alasan penutupan flag wajib diisi (10 sampai 500 karakter).",
      );
    case "86":
      // The proposer of a recon clearance cannot approve it (legend-xbagc).
      return new HttpError(
        403,
        "PAYOUT_RECON_CLEAR_SELF_APPROVAL",
        "Pengusul penutupan flag tidak boleh menyetujuinya sendiri.",
      );
    case "87":
      return new HttpError(
        409,
        "PAYOUT_RECON_CLEAR_STATE",
        "Penutupan flag ini sudah disetujui.",
      );
    case "96":
      // A hold that a later flag took over is decided by that flag (legend-6o7pc).
      return new HttpError(
        409,
        "PAYOUT_RECON_HOLD_TAKEN_OVER",
        "Hold ini sudah diambil alih flag rekonsiliasi. Flag itu dan penutupannya yang menentukan.",
      );
    case "97":
      return new HttpError(
        409,
        "PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN",
        "Bukti rekonsiliasi belum bersih, jadi hold tetap ditahan.",
      );
    case "72":
      return new HttpError(
        422,
        "PAYOUT_GRANT_REFUSED",
        "Izin langkah pembayaran tidak dapat diterbitkan untuk data ini.",
      );
    default:
      return error;
  }
}

async function issueOnGrantor(
  tenantId: string,
  binding: PayoutGrantBinding,
  actor: string,
  sessionId: string,
  method: string,
): Promise<string> {
  const grantor = payoutGrantorPool();
  if (!grantor)
    throw new HttpError(
      503,
      "PAYOUT_STEP_GRANT_UNAVAILABLE",
      "Langkah pembayaran belum dapat dijalankan: izin langkah belum dikonfigurasi.",
    );
  const client: PoolClient = await grantor.pool.connect();
  try {
    await client.query("BEGIN");
    if (grantor.fallbackRole)
      await client.query("SET LOCAL ROLE legend_payout_grantor");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    const result = await client.query<{ secret: string }>(ISSUE_SQL, [
      binding.kind,
      binding.step,
      binding.batchId,
      [...binding.itemIds],
      binding.evidenceKey,
      binding.refId,
      binding.targetId,
      binding.detail ?? null,
      actor,
      sessionId,
      method,
    ]);
    await client.query("COMMIT");
    const secret = result.rows[0]?.secret;
    if (typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret))
      throw new HttpError(
        503,
        "PAYOUT_STEP_GRANT_UNAVAILABLE",
        "Langkah pembayaran belum dapat dijalankan: izin langkah tidak terbit.",
      );
    return secret;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw issueError(error);
  } finally {
    client.release();
  }
}

/**
 * The issuer of this request. Every `issue` call re-checks that the request
 * passed the payout step-up as the same user and session that `getAuth` names,
 * and that the step-up is no older than PAYOUT_STEP_UP_MAX_AGE_MINUTES: else 401
 * REAUTH_REQUIRED. No grantor pool configured: 503
 * PAYOUT_STEP_GRANT_UNAVAILABLE. The tenant is the request's tenant (the "not
 * me" disown has no permission middleware, so no scoped context).
 */
export function payoutGrantIssuerOf(req: Request): PayoutGrantIssuer {
  return {
    async issue(binding) {
      const stepUp = payoutStepUpOf(req);
      // No step-up record: refuse before anything reads the request's session.
      if (!stepUp) throw reauthRequired();
      const auth = getAuth(req);
      if (
        stepUp.userId !== auth.user.id ||
        stepUp.sessionId !== auth.session.id
      )
        throw reauthRequired();
      const ageMs = Date.now() - stepUp.at.getTime();
      if (!(ageMs >= 0 && ageMs <= PAYOUT_STEP_UP_MAX_AGE_MINUTES * 60_000))
        throw reauthRequired();
      return issueOnGrantor(
        getTenantContext(req).tenantId,
        binding,
        auth.user.id,
        auth.session.id,
        stepUp.method,
      );
    },
  };
}
