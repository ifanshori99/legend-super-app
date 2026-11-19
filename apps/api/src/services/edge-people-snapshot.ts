// Edge people snapshot, cloud side (legend-ye4j1, card C2; design
// docs/design/hris-edge-replication.md 3.1, 3.2, 3.5, 4).
//
// `GET /api/edge-sync/people-snapshot` returns a full read-only projection of
// the people an outlet needs to clock offline. The caller is an edge node
// authenticated by its own credential: tenant and outlet come only from the
// verified credential, never from the request.
//
// - Columns are projected by hand to the contract whitelist
//   (`packages/shared/src/edge/people-snapshot.ts`) and the result is parsed
//   with that strict schema, so a stray column fails here and on the edge.
// - Never sent: account rows, password hashes, real email, image, sealed
//   employee PII (NIK, NPWP, BPJS, bank, emergency contact), legal entity,
//   position, org unit, manager, the QR seed, any private key.
// - Projection: `homeOutletId` = the node's outlet, `assignedBy` = the
//   assignee, email `<id>@edge.invalid`, shift template and station null.
// - ETag = SHA-256 of the canonical data sections (sorted keys, rows sorted by
//   id). `generatedAt` travels in a header and is never hashed.
// - No snapshot content is ever logged.
import { createHash, createPublicKey } from "node:crypto";
import {
  EDGE_PEOPLE_SNAPSHOT_EMAIL_DOMAIN,
  edgePeopleSnapshotCloudSchema,
  type EdgePeopleSnapshot,
} from "@starter/shared/edge";
import { rolePermissionsAsGranted } from "@starter/shared/access";
import {
  addBusinessDays,
  CoreError,
  localDateOf,
  type TenantId,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../db/index.ts";
import { user } from "../db/schema/user.ts";
import { roleAssignments, roles } from "../db/schema/platform-access.ts";
import { employees } from "../db/schema/hris.ts";
import { shiftAssignments } from "../db/schema/hris-scheduling.ts";
import {
  attendancePolicies,
  attendanceQrSecrets,
} from "../db/schema/hris-attendance.ts";
import { staffPins } from "../db/schema/device-pin.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import { outletContext } from "./device-pin-support.ts";
import { deriveQrDayKeys } from "./hris-attendance-qr.ts";
import { ensureQrSeed } from "./hris-attendance.service.ts";
import {
  verifiedEdgeNodeSchema,
  type VerifiedEdgeNode,
} from "./staff-pin-sync.ts";

const MS_PER_DAY = 86_400_000;
/** Minimum RSA modulus of the selfie seal key (design 5). */
const SEAL_KEY_MIN_BITS = 3072;

/** Shifts are sent from today-1 to today+7 (design 3.2). */
const SHIFT_DAYS_BEHIND = 1;
const SHIFT_DAYS_AHEAD = 7;
/** QR day keys: UTC days D-1 .. D+AHEAD (design 4). */
const QR_DAYS_BEHIND = 1;
const QR_DAYS_AHEAD_DEFAULT = 3;
const QR_DAYS_AHEAD_MAX = 14;

export type PeopleSnapshotResult = {
  readonly body: EdgePeopleSnapshot;
  /** Strong validator: `"<sha256 hex>"`. */
  readonly etag: string;
  /** ISO time, for the response header only. */
  readonly generatedAt: string;
};

export type PeopleSnapshotOptions = {
  readonly now?: Date;
  /** Test seam; default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/** Days of look-ahead for QR day keys: `EDGE_QR_KEY_DAYS_AHEAD` (default 3). */
function qrDaysAhead(env: Readonly<Record<string, string | undefined>>) {
  const raw = env.EDGE_QR_KEY_DAYS_AHEAD;
  if (raw === undefined || raw.trim() === "") return QR_DAYS_AHEAD_DEFAULT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return QR_DAYS_AHEAD_DEFAULT;
  return Math.min(value, QR_DAYS_AHEAD_MAX);
}

/**
 * Public half of the active selfie seal key (design 5): the cloud holds
 * `ATTENDANCE_SELFIE_SEAL_KEYS` (JSON `{kid: PKCS#8 PEM}`) and
 * `ATTENDANCE_SELFIE_SEAL_ACTIVE_KID`. Only the SPKI public key leaves this
 * function; unset or unreadable config gives null (the edge then answers 503
 * `SELFIE_SEAL_KEY_MISSING`), and neither the private key nor a parse error
 * detail is ever returned or logged.
 */
export function loadSelfieSealPublicKey(
  env: Readonly<Record<string, string | undefined>>,
): { kid: string; publicKeyPem: string } | null {
  const kid = env.ATTENDANCE_SELFIE_SEAL_ACTIVE_KID?.trim();
  const rawKeys = env.ATTENDANCE_SELFIE_SEAL_KEYS;
  if (!kid || !rawKeys) return null;
  // A configured but unusable key is logged by reason only (never a value), so
  // ops can see why every edge answers 503 SELFIE_SEAL_KEY_MISSING.
  const unusable = (reason: string): null => {
    logger.warn({ reason }, "edge people snapshot: selfie seal key unusable");
    return null;
  };
  try {
    const keys: unknown = JSON.parse(rawKeys);
    if (typeof keys !== "object" || keys === null)
      return unusable("keys_not_object");
    const pem = (keys as Record<string, unknown>)[kid];
    if (typeof pem !== "string") return unusable("active_kid_missing");
    const key = createPublicKey(pem);
    // Design 5: RSA-OAEP-SHA256 with a 3072-bit key. Anything else would make
    // every edge selfie seal fail (or seal weakly), so it is never sent.
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < SEAL_KEY_MIN_BITS
    )
      return unusable("key_not_rsa_3072");
    const publicKeyPem = key.export({ type: "spki", format: "pem" }).toString();
    return { kid, publicKeyPem };
  } catch {
    return unusable("key_unreadable");
  }
}

/** Canonical JSON: object keys sorted at every depth; array order kept. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 over the data sections only; the response has no per-request value. */
export function peopleSnapshotEtag(body: EdgePeopleSnapshot): string {
  return `"${createHash("sha256").update(canonicalJson(body)).digest("hex")}"`;
}

/** True when an `If-None-Match` header value names `etag` (also `*`, weak `W/`). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .some((part) => part === "*" || part === etag);
}

function byId<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export async function buildEdgePeopleSnapshot(
  node: VerifiedEdgeNode,
  options: PeopleSnapshotOptions = {},
): Promise<PeopleSnapshotResult> {
  const verified = verifiedEdgeNodeSchema.parse(node);
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const tenantId = verified.tenantId as TenantId;
  const outletId = verified.outletId;
  const tenant = establishTenantContext({
    tenantId: verified.tenantId,
    brandId: null,
    source: "device",
  });
  const context = outletContext(tenant, outletId);

  const dayNow = Math.floor(now.getTime() / MS_PER_DAY);
  const qrFrom = dayNow - QR_DAYS_BEHIND;
  const qrCount = QR_DAYS_BEHIND + 1 + qrDaysAhead(env);

  const parts = await withTenant(db, context, async (tx) => {
    // Fail closed: an inactive tenant or a closed / unknown outlet gets nothing.
    const [tenantRow] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const [outletRow] = await tx
      .select({
        status: outlets.status,
        brandId: outlets.brandId,
        timezone: outlets.timezone,
      })
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
      .limit(1);
    if (
      tenantRow?.status !== "active" ||
      !outletRow ||
      outletRow.status === "closed"
    )
      throw new CoreError(
        "FORBIDDEN",
        "Edge node tidak dapat menyinkronkan outlet ini.",
      );

    const today = localDateOf(now, outletRow.timezone);
    const shiftFrom = addBusinessDays(today, -SHIFT_DAYS_BEHIND);
    const shiftTo = addBusinessDays(today, SHIFT_DAYS_AHEAD);
    const shiftLive = and(
      eq(shiftAssignments.tenantId, tenantId),
      eq(shiftAssignments.outletId, outletId),
      inArray(shiftAssignments.status, ["published", "swapped"]),
      gte(shiftAssignments.businessDate, shiftFrom),
      lte(shiftAssignments.businessDate, shiftTo),
    );

    // Employees: onboarding or active, with a user, and homed at O or rostered
    // at O in the window.
    const employeeRows = await tx
      .select({
        id: employees.id,
        tenantId: employees.tenantId,
        userId: employees.userId,
        employeeNo: employees.employeeNo,
        fullName: employees.fullName,
        employmentType: employees.employmentType,
        joinDate: employees.joinDate,
        endDate: employees.endDate,
        status: employees.status,
      })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, tenantId),
          inArray(employees.status, ["onboarding", "active"]),
          isNotNull(employees.userId),
          or(
            eq(employees.homeOutletId, outletId),
            inArray(
              employees.id,
              tx
                .select({ id: shiftAssignments.employeeId })
                .from(shiftAssignments)
                .where(shiftLive),
            ),
          ),
        ),
      )
      .orderBy(asc(employees.id));
    const employeeIds = employeeRows.map((row) => row.id);

    const shiftRows =
      employeeIds.length === 0
        ? []
        : await tx
            .select({
              id: shiftAssignments.id,
              tenantId: shiftAssignments.tenantId,
              outletId: shiftAssignments.outletId,
              employeeId: shiftAssignments.employeeId,
              businessDate: shiftAssignments.businessDate,
              segments: shiftAssignments.segments,
              breakMinutes: shiftAssignments.breakMinutes,
              status: shiftAssignments.status,
              source: shiftAssignments.source,
              publishedAt: shiftAssignments.publishedAt,
              createdBy: shiftAssignments.createdBy,
            })
            .from(shiftAssignments)
            .where(
              and(shiftLive, inArray(shiftAssignments.employeeId, employeeIds)),
            )
            .orderBy(asc(shiftAssignments.id));

    // Users: PIN holders at O plus the user of every employee sent.
    const pinRows = await tx
      .select({ userId: staffPins.userId })
      .from(staffPins)
      .where(
        and(eq(staffPins.tenantId, tenantId), eq(staffPins.outletId, outletId)),
      );
    const userIds = [
      ...new Set([
        ...pinRows.map((row) => row.userId),
        ...employeeRows.flatMap((row) => (row.userId ? [row.userId] : [])),
      ]),
    ];
    const userRows =
      userIds.length === 0
        ? []
        : await tx
            .select({
              id: user.id,
              name: user.name,
              banned: user.banned,
              banExpires: user.banExpires,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            })
            .from(user)
            .where(inArray(user.id, userIds))
            .orderBy(asc(user.id));

    // Assignments the cloud resolver would use at O: tenant scope, the brand of
    // O, or O itself; active now. Station scope is never sent (design 3.5).
    // A user who is banned right now gets none: the edge refuses an assignment
    // for a banned grantee (trigger role_assignments_grantee_guard), which would
    // fail the whole apply on every cycle. Same rule as `banned` below: a ban
    // that has run out no longer blocks.
    const sentUserIds = userRows
      .filter(
        (row) =>
          !(
            row.banned === true &&
            (row.banExpires === null || row.banExpires > now)
          ),
      )
      .map((row) => row.id);
    const assignmentRows =
      sentUserIds.length === 0
        ? []
        : await tx
            .select({
              id: roleAssignments.id,
              tenantId: roleAssignments.tenantId,
              userId: roleAssignments.userId,
              roleId: roleAssignments.roleId,
              scopeType: roleAssignments.scopeType,
              scopeId: roleAssignments.scopeId,
              validFrom: roleAssignments.validFrom,
              validUntil: roleAssignments.validUntil,
              assignedAt: roleAssignments.assignedAt,
            })
            .from(roleAssignments)
            .where(
              and(
                eq(roleAssignments.tenantId, tenantId),
                inArray(roleAssignments.userId, sentUserIds),
                lte(roleAssignments.validFrom, sql`statement_timestamp()`),
                or(
                  isNull(roleAssignments.validUntil),
                  sql`${roleAssignments.validUntil} > statement_timestamp()`,
                ),
                or(
                  eq(roleAssignments.scopeType, "tenant"),
                  and(
                    eq(roleAssignments.scopeType, "brand"),
                    eq(roleAssignments.scopeId, outletRow.brandId),
                  ),
                  and(
                    eq(roleAssignments.scopeType, "outlet"),
                    eq(roleAssignments.scopeId, outletId),
                  ),
                ),
              ),
            )
            .orderBy(asc(roleAssignments.id));
    const roleIds = [...new Set(assignmentRows.map((row) => row.roleId))];
    const roleRows =
      roleIds.length === 0
        ? []
        : await tx
            .select()
            .from(roles)
            .where(
              and(eq(roles.tenantId, tenantId), inArray(roles.id, roleIds)),
            )
            .orderBy(asc(roles.id));

    // Attendance policy: tenant default and the override for O.
    const policyRows = await tx
      .select()
      .from(attendancePolicies)
      .where(
        and(
          eq(attendancePolicies.tenantId, tenantId),
          or(
            isNull(attendancePolicies.outletId),
            eq(attendancePolicies.outletId, outletId),
          ),
        ),
      )
      .orderBy(asc(attendancePolicies.id));

    // QR seed: created on first use, like the cloud QR display. Only derived
    // day keys leave this function.
    await ensureQrSeed(tx, tenantId, outletId);
    const [secret] = await tx
      .select({ seed: attendanceQrSecrets.seed })
      .from(attendanceQrSecrets)
      .where(
        and(
          eq(attendanceQrSecrets.tenantId, tenantId),
          eq(attendanceQrSecrets.outletId, outletId),
        ),
      )
      .limit(1);

    return {
      employeeRows,
      shiftRows,
      userRows,
      assignmentRows,
      roleRows,
      policyRows,
      seed: secret?.seed ?? null,
    };
  });

  const qrKeys = parts.seed
    ? deriveQrDayKeys(
        parts.seed,
        verified.tenantId,
        outletId,
        qrFrom,
        qrCount,
      ).map(({ dayIndex, key }) => ({ dayIndex, key: key.toString("base64") }))
    : [];

  const iso = (value: Date) => value.toISOString();
  const candidate = {
    users: parts.userRows.map((row) => ({
      id: row.id,
      name: row.name,
      // A temporary ban that has run out no longer blocks (the cloud row keeps
      // `banned` until the next cloud sign-in clears it).
      banned:
        row.banned === true &&
        (row.banExpires === null || row.banExpires > now),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      email: `${row.id}@${EDGE_PEOPLE_SNAPSHOT_EMAIL_DOMAIN}`,
      emailVerified: false as const,
    })),
    roles: parts.roleRows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      isTemplate: row.isTemplate,
      templateKey: row.templateKey,
      permissions: rolePermissionsAsGranted(row.templateKey, row.permissions),
      mfaRequired: row.mfaRequired,
      allowedScopeTypes: row.allowedScopeTypes,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    })),
    roleAssignments: parts.assignmentRows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      roleId: row.roleId,
      scope:
        row.scopeType === "tenant"
          ? { type: "tenant" as const, id: null }
          : { type: row.scopeType, id: row.scopeId },
      validFrom: iso(row.validFrom),
      validUntil: row.validUntil ? iso(row.validUntil) : null,
      // The assigning admin is not shipped: the assignee stands in (3.2).
      assignedBy: row.userId,
      assignedAt: iso(row.assignedAt),
    })),
    employees: parts.employeeRows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      employeeNo: row.employeeNo,
      fullName: row.fullName,
      // On the edge every employee is homed at the node's outlet (3.2).
      homeOutletId: outletId,
      employmentType: row.employmentType,
      joinDate: row.joinDate,
      endDate: row.endDate,
      status: row.status,
    })),
    shiftAssignments: parts.shiftRows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      outletId: row.outletId,
      employeeId: row.employeeId,
      shiftTemplateId: null,
      stationId: null,
      businessDate: row.businessDate,
      segments: row.segments,
      breakMinutes: row.breakMinutes,
      status: row.status,
      source: row.source,
      publishedAt: row.publishedAt ? iso(row.publishedAt) : null,
      createdBy: row.createdBy,
    })),
    attendancePolicies: parts.policyRows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      outletId: row.outletId,
      policy: row.policy,
      sampling: row.sampling,
      updatedBy: row.updatedBy,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    })),
    qrKeys,
    selfieSealKey: loadSelfieSealPublicKey(env),
  };

  // The strict contract is the last line of defense against an extra column.
  // A row the contract refuses must not fail silently (a 422 nobody logs):
  // log the issue paths and codes only, never a value, and answer 500.
  const result = edgePeopleSnapshotCloudSchema.safeParse(candidate);
  if (!result.success) {
    logger.error(
      {
        issues: result.error.issues
          .slice(0, 20)
          .map((issue) => ({ path: issue.path.join("."), code: issue.code })),
      },
      "edge people snapshot refused by its own contract",
    );
    throw new Error("Edge people snapshot failed contract validation.");
  }
  const parsed = result.data;
  const body: EdgePeopleSnapshot = {
    ...parsed,
    users: byId(parsed.users),
    roles: byId(parsed.roles),
    roleAssignments: byId(parsed.roleAssignments),
    employees: byId(parsed.employees),
    shiftAssignments: byId(parsed.shiftAssignments),
    attendancePolicies: byId(parsed.attendancePolicies),
    qrKeys: [...parsed.qrKeys].sort((a, b) => a.dayIndex - b.dayIndex),
  };
  return {
    body,
    etag: peopleSnapshotEtag(body),
    generatedAt: now.toISOString(),
  };
}
