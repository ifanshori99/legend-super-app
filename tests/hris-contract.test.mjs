// HRIS contract tests (bead legend-i7fc).
// Acceptance IDs in test names: HR-01 (own record only), HR-03 (encrypted PII,
// HR/payroll only), HR-05 (swap compliance needs an explicit override).
// Run with `pnpm test` (root node:test suite).

import assert from "node:assert/strict";
import { test } from "node:test";
import * as hris from "../packages/shared/src/hris/index.ts";
import { eventCatalogByName } from "../packages/shared/src/events/index.ts";
import { buildEndpointPath } from "../packages/shared/src/api/endpoint.ts";

const fixtures = hris.cafeLegendHrisFixtures;
const tenantId = fixtures.tenant.id;
const outletId = fixtures.outlets[0].id;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const employeeViewer = (kind, employeeId = null) => ({
  kind,
  employeeId,
  permissions: [],
});

test("HR-01 an employee can only reach their own record, also through a direct call", () => {
  const own = fixtures.employees[0];
  const other = fixtures.employees[1];
  const self = employeeViewer("self", own.id);

  assert.equal(hris.canHrisViewEmployee(self, own.id), true);
  assert.equal(hris.canHrisViewEmployee(self, other.id), false);
  assert.equal(hris.hrisPiiVisibility(self, other.id, "identity"), "hidden");
  assert.equal(hris.hrisPiiVisibility(self, other.id, "contact"), "hidden");
  assert.equal(hris.hrisPiiVisibility(self, own.id, "contact"), "full");
  assert.equal(hris.hrisPiiVisibility(self, own.id, "identity"), "masked");

  // A viewer without an employee row never satisfies `self`.
  assert.equal(
    hris.canHrisViewEmployee(employeeViewer("self"), other.id),
    false,
  );
  // HR-01 document access: own documents only, unless HR permission is present.
  assert.equal(hris.canReadEmployeeDocument(own.id, own.id, false), true);
  assert.equal(hris.canReadEmployeeDocument(own.id, other.id, false), false);
  assert.equal(hris.canReadEmployeeDocument(null, other.id, false), false);
  assert.equal(hris.canReadEmployeeDocument(null, other.id, true), true);
});

test("HR-03 NIK, NPWP, BPJS, bank and salary are encrypted and HR/payroll only", () => {
  const encryptedFields = [
    "employeeNik",
    "employeeNpwp",
    "employeeBpjsKes",
    "employeeBpjsTk",
    "employeeBankAccount",
    "contractSalarySnapshot",
  ];
  for (const name of encryptedFields) {
    const field = hris.HRIS_PII_FIELDS[name];
    assert.equal(field.encryptionAtRest, "app_aes_256_gcm", name);
    assert.ok(
      field.readPermissions.some(
        (code) => code.startsWith("hr.") || code.startsWith("payroll."),
      ),
      `${name} must be guarded by an HR/payroll permission`,
    );
  }
  for (const name of [
    "employeeNik",
    "employeeNpwp",
    "employeeBpjsKes",
    "employeeBpjsTk",
    "employeeBankAccount",
  ])
    assert.ok(
      hris.HRIS_PII_FIELDS[name].blindIndex,
      `${name} needs a blind index`,
    );

  for (const name of [
    "contractFileUrl",
    "employeeDocumentFileUrl",
    "attendancePhotoUrl",
    "leaveAttachmentUrl",
  ])
    assert.equal(
      hris.HRIS_PII_FIELDS[name].encryptionAtRest,
      "private_bucket_sse",
    );

  assert.equal(hris.isHrisPiiColumn("nik_encrypted"), true);
  assert.equal(hris.isHrisPiiColumn("salary_snapshot_encrypted"), true);
  assert.equal(hris.isHrisPiiColumn("full_name"), false);

  // HR-03 visibility: only HR and payroll see the cleartext value.
  const withPermissions = (kind, permissions) => ({
    ...employeeViewer(kind),
    permissions,
  });
  const hr = withPermissions("hr", ["hr.employee.view"]);
  const payroll = withPermissions("payroll", ["payroll.view"]);
  const owner = employeeViewer("owner");
  const supervisor = withPermissions("supervisor", ["hr.attendance.manage"]);
  // HR-03 fail closed: the viewer kind alone never unlocks PII.
  for (const kind of ["identity", "bank", "salary"])
    assert.equal(
      hris.hrisPiiVisibility(
        employeeViewer("hr"),
        fixtures.employees[3].id,
        kind,
      ),
      "hidden",
    );
  assert.equal(
    hris.hrisPiiVisibility(
      employeeViewer("supervisor"),
      fixtures.employees[3].id,
      "attendance_photo",
    ),
    "hidden",
  );
  assert.throws(() => hris.hrisPiiField("notAField"), RangeError);
  const subject = fixtures.employees[3].id;
  for (const kind of ["identity", "tax", "social_security", "bank", "salary"]) {
    assert.equal(hris.hrisPiiVisibility(hr, subject, kind), "full");
    assert.equal(hris.hrisPiiVisibility(payroll, subject, kind), "full");
    assert.equal(hris.hrisPiiVisibility(owner, subject, kind), "hidden");
    assert.equal(hris.hrisPiiVisibility(supervisor, subject, kind), "hidden");
  }
  // Supervisors review attendance selfies by sampling (PRD F25), not payroll data.
  assert.equal(
    hris.hrisPiiVisibility(supervisor, subject, "attendance_photo"),
    "full",
  );
  assert.equal(hris.hrisPiiVisibility(supervisor, subject, "salary"), "hidden");
});

