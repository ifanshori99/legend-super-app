// HRIS training, quizzes and certificates (PRD v1.7 §3 F32; bead legend-7df1)
// against PostgreSQL with the restricted app role (RLS enforced). Services are
// called with server-minted contexts; actors are real users holding real role
// assignments, so every decision goes through the RBAC resolver. A short HTTP
// section runs the real Express app for the route gates.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeCursor, outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  completeTraining as completeTrainingEndpoint,
  createTrainingInputSchema,
  enrollTrainingInputSchema,
  type Training,
} from "@starter/shared/hris";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import {
  trainingCertificates,
  trainingCompletions,
  trainingQuestions,
  trainings,
} from "../db/schema/hris-training.ts";
import { withTenant } from "../db/tenant.ts";
import {
  addMonths,
  completeTraining,
  createTraining,
  enrollTraining,
  listTrainingCertificates,
  listTrainingEnrollments,
  listTrainings,
} from "../services/hris-training.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const otherTenant = randomUUID();
const TITLE = "HRIS-T";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdStations: string[] = [];

const base = (tenant: string = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = (tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), { kind: "tenant" });
const outletScope = (outletId: string) =>
  establishScopedTenantContext(base(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant,
        `Training test ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenant,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
}

/** A user holding a custom role with exactly `permissions` at `scope`. */
async function actor(
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Training test', $2)`,
    [userId, `${userId}@example.test`],
  );
  await grantRole(userId, permissions, scope, tenant);
  return userId;
}

async function seedEmployee(userId: string | null, outletId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenantId,
        userId,
        `TR-${id.slice(0, 8).toUpperCase()}`,
        `Peserta ${id.slice(0, 4)}`,
        outletId,
      ],
    ),
  );
  return id;
}

async function seedStation(outletId: string) {
  const { rows } = await asOwner(tenantId, (client) =>
    client.query<{ id: string }>(
      `INSERT INTO stations (tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'hot_kitchen') RETURNING id`,
      [tenantId, outletId, `Stasiun ${randomUUID().slice(0, 8)}`],
    ),
  );
  const id = rows[0]!.id;
  createdStations.push(id);
  return id;
}

const codeOf = (error: unknown) => (error as { code?: string }).code;
const statusOf = (error: unknown) => (error as { status?: number }).status;
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return { code: codeOf(error), status: statusOf(error) };
  }
  throw new Error("Expected the call to fail");
}

type TrainingOverrides = {
  title?: string;
  stationId?: string | null;
  passingScore?: number;
  validityMonths?: number;
};
/** Two questions worth 30 and 70 points; correct options 0 and 1. */
function trainingInput(overrides: TrainingOverrides = {}) {
  return createTrainingInputSchema.parse({
    title: `${TITLE} ${overrides.title ?? randomUUID().slice(0, 8)}`,
    description: "Pelatihan uji",
    stationId: overrides.stationId ?? null,
    positionId: null,
    passingScore: overrides.passingScore ?? 70,
    validityMonths: overrides.validityMonths ?? 12,
    scheduledStart: null,
    scheduledEnd: null,
    questions: [
      {
        prompt: "Soal satu",
        options: ["Benar", "Salah"],
        points: 30,
        correctOptionIndex: 0,
      },
      {
        prompt: "Soal dua",
        options: ["Salah", "Benar", "Salah juga"],
        points: 70,
        correctOptionIndex: 1,
      },
    ],
  });
}

async function makeTraining(overrides: TrainingOverrides = {}) {
  return createTraining(tenantScope(), mgr, trainingInput(overrides));
}

const key = () => `train-${randomUUID()}`;
/** `picks`: option index per question position; undefined = unanswered. */
function answers(training: Training, picks: (number | undefined)[]) {
  return completeTrainingEndpoint.body.parse({
    answers: training.questions.flatMap((question, index) =>
      picks[index] === undefined
        ? []
        : [{ questionId: question.id, optionIndex: picks[index] }],
    ),
    idempotencyKey: key(),
  });
}

