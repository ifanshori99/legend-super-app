// HRIS edge replication contracts (design docs/design/hris-edge-replication.md
// sections 3.2, 5, 6.1, 6.2). Pure schema tests: no database.
// - people-snapshot: whitelist, never password / real email / *_encrypted.
// - selfie seal: LSS1 header + meta, PUT contract, sealed size cap.
// - attendance: `outlet_device`, new stored flag reasons, and the
//   `attendance.logged` v2 payload that still accepts the v1 shape.
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  attendanceLogged,
  attendanceMethodSchema,
  attendanceStoredFlagReasonSchema,
} from "@starter/shared/hris";
import {
  EDGE_PEOPLE_SNAPSHOT_EMPLOYEE_KEYS,
  EDGE_PEOPLE_SNAPSHOT_ETAG_HEADER,
  EDGE_PEOPLE_SNAPSHOT_GENERATED_AT_HEADER,
  EDGE_PEOPLE_SNAPSHOT_IF_NONE_MATCH_HEADER,
  EDGE_PEOPLE_SNAPSHOT_PATH,
  EDGE_PEOPLE_SNAPSHOT_ROLE_ASSIGNMENT_KEYS,
  EDGE_PEOPLE_SNAPSHOT_ROLE_KEYS,
  EDGE_PEOPLE_SNAPSHOT_SHIFT_ASSIGNMENT_KEYS,
  EDGE_PEOPLE_SNAPSHOT_USER_KEYS,
  edgePeopleSnapshotCloudSchema,
  edgePeopleSnapshotSchema,
  hasUnsafePeopleSnapshotFields,
} from "@starter/shared/edge/people-snapshot";
import {
  EDGE_SELFIE_ALG,
  EDGE_SELFIE_ERROR_CODES,
  EDGE_SELFIE_SEALED_MAX_BYTES,
  EDGE_SELFIE_UPLOAD_STATES,
  LSS1_MAGIC,
  SEALED_SHA256_HEADER,
  edgeSelfieAttendanceSelfiePath,
  edgeSelfiePutStatusSchema,
  edgeSelfieUploadStateSchema,
  lss1HeaderSchema,
  lss1MetaSchema,
} from "@starter/shared/edge";

const iso = "2026-11-10T08:00:00.000Z";

function snapshot() {
  const userId = randomUUID();
  const tenantId = randomUUID();
  const outletId = randomUUID();
  const roleId = randomUUID();
  const employeeId = randomUUID();
  return {
    users: [
      {
        id: userId,
        name: "Sari",
        banned: false,
        createdAt: iso,
        updatedAt: iso,
        email: `${userId}@edge.invalid`,
        emailVerified: false,
      },
    ],
    roles: [
      {
        id: roleId,
        tenantId,
        name: "Kasir",
        isTemplate: false,
        templateKey: null,
        permissions: [],
        mfaRequired: false,
        allowedScopeTypes: ["outlet"],
        createdAt: iso,
        updatedAt: iso,
      },
    ],
    roleAssignments: [
      {
        id: randomUUID(),
        tenantId,
        userId,
        roleId,
        scope: { type: "outlet", id: outletId },
        validFrom: iso,
        validUntil: null,
        assignedBy: userId,
        assignedAt: iso,
      },
    ],
    employees: [
      {
        id: employeeId,
        tenantId,
        userId,
        employeeNo: "EMP-001",
        fullName: "Sari",
        homeOutletId: outletId,
        employmentType: "pkwtt",
        joinDate: "2026-01-01",
        endDate: null,
        status: "active",
      },
    ],
    shiftAssignments: [
      {
        id: randomUUID(),
        tenantId,
        outletId,
        employeeId,
        shiftTemplateId: null,
        stationId: null,
        businessDate: "2026-11-10",
        segments: [
          {
            startsAt: "2026-11-10T01:00:00.000Z",
            endsAt: "2026-11-10T09:00:00.000Z",
          },
        ],
        breakMinutes: 30,
        status: "published",
        source: "user",
        publishedAt: iso,
        createdBy: userId,
      },
    ],
    attendancePolicies: [
      {
        id: randomUUID(),
        tenantId,
        outletId: null,
        policy: {
          geofenceRadiusM: 100,
          outsideGeofenceAction: "flag",
          unboundDeviceAction: "flag",
          requireSelfie: true,
          requireDeviceBinding: false,
          allowRotatingQr: true,
          selfieRetentionDays: 30,
        },
        sampling: {
          rate: 0.1,
          flaggedAlways: true,
          minPerSupervisorPerWeek: 2,
        },
        updatedBy: userId,
        createdAt: iso,
        updatedAt: iso,
      },
    ],
    qrKeys: [{ dayIndex: 20_000, key: randomBytes(32).toString("base64") }],
    selfieSealKey: {
      kid: "k1",
      publicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----\n",
    },
  };
}