test("HR-03 PII values reach the wire masked only, never as plaintext", () => {
  assert.equal(hris.maskPiiValue("3273011505900001", "last4"), "****0001");
  assert.equal(hris.maskPiiValue("3273011505900001", "redact"), "******");
  assert.equal(
    hris.maskPiiValue("budi@cafelegend.id", "email"),
    "b***@cafelegend.id",
  );
  assert.equal(hris.maskPiiValue("Budi Santoso", "name"), "Budi S***");
  assert.equal(hris.maskPiiValue("12", "last4"), "******");

  const detail = fixtures.employeeDetails[0];
  assert.match(detail.pii.nik.masked, /^\*{4}\d{4}$/);
  assert.equal(typeof detail.pii.nik.keyVersion, "number");

  // A raw value is not a MaskedPiiValue, and the employee list cannot carry PII.
  assert.equal(
    hris.employeePiiSchema.safeParse({ ...detail.pii, nik: "3273011505900001" })
      .success,
    false,
  );
  assert.equal(
    hris.employeeDetailSchema.safeParse({ ...fixtures.employees[0], pii: {} })
      .success,
    false,
  );
  assert.equal(
    hris.employeeSchema.safeParse({ ...fixtures.employees[0], pii: detail.pii })
      .success,
    false,
  );

  // A contract row exposes only the masked salary snapshot.
  const contract = fixtures.contracts[0];
  assert.match(contract.salarySnapshot.masked, /^\*{4}\d{4}$/);
  assert.equal(
    hris.employmentContractSchema.safeParse({
      ...contract,
      salarySnapshotIdr: 4_500_000,
    }).success,
    false,
  );
});