// Actors.
let mgr: string; // hr.training.manage, tenant-wide
let mgrA: string; // hr.training.manage, outlet A
let staffA: string;
let staffA2: string;
let staffB: string;
let staffX: string;
let stranger: string;
let hrOther: string;
let eA: string;
let eA2: string;
let eB: string;
let eX: string;
let stationA: string;
let stationB: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Training RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `training-rls-${otherTenant.slice(0, 8)}`, tenantId],
  );
  mgr = await actor(["hr.training.manage"], { type: "tenant" });
  mgrA = await actor(["hr.training.manage"], { type: "outlet", id: outletA });
  const self = { type: "outlet", id: outletA } as const;
  staffA = await actor(["self.sop.read"], self);
  staffA2 = await actor(["self.sop.read"], self);
  staffX = await actor(["self.sop.read"], self);
  staffB = await actor(["self.sop.read"], { type: "outlet", id: outletB });
  stranger = await actor(["menu.item.view"], { type: "tenant" });
  hrOther = await actor(
    ["hr.training.manage"],
    { type: "tenant" },
    otherTenant,
  );
  eA = await seedEmployee(staffA, outletA);
  eA2 = await seedEmployee(staffA2, outletA);
  eX = await seedEmployee(staffX, outletA);
  eB = await seedEmployee(staffB, outletB);
  stationA = await seedStation(outletA);
  stationB = await seedStation(outletB);
});

afterAll(async () => {
  await asOwner(tenantId, async (client) => {
    const own = `tenant_id = $1 AND training_id IN (SELECT id FROM trainings WHERE tenant_id = $1 AND title LIKE '${TITLE}%')`;
    for (const table of [
      "training_certificates",
      "training_completions",
      "training_enrollments",
      "training_questions",
    ])
      await client.query(`DELETE FROM ${table} WHERE ${own}`, [tenantId]);
    await client.query(
      `DELETE FROM trainings WHERE tenant_id = $1 AND title LIKE '${TITLE}%'`,
      [tenantId],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdEmployees],
    );
    await client.query(
      "DELETE FROM stations WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdStations],
    );
  });
  for (const tenant of [tenantId, otherTenant])
    await asOwner(tenant, async (client) => {
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenant, createdUsers],
      );
      await client.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant, createdRoles],
      );
    });
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("createTraining", () => {
  it("never returns or stores-in-response the answer key", async () => {
    const created = await makeTraining();
    expect(created.questions).toHaveLength(2);
    const raw = JSON.stringify(created);
    expect(raw).not.toContain("correctOptionIndex");
    expect(raw).not.toContain("correct_option_index");
    const { rows } = await asOwner(tenantId, (client) =>
      client.query(
        `SELECT correct_option_index FROM training_questions
          WHERE tenant_id = $1 AND training_id = $2 ORDER BY sort_order`,
        [tenantId, created.id],
      ),
    );
    expect(rows.map((row) => row.correct_option_index)).toEqual([0, 1]);
    const listed = await listTrainings(tenantScope(), mgr, { limit: 100 });
    expect(JSON.stringify(listed)).not.toContain("orrectOptionIndex");
    expect(listed.data.some((row) => row.id === created.id)).toBe(true);
  });

  it("[TEN-03] enforces station and tenant reach on write", async () => {
    // Outlet-A manager aimed at an outlet-B station (service called with a
    // wider context, so RLS does not hide the station): 403.
    const outside = await failure(
      createTraining(
        tenantScope(),
        mgrA,
        trainingInput({ stationId: stationB }),
      ),
    );
    expect(outside).toEqual({ code: "OUTLET_OUT_OF_SCOPE", status: 403 });
    // Without a station the training is tenant-wide: needs tenant reach.
    expect(
      (await failure(createTraining(tenantScope(), mgrA, trainingInput())))
        .code,
    ).toBe("OUTLET_OUT_OF_SCOPE");
    // An outlet-scoped context cannot even see the foreign station: 404.
    expect(
      (
        await failure(
          createTraining(
            outletScope(outletA),
            mgrA,
            trainingInput({ stationId: stationB }),
          ),
        )
      ).status,
    ).toBe(404);
    const own = await createTraining(
      outletScope(outletA),
      mgrA,
      trainingInput({ stationId: stationA }),
    );
    expect(own.stationId).toBe(stationA);
  });

  it("refuses an account without hr.training.manage", async () => {
    expect(
      (await failure(createTraining(tenantScope(), stranger, trainingInput())))
        .status,
    ).toBe(403);
    expect(
      (await failure(createTraining(tenantScope(), staffA, trainingInput())))
        .status,
    ).toBe(403);
  });
});

