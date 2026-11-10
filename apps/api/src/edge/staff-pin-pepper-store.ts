// Edge-side storage of the derived staff pin peppers (bead legend-ideif; PRD
// v1.7 §3 F5 Server Lokal, offline pin check). The edge box keeps, per tenant,
// outlet and key version, the DERIVED pepper (never the root pepper) in its own
// database, sealed at rest.
//
// - The seal key is HKDF-SHA-256 over the edge link credential secret (the
//   last segment of EDGE_NODE_CREDENTIAL, see edge/credential.ts), so a copy
//   of the database alone does not reveal the peppers.
// - Each pepper is sealed with AES-256-GCM, a random 12-byte IV, and AAD bound
//   to the tenant, outlet and key version (a row copied to another tenant,
//   outlet or version fails to open; legend-jmsdx). Stored as
//   base64(iv | tag | ciphertext).
// - `openEdgePepper` never throws and never logs; `loadEdgePeppers` skips rows
//   that fail to open, so a bad row cannot take the others down.
// - Tenant and outlet come from the node's own row, never from the caller
//   (TEN-02), like edge-device-sync-store.ts.
// Never log a pepper or a ciphertext, and never put one in an error message.
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { edgeNodes, edgeStaffPinPeppers } from "../db/schema/edge-node.ts";
import { withTenant } from "../db/tenant.ts";
import { EDGE_PEPPER_MIN_VERSION } from "./staff-pin-pepper-registry.ts";

const SEAL_SALT = "legend";
const SEAL_INFO = "legend:edge-pepper-seal:v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

type PepperBinding = { tenantId: string; outletId: string; version: number };

function aad(binding: PepperBinding): Buffer {
  return Buffer.from(
    `legend:edge-pepper:${binding.tenantId}:${binding.outletId}:${binding.version}`,
    "utf8",
  );
}

/** HKDF-SHA-256 seal key derived from the edge credential secret. */
export function deriveEdgePepperSealKey(credentialSecret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(credentialSecret, "utf8"),
      Buffer.from(SEAL_SALT, "utf8"),
      Buffer.from(SEAL_INFO, "utf8"),
      KEY_BYTES,
    ),
  );
}

/** AES-256-GCM seal; returns base64(iv | tag | ciphertext). */
export function sealEdgePepper(
  key: Buffer,
  binding: PepperBinding,
  pepper: Buffer,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(binding));
  const ct = Buffer.concat([cipher.update(pepper), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

/** Null on any failure (wrong key, wrong binding, tampering, bad input). */
export function openEdgePepper(
  key: Buffer,
  binding: PepperBinding,
  sealed: string,
): Buffer | null {
  try {
    const raw = Buffer.from(sealed, "base64");
    if (raw.length < IV_BYTES + TAG_BYTES) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    return null;
  }
}

/**
 * Version to pepper for this node; rows that fail to open are skipped. A row
 * below the edge minimum version (an old tenant-wide v1 pepper) is deleted on
 * load, so it does not stay on the edge disk.
 */
export async function loadEdgePeppers(
  context: ScopedTenantContext,
  edgeNodeId: string,
  key: Buffer,
): Promise<Map<number, Buffer>> {
  const rows = await withTenant(db, context, async (tx) => {
    await tx
      .delete(edgeStaffPinPeppers)
      .where(
        and(
          eq(edgeStaffPinPeppers.edgeNodeId, edgeNodeId),
          lt(edgeStaffPinPeppers.version, EDGE_PEPPER_MIN_VERSION),
        ),
      );
    return tx
      .select({
        tenantId: edgeStaffPinPeppers.tenantId,
        outletId: edgeStaffPinPeppers.outletId,
        version: edgeStaffPinPeppers.version,
        ciphertext: edgeStaffPinPeppers.ciphertext,
      })
      .from(edgeStaffPinPeppers)
      .where(eq(edgeStaffPinPeppers.edgeNodeId, edgeNodeId));
  });
  const peppers = new Map<number, Buffer>();
  for (const row of rows) {
    // Defensive: an edge never holds version 1 (per tenant, cloud only).
    if (row.version < EDGE_PEPPER_MIN_VERSION) continue;
    const pepper = openEdgePepper(
      key,
      { tenantId: row.tenantId, outletId: row.outletId, version: row.version },
      row.ciphertext,
    );
    if (pepper) peppers.set(row.version, pepper);
  }
  return peppers;
}

/** Upsert; the node row must exist (the foreign key refuses anything else). */
export async function saveEdgePeppers(
  context: ScopedTenantContext,
  edgeNodeId: string,
  key: Buffer,
  peppers: ReadonlyArray<{ version: number; pepper: Buffer }>,
): Promise<void> {
  if (peppers.length === 0) return;
  await withTenant(db, context, async (tx) => {
    const [node] = await tx
      .select({ tenantId: edgeNodes.tenantId, outletId: edgeNodes.outletId })
      .from(edgeNodes)
      .where(eq(edgeNodes.id, edgeNodeId))
      .limit(1);
    if (!node) throw new Error("Edge node not found for staff pin peppers");
    for (const { version, pepper } of peppers) {
      const ciphertext = sealEdgePepper(
        key,
        { tenantId: node.tenantId, outletId: node.outletId, version },
        pepper,
      );
      await tx
        .insert(edgeStaffPinPeppers)
        .values({
          tenantId: node.tenantId,
          outletId: node.outletId,
          edgeNodeId,
          version,
          ciphertext,
        })
        .onConflictDoUpdate({
          target: [
            edgeStaffPinPeppers.tenantId,
            edgeStaffPinPeppers.edgeNodeId,
            edgeStaffPinPeppers.version,
          ],
          set: { ciphertext, updatedAt: sql`now()` },
        });
    }
  });
}