test("HRIS fixtures parse and cover 30+ employees with unique identities", () => {
  const domainFixtures = Object.fromEntries(
    Object.entries(fixtures).filter(
      ([key]) =>
        ![
          "tenant",
          "outlets",
          "now",
          "trainingAnswerKeys",
          "events",
          "userIds",
        ].includes(key),
    ),
  );
  hris.hrisFixtureSchema.parse(domainFixtures);
  assert.ok(fixtures.employees.length >= 30);
  assert.equal(
    new Set(fixtures.employees.map((employee) => employee.id)).size,
    fixtures.employees.length,
  );
  assert.equal(
    new Set(fixtures.employees.map((employee) => employee.employeeNo)).size,
    fixtures.employees.length,
  );
  const statuses = new Set(
    fixtures.employees.map((employee) => employee.status),
  );
  for (const status of [
    "onboarding",
    "active",
    "suspended",
    "resigned",
    "terminated",
  ])
    assert.ok(statuses.has(status), `missing status ${status}`);
  assert.equal(fixtures.employeePii.length, fixtures.employees.length);
  for (const row of fixtures.employeePii)
    for (const [field, value] of Object.entries(row.pii))
      // bankCode is a plain 3-digit bank code, not a masked secret.
      if (value !== null && field !== "bankCode") {
        assert.equal(typeof value.masked, "string");
        assert.ok(!/^\d{16}$/.test(value.masked));
      }
  // Every PKWT contract has an end date; every PKWTT contract has none.
  for (const contract of fixtures.contracts) {
    if (contract.type === "pkwt") assert.notEqual(contract.endDate, null);
    if (contract.type === "pkwtt") assert.equal(contract.endDate, null);
  }
  assert.ok(fixtures.contracts.length >= fixtures.employees.length);
});

test("HR-05 a swap that breaks working-time rules needs an explicit override", () => {
  const violating = fixtures.shiftSwapRequests[0];
  assert.equal(violating.status, "pending");
  assert.ok(violating.complianceIssues.length > 0);
  assert.ok(
    violating.complianceIssues.some(
      (issue) => issue.code === "overlapping_shift",
    ),
  );

  assert.throws(
    () =>
      hris.transitionShiftSwap("pending", "approve", {
        complianceIssues: violating.complianceIssues,
      }),
    /HR-05/,
  );
  assert.throws(
    () =>
      hris.transitionShiftSwap("pending", "approve_with_override", {
        complianceIssues: violating.complianceIssues,
        overrideReason: "   ",
      }),
    /alasan/,
  );
  assert.equal(
    hris.transitionShiftSwap("pending", "approve_with_override", {
      complianceIssues: violating.complianceIssues,
      overrideReason: "Kekurangan staf saat event; disetujui manajer outlet.",
    }),
    "approved",
  );

  const clean = fixtures.shiftSwapRequests[1];
  assert.equal(clean.status, "approved");
  assert.equal(clean.complianceIssues.length, 0);
  assert.equal(
    hris.transitionShiftSwap("pending", "approve", { complianceIssues: [] }),
    "approved",
  );
  // HR-05 fail closed: approving without a recomputed compliance diff is refused.
  assert.throws(
    () => hris.transitionShiftSwap("pending", "approve"),
    /dihitung ulang/,
  );
  assert.throws(
    () =>
      hris.transitionShiftSwap("pending", "approve_with_override", {
        complianceIssues: [],
        overrideReason: "tidak perlu",
      }),
    /override/,
  );
  assert.throws(() => hris.transitionShiftSwap("approved", "approve"), /sudah/);

  // The row itself cannot claim an approved exception without a reason (HR-05).
  assert.equal(
    hris.shiftSwapRequestSchema.safeParse({
      ...violating,
      status: "approved",
      approvedBy: fixtures.userIds.outletManager,
      decidedAt: "2026-10-25T03:00:00.000Z",
      overrideReason: null,
    }).success,
    false,
  );
});