describe("completeTraining", () => {
  it("grades by weight and returns only the passed flag and total score", async () => {
    const training = await makeTraining({ passingScore: 70 });
    const light = await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      answers(training, [0, 0]), // only q1 right = 30
    );
    expect(light).toMatchObject({ score: 30, passed: false, attempts: 1 });
    expect(Object.keys(light).sort()).toEqual(
      [
        "attempts",
        "completedAt",
        "employeeId",
        "expiresOn",
        "id",
        "passed",
        "score",
        "tenantId",
        "trainingId",
      ].sort(),
    );
    const allWrong = await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      answers(training, [1, 0]),
    );
    expect(allWrong).toMatchObject({ score: 0, passed: false, attempts: 2 });
    expect(allWrong.expiresOn).toBeNull();
    const heavyOnly = await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      answers(training, [1, 1]), // q1 wrong, q2 right = 70
    );
    expect(heavyOnly).toMatchObject({ score: 70, passed: true, attempts: 3 });
  });

  it("requires an answer for every question and does not use up an attempt", async () => {
    const training = await makeTraining();
    const failed = await failure(
      completeTraining(
        outletScope(outletA),
        staffA,
        training.id,
        answers(training, [0, undefined]),
      ),
    );
    expect(failed).toMatchObject({
      status: 422,
      code: "TRAINING_ANSWERS_INCOMPLETE",
    });
    const next = await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      answers(training, [1, 0]),
    );
    expect(next.attempts).toBe(1);
  });

  it("allows 5 attempts per 24 hours, then 429, and again after the window", async () => {
    const training = await makeTraining();
    const now = new Date("2026-05-01T03:00:00.000Z");
    for (let attempt = 1; attempt <= 5; attempt += 1)
      await completeTraining(
        outletScope(outletA),
        staffA,
        training.id,
        answers(training, [1, 0]),
        now,
      );
    const blocked = await failure(
      completeTraining(
        outletScope(outletA),
        staffA,
        training.id,
        answers(training, [0, 1]),
        new Date(now.getTime() + 3_600_000),
      ),
    );
    expect(blocked).toMatchObject({
      status: 429,
      code: "TRAINING_ATTEMPTS_RATE_LIMITED",
    });
    // Another employee is not affected.
    const other = await completeTraining(
      outletScope(outletA),
      staffA2,
      training.id,
      answers(training, [1, 0]),
      new Date(now.getTime() + 3_600_000),
    );
    expect(other.attempts).toBe(1);
    const later = await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      answers(training, [0, 1]),
      new Date(now.getTime() + 25 * 3_600_000),
    );
    expect(later).toMatchObject({ passed: true, attempts: 6 });
  });

  it("refuses a new attempt while the certificate is valid, except in its last 30 days", async () => {
    const training = await makeTraining({ validityMonths: 12 });
    const now = new Date("2026-03-01T03:00:00.000Z");
    const first = await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      answers(training, [0, 1]),
      now,
    );
    expect(first.expiresOn).toBe("2027-03-01");
    const blocked = await failure(
      completeTraining(
        outletScope(outletA),
        staffA,
        training.id,
        answers(training, [0, 1]),
        new Date("2026-09-01T03:00:00.000Z"),
      ),
    );
    expect(blocked).toMatchObject({
      status: 409,
      code: "TRAINING_CERTIFICATE_ACTIVE",
    });
    // 2027-01-30 is 30 days before 2027-03-01 (Jakarta): renewal is open.
    const renewal = await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      answers(training, [0, 1]),
      new Date("2027-01-30T03:00:00.000Z"),
    );
    expect(renewal).toMatchObject({ passed: true, attempts: 2 });
    // A certificate without an expiry never opens renewal.
    const never = await makeTraining({ validityMonths: 0 });
    await completeTraining(
      outletScope(outletA),
      staffA,
      never.id,
      answers(never, [0, 1]),
    );
    const again = await failure(
      completeTraining(
        outletScope(outletA),
        staffA,
        never.id,
        answers(never, [0, 1]),
        new Date("2040-01-01T03:00:00.000Z"),
      ),
    );
    expect(again.code).toBe("TRAINING_CERTIFICATE_ACTIVE");
  });

  it("only takes attempts inside the scheduled window", async () => {
    const training = await createTraining(
      tenantScope(),
      mgr,
      createTrainingInputSchema.parse({
        ...trainingInput(),
        scheduledStart: "2026-06-01T01:00:00.000Z",
        scheduledEnd: "2026-06-01T05:00:00.000Z",
      }),
    );
    for (const outside of [
      "2026-06-01T00:59:00.000Z",
      "2026-06-01T05:01:00.000Z",
    ])
      expect(
        await failure(
          completeTraining(
            outletScope(outletA),
            staffA,
            training.id,
            answers(training, [0, 1]),
            new Date(outside),
          ),
        ),
      ).toMatchObject({ status: 409, code: "TRAINING_OUTSIDE_SCHEDULE" });
    const inside = await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      answers(training, [0, 1]),
      new Date("2026-06-01T03:00:00.000Z"),
    );
    expect(inside.passed).toBe(true);
  });

  it("issues a certificate only on a pass, with the expiry from the Jakarta date", async () => {
    const training = await makeTraining({ validityMonths: 12 });
    // 2026-03-30T18:00Z is already 31 March 01:00 in Jakarta.
    const now = new Date("2026-03-30T18:00:00.000Z");
    const failed = await completeTraining(
      outletScope(outletA),
      staffA2,
      training.id,
      answers(training, [1, 0]),
      now,
    );
    const passed = await completeTraining(
      outletScope(outletA),
      staffA2,
      training.id,
      answers(training, [0, 1]),
      now,
    );
    expect(failed.passed).toBe(false);
    expect(passed).toMatchObject({
      passed: true,
      score: 100,
      expiresOn: "2027-03-31",
      completedAt: now.toISOString(),
    });
    const { rows } = await asOwner(tenantId, (client) =>
      client.query(
        `SELECT completion_id, certificate_number, expires_on::text AS expires_on
           FROM training_certificates WHERE tenant_id = $1 AND training_id = $2`,
        [tenantId, training.id],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].completion_id).toBe(passed.id);
    expect(rows[0].certificate_number).toMatch(/^CERT-20260331-[A-Z2-7]{6}$/);
    expect(rows[0].expires_on).toBe("2027-03-31");
  });

  it("clamps the expiry to the end of a shorter month and leaves it null at 0 months", async () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    const never = await makeTraining({ validityMonths: 0 });
    const done = await completeTraining(
      outletScope(outletA),
      staffA,
      never.id,
      answers(never, [0, 1]),
    );
    expect(done).toMatchObject({ passed: true, expiresOn: null });
    const { rows } = await asOwner(tenantId, (client) =>
      client.query(
        "SELECT expires_on FROM training_certificates WHERE tenant_id = $1 AND training_id = $2",
        [tenantId, never.id],
      ),
    );
    expect(rows).toEqual([{ expires_on: null }]);
  });

  it("replays the same completion for the same idempotency key", async () => {
    const training = await makeTraining();
    const body = answers(training, [0, 1]);
    const first = await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      body,
    );
    const replay = await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      body,
    );
    expect(replay).toEqual(first);
    const { rows } = await asOwner(tenantId, (client) =>
      client.query(
        `SELECT (SELECT count(*) FROM training_completions WHERE tenant_id = $1 AND training_id = $2)::int AS completions,
                (SELECT count(*) FROM training_certificates WHERE tenant_id = $1 AND training_id = $2)::int AS certificates`,
        [tenantId, training.id],
      ),
    );
    expect(rows[0]).toEqual({ completions: 1, certificates: 1 });
    const other = await makeTraining();
    expect(
      (
        await failure(
          completeTraining(outletScope(outletA), staffA, other.id, body),
        )
      ).code,
    ).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects answers for unknown or repeated questions", async () => {
    const training = await makeTraining();
    const unknown = completeTrainingEndpoint.body.parse({
      answers: [{ questionId: randomUUID(), optionIndex: 0 }],
      idempotencyKey: key(),
    });
    expect(
      (
        await failure(
          completeTraining(outletScope(outletA), staffA, training.id, unknown),
        )
      ).status,
    ).toBe(422);
    const question = training.questions[0]!.id;
    const twice = completeTrainingEndpoint.body.parse({
      answers: [
        { questionId: question, optionIndex: 0 },
        { questionId: question, optionIndex: 1 },
      ],
      idempotencyKey: key(),
    });
    expect(
      (
        await failure(
          completeTraining(outletScope(outletA), staffA, training.id, twice),
        )
      ).code,
    ).toBe("TRAINING_ANSWER_INVALID");
  });

  it("stops at 100 attempts", async () => {
    const training = await makeTraining();
    await asOwner(tenantId, (client) =>
      client.query(
        `INSERT INTO training_completions
           (tenant_id, training_id, employee_id, attempt_number, score, passed, answers, completed_at, idempotency_key)
         SELECT $1, $2, $3, g, 0, false, '[]'::jsonb, now() - interval '3 days', 'seed-' || g
           FROM generate_series(1, 100) g`,
        [tenantId, training.id, eX],
      ),
    );
    expect(
      (
        await failure(
          completeTraining(
            outletScope(outletA),
            staffX,
            training.id,
            answers(training, [0, 1]),
          ),
        )
      ).code,
    ).toBe("TRAINING_ATTEMPTS_EXHAUSTED");
  });

  it("requires self.sop.read and an own employee row", async () => {
    const training = await makeTraining();
    expect(
      (
        await failure(
          completeTraining(
            tenantScope(),
            stranger,
            training.id,
            answers(training, [0, 1]),
          ),
        )
      ).status,
    ).toBe(403);
    // A manager with no employee row of their own.
    const manager = await actor(["self.sop.read"], { type: "tenant" });
    expect(
      (
        await failure(
          completeTraining(
            tenantScope(),
            manager,
            training.id,
            answers(training, [0, 1]),
          ),
        )
      ).status,
    ).toBe(404);
  });

  it("[TEN-03] hides a training of another outlet unless the employee is enrolled", async () => {
    const training = await makeTraining({ stationId: stationA });
    const body = answers(training, [0, 1]);
    expect(
      (
        await failure(
          completeTraining(outletScope(outletB), staffB, training.id, body),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await listTrainings(outletScope(outletB), staffB, { limit: 100 })
      ).data.map((row) => row.id),
    ).not.toContain(training.id);
    await enrollTraining(
      tenantScope(),
      mgr,
      training.id,
      enrollTrainingInputSchema.parse({ employeeIds: [eB], dueOn: null }),
    );
    expect(
      (
        await listTrainings(outletScope(outletB), staffB, { limit: 100 })
      ).data.map((row) => row.id),
    ).toContain(training.id);
    const done = await completeTraining(
      outletScope(outletB),
      staffB,
      training.id,
      body,
    );
    expect(done.passed).toBe(true);
  });
});