describe("edge people snapshot contract", () => {
  it("strips future envelope and QR fields while the cloud detects disclosure", () => {
    const data = snapshot();
    const future = {
      ...data,
      future: true,
      qrKeys: [{ ...data.qrKeys[0]!, future: true }],
    };
    expect(edgePeopleSnapshotSchema.parse(future)).toEqual(data);
    expect(edgePeopleSnapshotCloudSchema.safeParse(future).success).toBe(false);
  });
  it("parses a full whitelisted snapshot", () => {
    expect(edgePeopleSnapshotSchema.safeParse(snapshot()).success).toBe(true);
  });

  it("accepts a snapshot with no selfie seal key yet", () => {
    expect(
      edgePeopleSnapshotSchema.safeParse({ ...snapshot(), selfieSealKey: null })
        .success,
    ).toBe(true);
  });

  it("names the conditional request headers and the path", () => {
    expect(EDGE_PEOPLE_SNAPSHOT_PATH).toBe("/api/edge-sync/people-snapshot");
    expect(EDGE_PEOPLE_SNAPSHOT_ETAG_HEADER).toBe("ETag");
    expect(EDGE_PEOPLE_SNAPSHOT_IF_NONE_MATCH_HEADER).toBe("If-None-Match");
    expect(EDGE_PEOPLE_SNAPSHOT_GENERATED_AT_HEADER).toBe(
      "X-Legend-Snapshot-Generated-At",
    );
  });

  it("lists exactly the design 3.2 whitelist columns", () => {
    expect([...EDGE_PEOPLE_SNAPSHOT_USER_KEYS].sort()).toEqual(
      [
        "id",
        "name",
        "banned",
        "createdAt",
        "updatedAt",
        "email",
        "emailVerified",
      ].sort(),
    );
    expect([...EDGE_PEOPLE_SNAPSHOT_EMPLOYEE_KEYS].sort()).toEqual(
      [
        "id",
        "tenantId",
        "userId",
        "employeeNo",
        "fullName",
        "homeOutletId",
        "employmentType",
        "joinDate",
        "endDate",
        "status",
      ].sort(),
    );
    expect([...EDGE_PEOPLE_SNAPSHOT_SHIFT_ASSIGNMENT_KEYS].sort()).toEqual(
      [
        "id",
        "tenantId",
        "outletId",
        "employeeId",
        "shiftTemplateId",
        "stationId",
        "businessDate",
        "segments",
        "breakMinutes",
        "status",
        "source",
        "publishedAt",
        "createdBy",
      ].sort(),
    );
    expect([...EDGE_PEOPLE_SNAPSHOT_ROLE_KEYS].sort()).toEqual(
      [
        "id",
        "tenantId",
        "name",
        "isTemplate",
        "templateKey",
        "permissions",
        "mfaRequired",
        "allowedScopeTypes",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    expect([...EDGE_PEOPLE_SNAPSHOT_ROLE_ASSIGNMENT_KEYS].sort()).toEqual(
      [
        "id",
        "tenantId",
        "userId",
        "roleId",
        "scope",
        "validFrom",
        "validUntil",
        "assignedBy",
        "assignedAt",
      ].sort(),
    );
  });

  it("rejects credential fields even inside future sections", () => {
    for (const field of [
      "token",
      "passwordHash",
      "clientSecret",
      "credential",
      "seed",
      "privateKeyPem",
      "APIKEY",
      "PinCode",
      "userPin",
      "staffPin",
      "encrypted_pin",
      "encrypted_pin_hash",
      "staffPinEncrypted",
      "pincode",
      "pinhash",
      "staffpin",
      "PINHASH",
      "auth",
      "bearer",
      "session",
      "otp",
      "authorization",
      "accessKey",
      "clientKey",
      "passcode",
    ]) {
      const bad = { ...snapshot(), future: { [field]: "sensitive" } };
      expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
      const data = snapshot();
      const badQr = {
        ...data,
        qrKeys: [{ ...data.qrKeys[0]!, [field]: "sensitive" }],
      };
      expect(edgePeopleSnapshotSchema.safeParse(badQr).success).toBe(false);
    }
    const data = snapshot();
    expect(
      edgePeopleSnapshotSchema.safeParse({ ...data, mapping: 1, shipping: 2 })
        .success,
    ).toBe(true);
  });

  it("allows depth eight and rejects depth nine", () => {
    let within: unknown = "value";
    for (let index = 0; index < 7; index++) within = { nested: within };
    expect(
      edgePeopleSnapshotSchema.safeParse({ ...snapshot(), future: within })
        .success,
    ).toBe(true);
    expect(
      edgePeopleSnapshotSchema.safeParse({
        ...snapshot(),
        future: { nested: within },
      }).success,
    ).toBe(false);
  });

  it("fails closed at the inspection node limit", () => {
    expect(hasUnsafePeopleSnapshotFields({ future: [1] }, 3)).toBe(false);
    expect(hasUnsafePeopleSnapshotFields({ future: [1] }, 2)).toBe(true);
  });

  it("rejects unknown fields in sensitive records", () => {
    const data = snapshot();
    for (const section of [
      "users",
      "employees",
      "roles",
      "shiftAssignments",
      "attendancePolicies",
    ] as const) {
      const bad = {
        ...data,
        [section]: [{ ...data[section][0]!, future: true }],
      };
      expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects a password on a user", () => {
    const data = snapshot();
    const bad = { ...data, users: [{ ...data.users[0]!, password: "x" }] };
    expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a real email on a user", () => {
    const data = snapshot();
    const bad = {
      ...data,
      users: [{ ...data.users[0]!, email: "sari@example.com" }],
    };
    expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a placeholder email built from another user id", () => {
    const data = snapshot();
    const bad = {
      ...data,
      users: [{ ...data.users[0]!, email: `${randomUUID()}@edge.invalid` }],
    };
    expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a verified email on a user", () => {
    const data = snapshot();
    const bad = {
      ...data,
      users: [{ ...data.users[0]!, emailVerified: true }],
    };
    expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects encrypted or non-whitelisted employee columns", () => {
    const data = snapshot();
    for (const extra of [
      { nik_encrypted: "abc" },
      { ptkpStatus: "TK/0" },
      { positionId: randomUUID() },
      { managerId: randomUUID() },
    ]) {
      const bad = { ...data, employees: [{ ...data.employees[0]!, ...extra }] };
      expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects an employee without a user", () => {
    const data = snapshot();
    const bad = {
      ...data,
      employees: [{ ...data.employees[0]!, userId: null }],
    };
    expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a role assignment whose assignedBy is not the assignee", () => {
    const data = snapshot();
    const bad = {
      ...data,
      roleAssignments: [
        { ...data.roleAssignments[0]!, assignedBy: randomUUID() },
      ],
    };
    expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a station-scoped role assignment (design 3.5 sends tenant, brand of O, O only)", () => {
    const data = snapshot();
    const bad = {
      ...data,
      roleAssignments: [
        {
          ...data.roleAssignments[0]!,
          scope: { type: "station", id: randomUUID() },
        },
      ],
    };
    expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
    for (const scope of [
      { type: "tenant", id: null },
      { type: "brand", id: randomUUID() },
      { type: "outlet", id: randomUUID() },
    ])
      expect(
        edgePeopleSnapshotSchema.safeParse({
          ...data,
          roleAssignments: [{ ...data.roleAssignments[0]!, scope }],
        }).success,
      ).toBe(true);
  });

  it("sends only onboarding or active employees", () => {
    const data = snapshot();
    for (const [status, ok] of [
      ["onboarding", true],
      ["active", true],
      ["suspended", false],
      ["terminated", false],
    ] as const)
      expect(
        edgePeopleSnapshotSchema.safeParse({
          ...data,
          employees: [{ ...data.employees[0]!, status }],
        }).success,
        status,
      ).toBe(ok);
  });

  it("sends only published or swapped shifts", () => {
    const data = snapshot();
    for (const [status, ok] of [
      ["published", true],
      ["swapped", true],
      ["draft", false],
      ["cancelled", false],
    ] as const)
      expect(
        edgePeopleSnapshotSchema.safeParse({
          ...data,
          shiftAssignments: [{ ...data.shiftAssignments[0]!, status }],
        }).success,
        status,
      ).toBe(ok);
  });

  it("rejects a shift that carries a template or station", () => {
    const data = snapshot();
    for (const extra of [
      { shiftTemplateId: randomUUID() },
      { stationId: randomUUID() },
    ]) {
      const bad = {
        ...data,
        shiftAssignments: [{ ...data.shiftAssignments[0]!, ...extra }],
      };
      expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("strips an unknown top-level section", () => {
    expect(
      edgePeopleSnapshotSchema.parse({ ...snapshot(), accounts: [] }),
    ).not.toHaveProperty("accounts");
  });

  it("requires a QR day key of exactly 32 bytes", () => {
    const data = snapshot();
    for (const bytes of [16, 31, 33, 64]) {
      const bad = {
        ...data,
        qrKeys: [
          { dayIndex: 20_000, key: randomBytes(bytes).toString("base64") },
        ],
      };
      expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
    }
    expect(
      edgePeopleSnapshotSchema.safeParse({
        ...data,
        qrKeys: [{ dayIndex: 20_000, key: "not base64!" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a QR key seed", () => {
    const data = snapshot();
    const bad = {
      ...data,
      qrKeys: [{ ...data.qrKeys[0]!, seed: "x" }],
    };
    expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a seal key private key", () => {
    const data = snapshot();
    const bad = {
      ...data,
      selfieSealKey: { ...data.selfieSealKey, privateKeyPem: "x" },
    };
    expect(edgePeopleSnapshotSchema.safeParse(bad).success).toBe(false);
  });
});

describe("selfie seal contract (LSS1)", () => {
  const header = {
    v: 1,
    kid: "k1",
    alg: "RSA-OAEP-256+A256GCM",
    tenantId: randomUUID(),
    objectId: randomUUID(),
  };
  const meta = {
    outletId: randomUUID(),
    ownerUserId: randomUUID(),
    contentType: "image/webp",
    width: 640,
    height: 480,
    plainSha256: "a".repeat(64),
    createdAt: iso,
  };

  it("exposes the fixed constants", () => {
    expect(LSS1_MAGIC).toBe("LSS1");
    expect(SEALED_SHA256_HEADER).toBe("X-Legend-Sealed-Sha256");
    expect(EDGE_SELFIE_SEALED_MAX_BYTES).toBe(6 * 1024 * 1024);
    expect(EDGE_SELFIE_ALG).toBe("RSA-OAEP-256+A256GCM");
  });

  it("parses a valid header and meta", () => {
    expect(lss1HeaderSchema.safeParse(header).success).toBe(true);
    expect(lss1MetaSchema.safeParse(meta).success).toBe(true);
  });

  it("rejects a header with another version, algorithm, or extra key", () => {
    expect(lss1HeaderSchema.safeParse({ ...header, v: 2 }).success).toBe(false);
    expect(
      lss1HeaderSchema.safeParse({ ...header, alg: "RSA-OAEP" }).success,
    ).toBe(false);
    expect(
      lss1HeaderSchema.safeParse({ ...header, outletId: randomUUID() }).success,
    ).toBe(false);
    expect(
      lss1HeaderSchema.safeParse({ ...header, objectId: "nope" }).success,
    ).toBe(false);
  });

  it("rejects meta with another content type, a bad hash, or an extra key", () => {
    expect(
      lss1MetaSchema.safeParse({ ...meta, contentType: "image/jpeg" }).success,
    ).toBe(false);
    expect(
      lss1MetaSchema.safeParse({ ...meta, plainSha256: "A".repeat(64) })
        .success,
    ).toBe(false);
    expect(
      lss1MetaSchema.safeParse({ ...meta, plainSha256: "a".repeat(63) })
        .success,
    ).toBe(false);
    expect(lss1MetaSchema.safeParse({ ...meta, email: "x@y.z" }).success).toBe(
      false,
    );
  });

  it("builds the PUT path from the object id", () => {
    const objectId = randomUUID();
    expect(edgeSelfieAttendanceSelfiePath(objectId)).toBe(
      `/api/edge-sync/attendance-selfies/${objectId}`,
    );
  });

  it("allows only the documented PUT response codes", () => {
    for (const status of [201, 200, 409, 403, 413, 422, 400, 503])
      expect(edgeSelfiePutStatusSchema.safeParse(status).success).toBe(true);
    for (const status of [204, 404, 500, 507])
      expect(edgeSelfiePutStatusSchema.safeParse(status).success).toBe(false);
  });

  it("names the error codes with their statuses", () => {
    expect(EDGE_SELFIE_ERROR_CODES.OBJECT_ID_TAKEN).toBe("OBJECT_ID_TAKEN");
    expect(EDGE_SELFIE_ERROR_CODES.SELFIE_SEAL_KEY_MISSING).toBe(
      "SELFIE_SEAL_KEY_MISSING",
    );
    expect(EDGE_SELFIE_ERROR_CODES.EDGE_SELFIE_STORAGE_FULL).toBe(
      "EDGE_SELFIE_STORAGE_FULL",
    );
    expect(EDGE_SELFIE_ERROR_CODES.ATTENDANCE_METHOD_NOT_ON_EDGE).toBe(
      "ATTENDANCE_METHOD_NOT_ON_EDGE",
    );
  });

  it("limits the edge upload state to four values", () => {
    expect([...EDGE_SELFIE_UPLOAD_STATES]).toEqual([
      "pending",
      "uploaded",
      "rejected",
      "expired",
    ]);
    expect(edgeSelfieUploadStateSchema.safeParse("sent").success).toBe(false);
  });
});

describe("attendance contract extensions", () => {
  it("accepts method outlet_device", () => {
    expect(attendanceMethodSchema.safeParse("outlet_device").success).toBe(
      true,
    );
  });

  it("accepts the new stored flag reasons", () => {
    for (const reason of [
      "edge_roster_stale",
      "employee_inactive",
      "selfie_unlinked",
      "offline_unverified",
    ])
      expect(attendanceStoredFlagReasonSchema.safeParse(reason).success).toBe(
        true,
      );
  });

  const v1 = () => ({
    attendanceLogId: "01JABCDEFGHJKMNPQRSTVWXYZ0",
    employeeId: randomUUID(),
    outletId: randomUUID(),
    type: "in",
    method: "rotating_qr",
    occurredAt: iso,
    validity: "valid",
    shiftAssignmentId: null,
  });

  it("still parses the old attendance.logged payload", () => {
    expect(attendanceLogged.payloadSchema.safeParse(v1()).success).toBe(true);
  });

  it("parses the v2 attendance.logged payload", () => {
    const result = attendanceLogged.payloadSchema.safeParse({
      ...v1(),
      method: "outlet_device",
      selfieObjectId: randomUUID(),
      edgeFlagReasons: ["edge_roster_stale", "selfie_unlinked"],
      edgeDeviceId: "edge-device-1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts null selfieObjectId and edgeDeviceId", () => {
    const result = attendanceLogged.payloadSchema.safeParse({
      ...v1(),
      selfieObjectId: null,
      edgeDeviceId: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown edge flag reason or an unknown field", () => {
    expect(
      attendanceLogged.payloadSchema.safeParse({
        ...v1(),
        edgeFlagReasons: ["made_up"],
      }).success,
    ).toBe(false);
    expect(
      attendanceLogged.payloadSchema.safeParse({ ...v1(), photoUrl: "x" })
        .success,
    ).toBe(false);
  });
});