test("compliance warnings cover long shifts, rest, overlap, weekly and consecutive limits", () => {
  const policy = hris.shiftCompliancePolicySchema.parse({
    tenantId,
    outletId: null,
    maxShiftMinutes: 600,
    maxDailyMinutes: 660,
    maxWeeklyMinutes: 2_400,
    minRestMinutesBetweenShifts: 660,
    maxConsecutiveWorkDays: 5,
  });
  const employee = hris.employeeIdSchema.parse(uuid(8801));
  const make = (n, date, start, end, breakMinutes = 60) =>
    hris.shiftAssignmentSchema.parse({
      id: uuid(9000 + n),
      tenantId,
      outletId,
      employeeId: employee,
      shiftTemplateId: null,
      stationId: null,
      businessDate: date,
      segments: [
        {
          startsAt: `${date}T${start}:00+07:00`,
          endsAt: `${date}T${end}:00+07:00`,
        },
      ],
      breakMinutes,
      status: "draft",
      source: "user",
      publishedBy: null,
      publishedAt: null,
    });

  const sixDays = [
    "2026-10-26",
    "2026-10-27",
    "2026-10-28",
    "2026-10-29",
    "2026-10-30",
    "2026-10-31",
  ].map((date, index) => make(index, date, "08:00", "16:00"));
  const weeklyIssues = hris.evaluateShiftCompliance(sixDays, policy);
  assert.ok(
    weeklyIssues.some((issue) => issue.code === "weekly_limit_exceeded"),
  );
  assert.ok(
    weeklyIssues.some((issue) => issue.code === "too_many_consecutive_days"),
  );

  const longShift = [make(20, "2026-10-26", "08:00", "20:00", 0)];
  const longIssues = hris.evaluateShiftCompliance(longShift, policy);
  assert.ok(longIssues.some((issue) => issue.code === "shift_too_long"));
  assert.ok(longIssues.some((issue) => issue.code === "daily_limit_exceeded"));

  const tightRest = [
    make(30, "2026-10-26", "08:00", "16:00"),
    make(31, "2026-10-27", "00:00", "08:00"),
  ];
  const restIssues = hris.evaluateShiftCompliance(tightRest, policy);
  assert.ok(restIssues.some((issue) => issue.code === "insufficient_rest"));

  const overlap = [
    make(40, "2026-10-26", "08:00", "16:00"),
    make(41, "2026-10-26", "15:00", "23:00"),
  ];
  const overlapIssues = hris.evaluateShiftCompliance(overlap, policy);
  assert.ok(overlapIssues.some((issue) => issue.code === "overlapping_shift"));

  // A long shift overlapping two later shifts is caught twice, not once.
  const overlaps = hris
    .evaluateShiftCompliance(
      [
        make(60, "2026-11-02", "06:00", "18:00", 0),
        make(61, "2026-11-02", "08:00", "10:00", 0),
        make(62, "2026-11-02", "11:00", "13:00", 0),
      ],
      policy,
    )
    .filter((issue) => issue.code === "overlapping_shift");
  assert.equal(overlaps.length, 2);

  // Cancelled shifts never raise warnings.
  const cancelled = [
    { ...make(50, "2026-10-26", "08:00", "20:00", 0), status: "cancelled" },
  ];
  assert.equal(hris.evaluateShiftCompliance(cancelled, policy).length, 0);
});