describe("listTrainings", () => {
  it("shows an employee their outlet's and unbound trainings, a manager only their reach", async () => {
    const unbound = await makeTraining();
    const inA = await makeTraining({ stationId: stationA });
    const inB = await makeTraining({ stationId: stationB });
    const ids = async (scope: ReturnType<typeof tenantScope>, who: string) =>
      (await listTrainings(scope, who, { limit: 100 })).data.map(
        (row) => row.id,
      );
    const staff = await ids(outletScope(outletA), staffA);
    expect(staff).toEqual(expect.arrayContaining([unbound.id, inA.id]));
    expect(staff).not.toContain(inB.id);
    const manager = await ids(outletScope(outletA), mgrA);
    expect(manager).toEqual(expect.arrayContaining([unbound.id, inA.id]));
    expect(manager).not.toContain(inB.id);
    const all = await ids(tenantScope(), mgr);
    expect(all).toEqual(expect.arrayContaining([unbound.id, inA.id, inB.id]));
  });

  it("pages with a cursor and refuses accounts without a code", async () => {
    await makeTraining();
    await makeTraining();
    const first = await listTrainings(tenantScope(), mgr, { limit: 1 });
    expect(first.data).toHaveLength(1);
    expect(first.meta.nextCursor).not.toBeNull();
    const second = await listTrainings(tenantScope(), mgr, {
      limit: 1,
      cursor: first.meta.nextCursor!,
    });
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
    expect(
      (await failure(listTrainings(tenantScope(), stranger, { limit: 10 })))
        .status,
    ).toBe(403);
  });

  it("answers 422, not 500, to a cursor whose id is not a UUID", async () => {
    const cursor = encodeCursor(["Judul", "not-a-uuid"]);
    expect(
      (await failure(listTrainings(tenantScope(), mgr, { limit: 1, cursor })))
        .status,
    ).toBe(422);
    expect(
      (
        await failure(
          listTrainingCertificates(tenantScope(), mgr, { limit: 1, cursor }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await failure(
          listTrainingEnrollments(
            tenantScope(),
            mgr,
            (await makeTraining()).id,
            { limit: 1, cursor },
          ),
        )
      ).status,
    ).toBe(422);
  });
});

describe("enrollment and certificates", () => {
  it("[TEN-03] one employee outside reach fails the whole enrolment", async () => {
    const training = await makeTraining({ stationId: stationA });
    const mixed = enrollTrainingInputSchema.parse({
      employeeIds: [eA, eB],
      dueOn: null,
    });
    expect(
      (await failure(enrollTraining(tenantScope(), mgrA, training.id, mixed)))
        .status,
    ).toBe(404);
    const none = await listTrainingEnrollments(
      outletScope(outletA),
      mgrA,
      training.id,
      {
        limit: 50,
      },
    );
    expect(none.data).toEqual([]);
    // Unknown employee id and unknown training answer 404 as well.
    expect(
      (
        await failure(
          enrollTraining(
            tenantScope(),
            mgr,
            training.id,
            enrollTrainingInputSchema.parse({
              employeeIds: [randomUUID()],
              dueOn: null,
            }),
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (await failure(enrollTraining(tenantScope(), mgr, randomUUID(), mixed)))
        .status,
    ).toBe(404);
    expect(
      (
        await failure(
          enrollTraining(
            tenantScope(),
            staffA,
            training.id,
            enrollTrainingInputSchema.parse({ employeeIds: [eA], dueOn: null }),
          ),
        )
      ).status,
    ).toBe(403);
  });

  it("enrols idempotently and reports progress per employee", async () => {
    const training = await makeTraining({ stationId: stationA });
    const first = await enrollTraining(
      outletScope(outletA),
      mgrA,
      training.id,
      enrollTrainingInputSchema.parse({
        employeeIds: [eA, eA2],
        dueOn: "2026-12-31",
      }),
    );
    expect(first).toHaveLength(2);
    const again = await enrollTraining(
      outletScope(outletA),
      mgrA,
      training.id,
      enrollTrainingInputSchema.parse({
        employeeIds: [eA],
        dueOn: "2027-06-30",
      }),
    );
    // A new due date moves the existing enrolment, same row.
    expect(again[0]).toMatchObject({
      id: first.find((row) => row.employeeId === eA)!.id,
      dueOn: "2027-06-30",
    });
    const kept = await enrollTraining(
      outletScope(outletA),
      mgrA,
      training.id,
      enrollTrainingInputSchema.parse({ employeeIds: [eA], dueOn: null }),
    );
    expect(kept[0]!.dueOn).toBe("2027-06-30");

    await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      answers(training, [0, 0]), // 30
    );
    const passed = await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      answers(training, [0, 1]),
    );
    const status = await listTrainingEnrollments(
      outletScope(outletA),
      mgrA,
      training.id,
      { limit: 50 },
    );
    const mine = status.data.find((row) => row.employeeId === eA)!;
    expect(mine).toMatchObject({
      attempts: 2,
      bestScore: 100,
      passed: true,
      certificateExpiresOn: passed.expiresOn,
    });
    expect(mine.certificateId).not.toBeNull();
    const idle = status.data.find((row) => row.employeeId === eA2)!;
    expect(idle).toMatchObject({
      attempts: 0,
      bestScore: null,
      passed: false,
      certificateId: null,
    });
    // Employees can not read the roster.
    expect(
      (
        await failure(
          listTrainingEnrollments(outletScope(outletA), staffA, training.id, {
            limit: 10,
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("only active or onboarding employees can be enrolled", async () => {
    const training = await makeTraining();
    const gone = await seedEmployee(null, outletA);
    await asOwner(tenantId, (client) =>
      client.query(
        "UPDATE employees SET status = 'resigned' WHERE tenant_id = $1 AND id = $2",
        [tenantId, gone],
      ),
    );
    expect(
      (
        await failure(
          enrollTraining(
            tenantScope(),
            mgr,
            training.id,
            enrollTrainingInputSchema.parse({
              employeeIds: [eA, gone],
              dueOn: null,
            }),
          ),
        )
      ).status,
    ).toBe(404);
    const onboarding = await seedEmployee(null, outletA);
    await asOwner(tenantId, (client) =>
      client.query(
        "UPDATE employees SET status = 'onboarding' WHERE tenant_id = $1 AND id = $2",
        [tenantId, onboarding],
      ),
    );
    const ok = await enrollTraining(
      tenantScope(),
      mgr,
      training.id,
      enrollTrainingInputSchema.parse({
        employeeIds: [onboarding],
        dueOn: null,
      }),
    );
    expect(ok).toHaveLength(1);
  });

  it("a resigned employee cannot take a quiz or see the self list", async () => {
    const training = await makeTraining();
    const userId = await actor(["self.sop.read"], {
      type: "outlet",
      id: outletA,
    });
    const resigned = await seedEmployee(userId, outletA);
    await asOwner(tenantId, (client) =>
      client.query(
        "UPDATE employees SET status = 'resigned' WHERE tenant_id = $1 AND id = $2",
        [tenantId, resigned],
      ),
    );
    expect(
      (
        await failure(
          completeTraining(
            outletScope(outletA),
            userId,
            training.id,
            answers(training, [0, 1]),
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await failure(
          listTrainings(outletScope(outletA), userId, { limit: 100 }),
        )
      ).status,
    ).toBe(404);
  });

  it("an employee lists only their own certificates; a manager lists by reach", async () => {
    const training = await makeTraining();
    await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      answers(training, [0, 1]),
    );
    await completeTraining(
      outletScope(outletA),
      staffA2,
      training.id,
      answers(training, [0, 1]),
    );
    const own = await listTrainingCertificates(outletScope(outletA), staffA, {
      limit: 100,
      trainingId: training.id,
    });
    expect(own.data).toHaveLength(1);
    expect(own.data[0]!.employeeId).toBe(eA);
    const foreign = await listTrainingCertificates(
      outletScope(outletA),
      staffA,
      { limit: 100, employeeId: eA2 as never, trainingId: training.id },
    );
    expect(foreign.data).toEqual([]);
    const all = await listTrainingCertificates(tenantScope(), mgr, {
      limit: 100,
      trainingId: training.id,
    });
    expect(all.data.map((row) => row.employeeId).sort()).toEqual(
      [eA, eA2].sort(),
    );
    const scoped = await listTrainingCertificates(
      outletScope(outletB),
      await actor(["hr.training.manage"], { type: "outlet", id: outletB }),
      { limit: 100, trainingId: training.id },
    );
    expect(scoped.data).toEqual([]);
    expect(
      (
        await failure(
          listTrainingCertificates(tenantScope(), stranger, { limit: 10 }),
        )
      ).status,
    ).toBe(403);
  });
});

describe("tenant isolation and immutability", () => {
  it("[TEN-01] another tenant sees no training, and cannot enrol or list", async () => {
    const training = await makeTraining();
    expect(
      await withTenant(db, tenantScope(otherTenant), (tx) =>
        tx.select().from(trainings).where(eq(trainings.id, training.id)),
      ),
    ).toEqual([]);
    expect(
      (
        await failure(
          enrollTraining(
            tenantScope(otherTenant),
            hrOther,
            training.id,
            enrollTrainingInputSchema.parse({ employeeIds: [eA], dueOn: null }),
          ),
        )
      ).status,
    ).toBe(404);
    const listed = await listTrainings(tenantScope(otherTenant), hrOther, {
      limit: 100,
    });
    expect(listed.data.map((row) => row.id)).not.toContain(training.id);
  });

  it("[TEN-02] RLS refuses writing a training row into another tenant", async () => {
    await expect(
      withTenant(db, tenantScope(otherTenant), (tx) =>
        tx.insert(trainings).values({
          tenantId,
          title: `${TITLE} bocor`,
          description: "x",
          passingScore: 50,
          validityMonths: 0,
          createdBy: hrOther as never,
        }),
      ),
    ).rejects.toThrow();
  });

  it("quiz attempts cannot be changed or deleted by the app role", async () => {
    const training = await makeTraining();
    const done = await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      answers(training, [0, 1]),
    );
    await expect(
      withTenant(db, tenantScope(), (tx) =>
        tx
          .update(trainingCompletions)
          .set({ score: 0 })
          .where(eq(trainingCompletions.id, done.id)),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(db, tenantScope(), (tx) =>
        tx
          .delete(trainingCompletions)
          .where(eq(trainingCompletions.id, done.id)),
      ),
    ).rejects.toThrow();
  });

  it("certificates and the question bank cannot be changed or deleted by the app role", async () => {
    const training = await makeTraining();
    const done = await completeTraining(
      outletScope(outletA),
      staffA,
      training.id,
      answers(training, [0, 1]),
    );
    expect(done.passed).toBe(true);
    const questionId = training.questions[0]!.id;
    const refused = (
      run: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => unknown,
    ) =>
      expect(
        withTenant(db, tenantScope(), async (tx) => {
          await run(tx);
        }),
      ).rejects.toThrow();
    await refused((tx) =>
      tx
        .update(trainingCertificates)
        .set({ certificateNumber: "CERT-TAMPERED" })
        .where(eq(trainingCertificates.completionId, done.id)),
    );
    await refused((tx) =>
      tx
        .delete(trainingCertificates)
        .where(eq(trainingCertificates.completionId, done.id)),
    );
    await refused((tx) =>
      tx
        .update(trainingQuestions)
        .set({ correctOptionIndex: 1 })
        .where(eq(trainingQuestions.id, questionId)),
    );
    await refused((tx) =>
      tx.delete(trainingQuestions).where(eq(trainingQuestions.id, questionId)),
    );
  });
});

describe("training HTTP routes", () => {
  const app = createApp();
  let managerClient: ReturnType<typeof agent>;
  let staffClient: ReturnType<typeof agent>;
  let employeeId: string;

  async function signedIn(name: string) {
    const client = agent(app);
    await signUp(client, name);
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    createdUsers.push(userId);
    return { client, userId };
  }

  beforeAll(async () => {
    const manager = await signedIn("Training manager");
    await grantRole(manager.userId, ["hr.training.manage"], { type: "tenant" });
    managerClient = manager.client;
    const staff = await signedIn("Training staff");
    await grantRole(staff.userId, ["self.sop.read"], {
      type: "outlet",
      id: outletA,
    });
    staffClient = staff.client;
    employeeId = await seedEmployee(staff.userId, outletA);
  });

  it("creates, enrols and completes end to end, never leaking the key", async () => {
    const created = await managerClient
      .post("/api/hris/trainings")
      .set(originHeader)
      .send(trainingInput());
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain("orrectOptionIndex");
    const training = created.body.data as Training;

    const enrolled = await managerClient
      .post(`/api/hris/trainings/${training.id}/enrollments`)
      .set(originHeader)
      .send({ employeeIds: [employeeId], dueOn: null });
    expect(enrolled.status).toBe(200);
    expect(enrolled.body.data).toHaveLength(1);

    const visible = await staffClient.get("/api/hris/trainings?limit=100");
    expect(visible.status).toBe(200);
    expect(
      visible.body.data.some((row: { id: string }) => row.id === training.id),
    ).toBe(true);
    expect(JSON.stringify(visible.body)).not.toContain("orrectOptionIndex");

    const completed = await staffClient
      .post(`/api/hris/trainings/${training.id}/completions`)
      .set(originHeader)
      .send(answers(training, [0, 1]));
    expect(completed.status).toBe(200);
    expect(completed.body.data).toMatchObject({ passed: true, attempts: 1 });

    const certificates = await staffClient.get(
      `/api/hris/training-certificates?trainingId=${training.id}`,
    );
    expect(certificates.status).toBe(200);
    expect(certificates.body.data).toHaveLength(1);

    const roster = await managerClient.get(
      `/api/hris/trainings/${training.id}/enrollments`,
    );
    expect(roster.status).toBe(200);
    expect(roster.body.data[0]).toMatchObject({ passed: true, attempts: 1 });
    // A manager's back-office session may also read the shared list.
    expect((await managerClient.get("/api/hris/trainings")).status).toBe(200);
  });

  it("[TEN-02] closes the routes to anonymous, foreign-origin and under-privileged callers", async () => {
    const anonymous = agent(app);
    expect((await anonymous.get("/api/hris/trainings")).status).toBe(401);
    const noOrigin = await managerClient
      .post("/api/hris/trainings")
      .send(trainingInput());
    expect(noOrigin.status).toBe(403);
    const withTenantId = await managerClient
      .post("/api/hris/trainings")
      .set(originHeader)
      .send({ ...trainingInput(), tenantId });
    expect(withTenantId.status).toBe(422);
    const staffCreate = await staffClient
      .post("/api/hris/trainings")
      .set(originHeader)
      .send(trainingInput());
    expect(staffCreate.status).toBe(403);
    expect(
      (
        await staffClient.get(
          "/api/hris/trainings/" + randomUUID() + "/enrollments",
        )
      ).status,
    ).toBe(403);
  });
});