test("attendance policy rejects or flags per configuration, QR lives 30 seconds", () => {
  const policy = fixtures.attendancePolicy;
  const outside = hris.evaluateAttendanceSubmission({
    policy,
    method: "selfie_geo",
    geoDistanceM: policy.geofenceRadiusM + 10,
    deviceBound: true,
    selfieProvided: true,
  });
  assert.equal(outside.validity, "flagged");

  const strict = hris.evaluateAttendanceSubmission({
    policy: { ...policy, outsideGeofenceAction: "reject" },
    method: "selfie_geo",
    geoDistanceM: policy.geofenceRadiusM + 10,
    deviceBound: true,
    selfieProvided: true,
  });
  assert.equal(strict.validity, "rejected");

  assert.equal(
    hris.evaluateAttendanceSubmission({
      policy,
      method: "selfie_geo",
      geoDistanceM: 10,
      deviceBound: true,
      selfieProvided: false,
    }).validity,
    "rejected",
  );
  assert.equal(
    hris.evaluateAttendanceSubmission({
      policy,
      method: "selfie_geo",
      geoDistanceM: 10,
      deviceBound: false,
      selfieProvided: true,
    }).validity,
    "flagged",
  );

  // Fail closed: GPS off on a geofenced method counts as outside the fence,
  // and a QR clock-in needs a positive server-side token check.
  assert.equal(
    hris.evaluateAttendanceSubmission({
      policy: { ...policy, outsideGeofenceAction: "reject" },
      method: "selfie_geo",
      geoDistanceM: null,
      deviceBound: true,
      selfieProvided: true,
    }).validity,
    "rejected",
  );
  if (policy.allowRotatingQr)
    assert.equal(
      hris
        .evaluateAttendanceSubmission({
          policy,
          method: "rotating_qr",
          geoDistanceM: null,
          deviceBound: true,
          selfieProvided: true,
        })
        .reasons.includes("qr_token_invalid"),
      true,
    );

  const qr = fixtures.attendanceQr;
  assert.equal(
    hris.isAttendanceQrValid(qr, new Date("2026-11-01T02:30:29.000Z")),
    true,
  );
  assert.equal(
    hris.isAttendanceQrValid(qr, new Date("2026-11-01T02:30:31.000Z")),
    false,
  );
  assert.equal(
    hris.attendanceQrTokenSchema.safeParse({
      ...qr,
      expiresAt: "2026-11-01T02:31:00.000Z",
    }).success,
    false,
  );
  assert.equal(hris.transitionAttendanceValidity("flagged", "accept"), "valid");
  assert.throws(() => hris.transitionAttendanceValidity("rejected", "accept"));
});

test("employee, contract, checklist, leave, overtime and KPI machines hold their rules", () => {
  assert.equal(hris.transitionEmployeeStatus("active", "resign"), "resigned");
  assert.equal(
    hris.transitionEmployeeStatus("suspended", "reinstate"),
    "active",
  );
  assert.throws(() => hris.transitionEmployeeStatus("resigned", "activate"));
  assert.throws(() => hris.transitionEmployeeStatus("terminated", "activate"));

  assert.equal(
    hris.transitionEmploymentContract("draft", "activate"),
    "active",
  );
  assert.equal(hris.transitionEmploymentContract("active", "renew"), "renewed");
  assert.throws(() => hris.transitionEmploymentContract("renewed", "expire"));

  assert.equal(hris.transitionChecklistTask("open", "complete"), "done");
  assert.equal(hris.transitionChecklistTask("open", "block"), "blocked");
  assert.equal(hris.transitionChecklistTask("blocked", "unblock"), "open");
  assert.throws(() => hris.transitionChecklistTask("done", "block"));
  assert.equal(
    hris.isChecklistComplete([{ status: "done" }, { status: "waived" }]),
    true,
  );
  assert.equal(
    hris.isChecklistComplete([{ status: "done" }, { status: "open" }]),
    false,
  );

  assert.equal(hris.transitionLeaveRequest("pending", "approve"), "approved");
  assert.equal(hris.transitionLeaveRequest("approved", "cancel"), "cancelled");
  assert.throws(() => hris.transitionLeaveRequest("rejected", "approve"));
  assert.equal(hris.transitionOvertimeRequest("pending", "reject"), "rejected");
  assert.throws(() => hris.transitionOvertimeRequest("cancelled", "approve"));
  assert.equal(hris.transitionKpiReview("draft", "submit"), "submitted");
  assert.throws(() => hris.transitionKpiReview("submitted", "submit"));
  assert.equal(hris.transitionShiftAssignment("draft", "publish"), "published");
  assert.throws(() => hris.transitionShiftAssignment("cancelled", "publish"));
  assert.equal(
    hris.transitionAttendanceCorrection("pending", "approve"),
    "approved",
  );
  assert.throws(() =>
    hris.transitionAttendanceCorrection("approved", "reject"),
  );
});

test("leave balances cannot overdraw and overtime hours stay exact", () => {
  const balance = fixtures.leaveBalances[0];
  assert.equal(hris.leaveDaysRemaining(balance), "11.0000");
  assert.equal(hris.canApproveLeave(balance, "11.0000"), true);
  assert.equal(hris.canApproveLeave(balance, "11.0001"), false);
  // legend-hggk: a leave type's policy.negativeAllowanceDays lets a balance go
  // below zero; the API enforces that limit under a row lock, so the DTO
  // itself carries an overdrawn balance instead of refusing it.
  const overdrawn = {
    ...balance,
    usedDays: "13.0000",
    pendingDays: "2.0000",
  };
  assert.equal(hris.leaveBalanceSchema.safeParse(overdrawn).success, true);
  assert.equal(hris.leaveDaysRemaining(overdrawn), "-1.0000");
  assert.equal(hris.overtimeHours(90), "1.5000");
  assert.equal(hris.overtimeHours(45), "0.7500");
  assert.throws(() => hris.overtimeHours(0));
});

test("attendance corrections and leave decisions reject inconsistent rows", () => {
  assert.equal(
    hris.attendanceCorrectionSchema.safeParse({
      ...fixtures.attendanceCorrections[0],
      status: "approved",
      decidedAt: null,
    }).success,
    false,
  );
  assert.equal(
    hris.leaveRequestSchema.safeParse({
      ...fixtures.leaveRequests[0],
      endDate: "2026-11-15",
    }).success,
    false,
  );
  assert.equal(
    hris.leaveRequestSchema.safeParse({
      ...fixtures.leaveRequests[0],
      status: "approved",
      decidedBy: null,
      decidedAt: null,
    }).success,
    false,
  );
  // An approval always has a deciding user, even with a decision time.
  assert.equal(
    hris.leaveRequestSchema.safeParse({
      ...fixtures.leaveRequests[0],
      status: "approved",
      decidedBy: null,
      decidedAt: "2026-10-25T02:00:00.000Z",
    }).success,
    false,
  );
  assert.equal(
    hris.overtimeRequestSchema.safeParse({
      ...fixtures.overtimeRequests[1],
      decidedBy: null,
    }).success,
    false,
  );
});

test("holiday calendar rejects duplicates and respects outlet scope", () => {
  const holidays = fixtures.holidays;
  assert.equal(hris.isHoliday("2026-12-25", holidays), true);
  assert.equal(hris.isHoliday("2026-12-26", holidays), false);
  const outletHoliday = hris.holidaySchema.parse({
    ...holidays[0],
    id: uuid(7001),
    date: "2026-07-01",
    outletId,
  });
  assert.equal(hris.isHoliday("2026-07-01", [outletHoliday], outletId), true);
  assert.equal(
    hris.isHoliday("2026-07-01", [outletHoliday], uuid(7002)),
    false,
  );
  assert.equal(
    hris.holidayCalendarSchema.safeParse([holidays[0], holidays[0]]).success,
    false,
  );
});

test("SOP versions, acknowledgements and training grading enforce F29", () => {
  const [first, second] = fixtures.sopDocuments;
  assert.equal(hris.isSopVersionSuccessor(first, second), true);
  assert.equal(hris.isSopVersionSuccessor(second, first), false);

  assert.equal(
    hris.isSopAcknowledged(
      second,
      fixtures.sopAcknowledgements,
      fixtures.employees[3].id,
    ),
    true,
  );
  // An acknowledgement of version 1 does not satisfy version 2.
  assert.equal(
    hris.isSopAcknowledged(
      second,
      fixtures.sopAcknowledgements,
      fixtures.employees[4].id,
    ),
    false,
  );

  const training = fixtures.trainings[0];
  const key = fixtures.trainingAnswerKeys[0];
  const allCorrect = key.answers.map((answer) => ({
    questionId: answer.questionId,
    optionIndex: answer.correctOptionIndex,
  }));
  const perfect = hris.gradeTrainingAttempt(training, key, allCorrect);
  assert.equal(perfect.score, 100);
  assert.equal(perfect.passed, true);

  const partial = hris.gradeTrainingAttempt(
    training,
    key,
    allCorrect.slice(0, 1),
  );
  assert.equal(partial.correctPoints, 2);
  assert.equal(partial.totalPoints, 5);
  assert.equal(partial.score, 40);
  assert.equal(partial.passed, false);

  // The answer key is never part of the training payload served to the client.
  const leaked = {
    ...training,
    questions: training.questions.map((question) => ({
      ...question,
      correctOptionIndex: 1,
    })),
  };
  assert.equal(hris.trainingSchema.safeParse(leaked).success, false);

  const completion = fixtures.trainingCompletions[0];
  assert.equal(hris.isCertificationValid(completion, "2027-10-20"), true);
  assert.equal(hris.isCertificationValid(completion, "2027-10-21"), false);
  assert.equal(
    hris.isCertificationValid(fixtures.trainingCompletions[1], "2026-11-01"),
    false,
  );
});

test("announcement audiences and receipts follow the target employee", () => {
  const employee = fixtures.employees[0];
  const target = (outlet) => ({ employeeId: employee.id, outletId: outlet });
  const outletAnnouncement = fixtures.announcements[1];
  assert.equal(
    hris.isAnnouncementVisibleTo(
      outletAnnouncement,
      target(fixtures.outlets[1].id),
    ),
    true,
  );
  assert.equal(
    hris.isAnnouncementVisibleTo(
      outletAnnouncement,
      target(fixtures.outlets[0].id),
    ),
    false,
  );

  const allAnnouncement = fixtures.announcements[2];
  assert.equal(
    hris.isAnnouncementVisibleTo(allAnnouncement, target(outletId)),
    true,
  );

  const receiptAnnouncement = fixtures.announcements[0];
  assert.equal(
    hris.isAnnouncementReceiptComplete(
      receiptAnnouncement,
      fixtures.announcementReceipts[0],
    ),
    true,
  );
  assert.equal(
    hris.isAnnouncementReceiptComplete(
      receiptAnnouncement,
      fixtures.announcementReceipts[1],
    ),
    false,
  );
  assert.equal(
    hris.isAnnouncementReceiptComplete(receiptAnnouncement, null),
    false,
  );
});

test("HR event payloads are catalogued on WS-10 and carry no PII", () => {
  assert.deepEqual(hris.hrisEventNames, [
    "attendance.logged",
    "shift.published",
    "shift.cancelled",
    "leave.approved",
    "leave.changed",
    "leave.rededucted_after_settlement",
  ]);
  for (const name of hris.hrisEventNames) {
    const entry = eventCatalogByName.get(name);
    assert.ok(entry, `${name} is not in the event catalog`);
    assert.equal(entry.workstream, "WS-10");
    assert.equal(entry.version, 1);
  }

  const events = fixtures.events;
  hris.attendanceLogged.envelopeSchema.parse(events.attendanceLogged);
  hris.shiftPublished.envelopeSchema.parse(events.shiftPublished);
  hris.shiftCancelled.envelopeSchema.parse(events.shiftCancelled);
  hris.leaveApproved.envelopeSchema.parse(events.leaveApproved);

  for (const event of Object.values(events)) {
    // leave.changed carries `changeReason`, a closed enum (range_split, ...),
    // not the free-text leave reason; only that key name is exempt.
    const serialized = JSON.stringify(event.payload).replaceAll(
      '"changeReason"',
      '""',
    );
    for (const forbidden of [
      "nik",
      "npwp",
      "bankAccount",
      "salary",
      "reason",
      "attachment",
      "photoUrl",
    ])
      assert.equal(
        serialized.toLowerCase().includes(forbidden.toLowerCase()),
        false,
        `${event.name} payload leaks ${forbidden}`,
      );
  }

  assert.equal(
    hris.attendanceLogged.envelopeSchema.safeParse({
      ...events.attendanceLogged,
      payload: { ...events.attendanceLogged.payload, validity: "unknown" },
    }).success,
    false,
  );
});

test("HRIS endpoints are unique, GET-safe and reject client tenant ids", () => {
  const ids = hris.hrisEndpoints.map((endpoint) => endpoint.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const endpoint of hris.hrisEndpoints) {
    assert.ok(endpoint.path.startsWith("/api/hris/"), endpoint.id);
    assert.ok(endpoint.id.includes(" "), endpoint.id);
    if (endpoint.method === "GET") assert.equal(endpoint.body, undefined);
    if (endpoint.path.includes(":")) assert.ok(endpoint.params, endpoint.id);
  }
  assert.ok(ids.includes("GET /api/hris/employees"));
  assert.ok(ids.includes("GET /api/hris/employees/:employeeId/pii"));
  assert.ok(ids.includes("POST /api/hris/rosters/publish"));
  assert.ok(ids.includes("POST /api/hris/leave/requests"));

  const createLeave = hris.hrisEndpoints.find(
    (endpoint) => endpoint.id === "POST /api/hris/leave/requests",
  );
  const validBody = {
    leaveTypeId: uuid(8101),
    startDate: "2026-11-16",
    endDate: "2026-11-18",
    reason: null,
    attachmentUploadRef: null,
    idempotencyKey: "leave-request-001",
  };
  assert.equal(createLeave.body.safeParse(validBody).success, true);
  assert.equal(
    createLeave.body.safeParse({ ...validBody, tenantId }).success,
    false,
  );

  // Founder decision Q7 (cuti bersama): tenant leave settings.
  assert.ok(ids.includes("GET /api/hris/leave/settings"));
  const putSettings = hris.hrisEndpoints.find(
    (endpoint) => endpoint.id === "PUT /api/hris/leave/settings",
  );
  const settingsBody = {
    collectiveLeaveDeductsAnnual: true,
    annualLeaveTypeId: null,
    idempotencyKey: "leave-settings-001",
  };
  assert.equal(putSettings.body.safeParse(settingsBody).success, true);
  assert.equal(
    putSettings.body.safeParse({ ...settingsBody, tenantId }).success,
    false,
  );
  assert.equal(
    putSettings.body.safeParse({
      ...settingsBody,
      annualLeaveTypeId: uuid(8101),
    }).success,
    true,
  );
  // Effective-from: optional (null = server default), a valid date >= 2000.
  assert.equal(
    putSettings.body.parse(settingsBody).collectiveLeaveEffectiveFrom,
    null,
  );
  for (const [value, ok] of [
    ["2027-01-01", true],
    ["2000-01-01", true],
    [null, true],
    ["1999-12-31", false],
    ["2027-13-01", false],
    ["01/01/2027", false],
  ]) {
    assert.equal(
      putSettings.body.safeParse({
        ...settingsBody,
        collectiveLeaveEffectiveFrom: value,
      }).success,
      ok,
      String(value),
    );
  }
  assert.equal(
    hris.leaveSettingsSchema.safeParse({
      tenantId,
      collectiveLeaveDeductsAnnual: true,
      annualLeaveTypeId: null,
      effectiveAnnualLeaveTypeId: uuid(8101),
      collectiveLeaveEffectiveFrom: "2027-01-01",
      updatedBy: null,
      updatedAt: null,
    }).success,
    true,
  );

  const updatePii = hris.hrisEndpoints.find(
    (endpoint) => endpoint.id === "PUT /api/hris/employees/:employeeId/pii",
  );
  assert.equal(
    updatePii.body.safeParse({
      nik: "3273011505900001",
      idempotencyKey: "employee-pii-001",
    }).success,
    true,
  );
  assert.equal(
    updatePii.body.safeParse({
      nik: "3273011505900001",
      idempotencyKey: "employee-pii-001",
      tenantId,
    }).success,
    false,
  );

  assert.equal(
    buildEndpointPath("/api/hris/employees/:employeeId", {
      employeeId: fixtures.employees[0].id,
    }),
    `/api/hris/employees/${fixtures.employees[0].id}`,
  );
});
