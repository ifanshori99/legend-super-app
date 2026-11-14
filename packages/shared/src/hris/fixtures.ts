// Cafe Legend HRIS fixtures (FE mock mode + contract tests).
// 32 synthetic employees across the Bandung outlet, the preopening second
// outlet and head office; people, dates and amounts are illustrative, not the
// owner's real payroll. Every row parses against the schemas in this folder.
//
// No raw PII: masked values are produced with `maskPiiValue`, so the fixture
// proves the masking rules the API must apply (HR-03). Document/selfie URLs are
// example signed links, never storage keys.

import { fixtureTimeAfter } from "../core/fixture-clock.ts";
import { cafeLegendFixtures, z } from "../core/index.ts";
import { maskPiiValue } from "./pii.ts";
import {
  employeeSchema,
  employeeDetailSchema,
  employeePiiSchema,
  orgUnitSchema,
  positionGradeSchema,
  positionSchema,
  employmentContractSchema,
  employeeDocumentSchema,
} from "./organization.ts";
import { checklistTemplateSchema, checklistTaskSchema } from "./checklists.ts";
import {
  attendanceCorrectionSchema,
  attendanceLogSchema,
  attendancePolicySchema,
  attendanceQrTokenSchema,
} from "./attendance.ts";
import {
  addBusinessDays,
  evaluateShiftSwapCompliance,
  shiftAssignmentSchema,
  shiftCompliancePolicySchema,
  shiftSwapRequestSchema,
  shiftTemplateSchema,
} from "./scheduling.ts";
import {
  holidaySchema,
  leaveBalanceSchema,
  leaveRequestSchema,
  leaveTypeSchema,
  overtimeRequestSchema,
} from "./leave.ts";
import {
  announcementReceiptSchema,
  announcementSchema,
  kpiDefinitionSchema,
  kpiReviewSchema,
  sopAcknowledgementSchema,
  sopDocumentSchema,
  trainingCompletionSchema,
  trainingSchema,
  trainingAnswerKeySchema,
} from "./performance.ts";
import {
  attendanceLogged,
  leaveApproved,
  leaveChanged,
  leaveRedeductedAfterSettlement,
  shiftCancelled,
  shiftPublished,
} from "./events.ts";
import { employeeIdSchema } from "./ids.ts";
import type { Employee } from "./organization.ts";
import type { ShiftAssignment } from "./scheduling.ts";

const { tenant, outlets } = cafeLegendFixtures;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userId = id;
const employeeRef = (n: number) => employeeIdSchema.parse(id(n));
// 23-char prefix + 3 digits = the canonical 26-char ULID (ulidIdSchema).
const ulid = (n: number) =>
  `01JBQ7Z8K3M4N5P6Q7R8S9T${String(n).padStart(3, "0")}`;
const masked = (raw: string, rule: "last4" | "name" | "email" = "last4") => ({
  masked: maskPiiValue(raw, rule),
  keyVersion: 1,
});
const now = "2026-11-01T02:00:00.000Z";
const weekOne = "2026-10-26";
const JAKARTA = "+07:00";

// ---- Organisation --------------------------------------------------------

const orgUnits = [
  { id: 101, parentId: null, code: "OPS", name: "Operasional Outlet" },
  { id: 102, parentId: 101, code: "BAR", name: "Bar" },
  { id: 103, parentId: 101, code: "KITCHEN", name: "Dapur" },
  { id: 104, parentId: 101, code: "FOH", name: "Front of House" },
  { id: 105, parentId: null, code: "HO", name: "Kantor Pusat" },
  { id: 106, parentId: 105, code: "HRFIN", name: "HR & Keuangan" },
  { id: 107, parentId: 105, code: "MKT", name: "Marketing" },
].map((unit) =>
  orgUnitSchema.parse({
    ...unit,
    id: id(unit.id),
    tenantId: tenant.id,
    parentId: unit.parentId === null ? null : id(unit.parentId),
    isActive: true,
  }),
);

const grades = [
  { id: 201, code: "STF", name: "Staff", level: 1 },
  { id: 202, code: "SNR", name: "Senior Staff", level: 2 },
  { id: 203, code: "SPV", name: "Supervisor", level: 3 },
  { id: 204, code: "ASM", name: "Assistant Manager", level: 4 },
  { id: 205, code: "MGR", name: "Manager", level: 5 },
  { id: 206, code: "HOS", name: "Head Office Staff", level: 2 },
].map((grade) =>
  positionGradeSchema.parse({
    ...grade,
    id: id(grade.id),
    tenantId: tenant.id,
  }),
);

const positionIds = {
  barista: 301,
  headBarista: 302,
  cook: 303,
  headChef: 304,
  server: 305,
  headServer: 306,
  cashier: 307,
  outletManager: 308,
  assistantManager: 309,
  hrAdmin: 310,
  finance: 311,
  marketing: 312,
} as const;

const positionRows = [
  [301, "Barista", 201, 102, "1.0000"],
  [302, "Head Barista", 202, 102, "1.5000"],
  [303, "Cook", 201, 103, "1.0000"],
  [304, "Head Chef", 203, 103, "2.0000"],
  [305, "Server", 201, 104, "1.0000"],
  [306, "Head Server", 202, 104, "1.5000"],
  [307, "Cashier", 201, 104, "1.2500"],
  [308, "Outlet Manager", 205, 101, "2.5000"],
  [309, "Assistant Outlet Manager", 204, 101, "2.0000"],
  [310, "HR Admin", 206, 106, "1.0000"],
  [311, "Finance Staff", 206, 106, "1.2500"],
  [312, "Marketing Staff", 206, 107, "1.0000"],
] as const;

const positions = positionRows.map(
  ([number, name, gradeId, orgUnitId, serviceChargePoints]) =>
    positionSchema.parse({
      id: id(number),
      tenantId: tenant.id,
      name,
      gradeId: id(gradeId),
      orgUnitId: id(orgUnitId),
      serviceChargePoints,
      isActive: true,
    }),
);

// ---- Employees -----------------------------------------------------------

type EmployeeTuple = readonly [
  no: number,
  name: string,
  position: keyof typeof positionIds,
  orgUnit: number,
  managerNo: number | null,
  outlet: "a" | "b",
  type: "pkwtt" | "pkwt" | "daily" | "intern",
  joinDate: string,
  endDate: string | null,
  ptkp: "TK/0" | "TK/1" | "K/0" | "K/1" | "K/2",
  status: "onboarding" | "active" | "suspended" | "resigned" | "terminated",
];

const employeeTuples: readonly EmployeeTuple[] = [
  [
    1001,
    "Rizky Pratama",
    "outletManager",
    101,
    null,
    "a",
    "pkwtt",
    "2019-03-04",
    null,
    "K/2",
    "active",
  ],
  [
    1002,
    "Siti Nurhaliza",
    "assistantManager",
    101,
    1001,
    "a",
    "pkwtt",
    "2020-07-01",
    null,
    "K/1",
    "active",
  ],
  [
    1003,
    "Budi Santoso",
    "headBarista",
    102,
    1002,
    "a",
    "pkwtt",
    "2020-02-10",
    null,
    "TK/0",
    "active",
  ],
  [
    1004,
    "Dewi Lestari",
    "barista",
    102,
    1003,
    "a",
    "pkwt",
    "2024-01-15",
    "2026-12-15",
    "TK/0",
    "active",
  ],
  [
    1005,
    "Agus Setiawan",
    "barista",
    102,
    1003,
    "a",
    "pkwtt",
    "2022-05-09",
    null,
    "K/0",
    "active",
  ],
  [
    1006,
    "Putri Ramadhani",
    "barista",
    102,
    1003,
    "a",
    "pkwt",
    "2025-03-01",
    "2026-11-30",
    "TK/0",
    "active",
  ],
  [
    1007,
    "Hendra Gunawan",
    "headChef",
    103,
    1002,
    "a",
    "pkwtt",
    "2019-11-18",
    null,
    "K/2",
    "active",
  ],
  [
    1008,
    "Maya Anggraini",
    "cook",
    103,
    1007,
    "a",
    "pkwtt",
    "2021-06-21",
    null,
    "TK/0",
    "active",
  ],
  [
    1009,
    "Fajar Nugroho",
    "cook",
    103,
    1007,
    "a",
    "daily",
    "2025-08-01",
    null,
    "TK/0",
    "active",
  ],
  [
    1010,
    "Ayu Wulandari",
    "cook",
    103,
    1007,
    "a",
    "intern",
    "2026-07-01",
    "2026-12-31",
    "TK/0",
    "active",
  ],
  [
    1011,
    "Dimas Saputra",
    "headServer",
    104,
    1002,
    "a",
    "pkwtt",
    "2020-09-14",
    null,
    "K/1",
    "active",
  ],
  [
    1012,
    "Rina Kartika",
    "server",
    104,
    1011,
    "a",
    "pkwt",
    "2024-04-01",
    "2027-03-31",
    "TK/0",
    "active",
  ],
  [
    1013,
    "Yoga Pratama",
    "server",
    104,
    1011,
    "a",
    "daily",
    "2025-10-01",
    null,
    "TK/0",
    "active",
  ],
  [
    1014,
    "Lina Marlina",
    "cashier",
    104,
    1011,
    "a",
    "pkwtt",
    "2021-02-08",
    null,
    "K/0",
    "active",
  ],
  [
    1015,
    "Wahyu Hidayat",
    "cashier",
    104,
    1011,
    "a",
    "pkwt",
    "2025-01-06",
    "2026-12-05",
    "TK/1",
    "active",
  ],
  [
    1016,
    "Intan Permata",
    "server",
    104,
    1011,
    "a",
    "pkwt",
    "2025-05-19",
    "2026-09-30",
    "K/0",
    "resigned",
  ],
  [
    1017,
    "Reza Maulana",
    "barista",
    102,
    1003,
    "a",
    "pkwtt",
    "2023-08-14",
    null,
    "TK/0",
    "suspended",
  ],
  [
    1018,
    "Nadia Safitri",
    "server",
    104,
    1011,
    "a",
    "daily",
    "2026-06-01",
    "2026-10-31",
    "TK/0",
    "terminated",
  ],
  [
    1019,
    "Andi Wijaya",
    "outletManager",
    101,
    null,
    "b",
    "pkwtt",
    "2026-10-01",
    null,
    "K/1",
    "onboarding",
  ],
  [
    1020,
    "Sri Rahayu",
    "barista",
    102,
    1019,
    "b",
    "pkwt",
    "2026-10-15",
    "2028-10-14",
    "TK/0",
    "onboarding",
  ],
  [
    1021,
    "Joko Susilo",
    "cook",
    103,
    1019,
    "b",
    "pkwtt",
    "2026-10-20",
    null,
    "K/2",
    "active",
  ],
  [
    1022,
    "Fitri Handayani",
    "cashier",
    104,
    1019,
    "b",
    "pkwt",
    "2026-10-20",
    "2027-10-19",
    "TK/0",
    "active",
  ],
  [
    1023,
    "Bayu Kurniawan",
    "server",
    104,
    1019,
    "b",
    "daily",
    "2026-10-25",
    null,
    "TK/0",
    "active",
  ],
  [
    1024,
    "Sarah Amelia",
    "hrAdmin",
    106,
    null,
    "a",
    "pkwtt",
    "2020-01-06",
    null,
    "K/1",
    "active",
  ],
  [
    1025,
    "Michael Tanoto",
    "finance",
    106,
    1024,
    "a",
    "pkwtt",
    "2021-03-15",
    null,
    "K/2",
    "active",
  ],
  [
    1026,
    "Clara Wijaya",
    "marketing",
    107,
    null,
    "a",
    "pkwtt",
    "2022-04-04",
    null,
    "TK/0",
    "active",
  ],
  [
    1027,
    "Anton Prabowo",
    "barista",
    102,
    1003,
    "a",
    "intern",
    "2026-08-01",
    "2026-12-31",
    "TK/0",
    "active",
  ],
  [
    1028,
    "Mega Puspita",
    "server",
    104,
    1011,
    "a",
    "pkwt",
    "2024-11-11",
    "2026-11-10",
    "TK/0",
    "active",
  ],
  [
    1029,
    "Rahmat Hidayat",
    "cook",
    103,
    1007,
    "a",
    "daily",
    "2026-09-01",
    null,
    "TK/0",
    "active",
  ],
  [
    1030,
    "Yuni Astuti",
    "cashier",
    104,
    1019,
    "b",
    "pkwt",
    "2026-10-01",
    "2028-09-30",
    "K/0",
    "active",
  ],
  [
    1031,
    "Eko Prasetyo",
    "server",
    104,
    1011,
    "a",
    "pkwtt",
    "2023-01-23",
    null,
    "K/1",
    "active",
  ],
  [
    1032,
    "Dian Sari",
    "barista",
    102,
    1003,
    "a",
    "pkwt",
    "2025-06-02",
    "2026-06-01",
    "TK/0",
    "active",
  ],
];

const employees: Employee[] = employeeTuples.map((tuple) =>
  employeeSchema.parse({
    id: id(tuple[0]),
    tenantId: tenant.id,
    userId: userId(tuple[0]),
    legalEntityId: id(400),
    employeeNo: `CL-${tuple[0]}`,
    fullName: tuple[1],
    positionId: id(positionIds[tuple[2]]),
    orgUnitId: id(tuple[3]),
    managerId: tuple[4] === null ? null : id(tuple[4]),
    homeOutletId: tuple[5] === "a" ? outletA : outletB,
    employmentType: tuple[6],
    joinDate: tuple[7],
    endDate: tuple[8],
    ptkpStatus: tuple[9],
    status: tuple[10],
  }),
);

const employeePiiRows = employees.map((employee, index) => {
  const n = index + 1;
  return {
    employeeId: employee.id,
    pii: employeePiiSchema.parse({
      nik: masked(`327301150590${String(n).padStart(4, "0")}`),
      npwp: masked(`09.254.${String(n).padStart(3, "0")}.8-407.000`),
      bpjsKesNo: masked(`00012${String(n).padStart(7, "0")}`),
      bpjsTkNo: masked(`2100${String(n).padStart(8, "0")}`),
      bankAccount: masked(`12300${String(n).padStart(6, "0")}`),
      bankCode: "014",
      emergencyContactName: masked(
        index % 2 === 0 ? "Sri Wahyuni" : "Bambang Sutrisno",
        "name",
      ),
      emergencyContactPhone: masked(`0812${String(n).padStart(8, "0")}`),
    }),
  };
});

const employeeDetails = employees.map((employee, index) =>
  employeeDetailSchema.parse({
    ...employee,
    pii: employeePiiRows[index].pii,
  }),
);

// ---- Contracts and documents --------------------------------------------

const contracts = employees.map((employee, index) => {
  const type = employee.employmentType;
  const endDate =
    type === "pkwtt"
      ? null
      : (employee.endDate ?? addBusinessDays(employee.joinDate, 730));
  const status =
    employee.status === "resigned" || employee.status === "terminated"
      ? "terminated"
      : index === 19
        ? "draft"
        : index === 31
          ? "expired"
          : "active";
  return employmentContractSchema.parse({
    id: id(3000 + index + 1),
    tenantId: tenant.id,
    employeeId: employee.id,
    type,
    taxScheme: "gross",
    startDate: employee.joinDate,
    endDate,
    renewedFromId: index === 15 ? id(3015) : null,
    salarySnapshot: masked(String(4_500_000 + index * 175_000)),
    fileUrl: `https://files.cafelegend.example/contracts/cl-${employee.employeeNo}.pdf`,
    reminderDaysBefore: 30,
    status,
  });
});

const documents = employees.slice(0, 12).flatMap((employee, index) => [
  employeeDocumentSchema.parse({
    id: id(5000 + index * 2),
    tenantId: tenant.id,
    employeeId: employee.id,
    type: "ktp",
    downloadUrl: `https://files.cafelegend.example/documents/ktp-${employee.employeeNo}.jpg`,
    expiresOn: null,
    uploadedAt: "2026-01-10T01:00:00.000Z",
    verifiedBy: userId(1024),
    verifiedAt: "2026-01-11T01:00:00.000Z",
  }),
  employeeDocumentSchema.parse({
    id: id(5001 + index * 2),
    tenantId: tenant.id,
    employeeId: employee.id,
    type: "contract",
    downloadUrl: `https://files.cafelegend.example/documents/contract-${employee.employeeNo}.pdf`,
    expiresOn: employee.endDate,
    uploadedAt: "2026-01-10T01:05:00.000Z",
    verifiedBy: null,
    verifiedAt: null,
  }),
]);

// ---- Onboarding / offboarding -------------------------------------------

const checklistTemplates = [
  checklistTemplateSchema.parse({
    id: id(6001),
    tenantId: tenant.id,
    kind: "onboarding",
    positionId: id(positionIds.barista),
    title: "Onboarding Barista",
    items: [
      {
        code: "ktp_scan",
        title: "Unggah scan KTP",
        category: "documents",
        requiresDocument: true,
        sortOrder: 1,
      },
      {
        code: "npwp_scan",
        title: "Unggah NPWP",
        category: "documents",
        requiresDocument: true,
        sortOrder: 2,
      },
      {
        code: "uniform_issued",
        title: "Seragam dan celemek",
        category: "uniform",
        requiresDocument: false,
        sortOrder: 3,
      },
      {
        code: "pos_account",
        title: "Akun POS dibuat",
        category: "account",
        requiresDocument: false,
        sortOrder: 4,
      },
      {
        code: "barista_basics",
        title: "Pelatihan Dasar Barista",
        category: "training",
        requiresDocument: false,
        sortOrder: 5,
      },
    ],
  }),
  checklistTemplateSchema.parse({
    id: id(6002),
    tenantId: tenant.id,
    kind: "onboarding",
    positionId: id(positionIds.server),
    title: "Onboarding Server",
    items: [
      {
        code: "ktp_scan",
        title: "Unggah scan KTP",
        category: "documents",
        requiresDocument: true,
        sortOrder: 1,
      },
      {
        code: "uniform_issued",
        title: "Seragam dan name tag",
        category: "uniform",
        requiresDocument: false,
        sortOrder: 2,
      },
      {
        code: "pos_account",
        title: "Akun POS dibuat",
        category: "account",
        requiresDocument: false,
        sortOrder: 3,
      },
      {
        code: "sop_server_read",
        title: "Membaca SOP Layanan",
        category: "training",
        requiresDocument: false,
        sortOrder: 4,
      },
    ],
  }),
  checklistTemplateSchema.parse({
    id: id(6003),
    tenantId: tenant.id,
    kind: "onboarding",
    positionId: null,
    title: "Onboarding Umum",
    items: [
      {
        code: "ktp_scan",
        title: "Unggah scan KTP",
        category: "documents",
        requiresDocument: true,
        sortOrder: 1,
      },
      {
        code: "email_account",
        title: "Akun email perusahaan",
        category: "account",
        requiresDocument: false,
        sortOrder: 2,
      },
    ],
  }),
  checklistTemplateSchema.parse({
    id: id(6004),
    tenantId: tenant.id,
    kind: "offboarding",
    positionId: null,
    title: "Offboarding Umum",
    items: [
      {
        code: "asset_return",
        title: "Pengembalian aset",
        category: "asset",
        requiresDocument: false,
        sortOrder: 1,
      },
      {
        code: "access_revoked",
        title: "Pencabutan akses dan perangkat",
        category: "access_revocation",
        requiresDocument: false,
        sortOrder: 2,
      },
      {
        code: "final_settlement",
        title: "Perhitungan hak akhir",
        category: "final_settlement",
        requiresDocument: false,
        sortOrder: 3,
      },
      {
        code: "work_certificate",
        title: "Surat keterangan kerja",
        category: "work_certificate",
        requiresDocument: false,
        sortOrder: 4,
      },
    ],
  }),
];

const checklistTasks = [
  checklistTaskSchema.parse({
    id: id(6101),
    tenantId: tenant.id,
    employeeId: id(1020),
    offboardingId: null,
    templateId: id(6001),
    kind: "onboarding",
    code: "ktp_scan",
    title: "Unggah scan KTP",
    category: "documents",
    requiresDocument: false,
    documentId: null,
    systemManaged: false,
    sortOrder: 0,
    status: "done",
    dueAt: "2026-10-18T09:00:00.000Z",
    doneBy: userId(1024),
    doneAt: "2026-10-16T03:00:00.000Z",
    blockReason: null,
    waiveReason: null,
  }),
  checklistTaskSchema.parse({
    id: id(6102),
    tenantId: tenant.id,
    employeeId: id(1020),
    offboardingId: null,
    templateId: id(6001),
    kind: "onboarding",
    code: "barista_basics",
    title: "Pelatihan Dasar Barista",
    category: "training",
    requiresDocument: false,
    documentId: null,
    systemManaged: false,
    sortOrder: 1,
    status: "open",
    dueAt: "2026-11-10T09:00:00.000Z",
    doneBy: null,
    doneAt: null,
    blockReason: null,
    waiveReason: null,
  }),
  checklistTaskSchema.parse({
    id: id(6103),
    tenantId: tenant.id,
    employeeId: id(1019),
    offboardingId: null,
    templateId: id(6003),
    kind: "onboarding",
    code: "email_account",
    title: "Akun email perusahaan",
    category: "account",
    requiresDocument: false,
    documentId: null,
    systemManaged: false,
    sortOrder: 0,
    status: "open",
    dueAt: "2026-11-05T09:00:00.000Z",
    doneBy: null,
    doneAt: null,
    blockReason: null,
    waiveReason: null,
  }),
  checklistTaskSchema.parse({
    id: id(6104),
    tenantId: tenant.id,
    employeeId: id(1018),
    offboardingId: null,
    templateId: id(6004),
    kind: "offboarding",
    code: "asset_return",
    title: "Pengembalian aset",
    category: "asset",
    requiresDocument: false,
    documentId: null,
    systemManaged: false,
    sortOrder: 0,
    status: "done",
    dueAt: "2026-10-31T09:00:00.000Z",
    doneBy: userId(1001),
    doneAt: "2026-10-30T08:00:00.000Z",
    blockReason: null,
    waiveReason: null,
  }),
  checklistTaskSchema.parse({
    id: id(6105),
    tenantId: tenant.id,
    employeeId: id(1018),
    offboardingId: null,
    templateId: id(6004),
    kind: "offboarding",
    code: "final_settlement",
    title: "Perhitungan hak akhir",
    category: "final_settlement",
    requiresDocument: false,
    documentId: null,
    systemManaged: false,
    sortOrder: 1,
    status: "blocked",
    dueAt: "2026-11-07T09:00:00.000Z",
    doneBy: null,
    doneAt: null,
    blockReason: "Menunggu data payroll akhir",
    waiveReason: null,
  }),
  checklistTaskSchema.parse({
    id: id(6106),
    tenantId: tenant.id,
    employeeId: id(1018),
    offboardingId: null,
    templateId: id(6004),
    kind: "offboarding",
    code: "work_certificate",
    title: "Surat keterangan kerja",
    category: "work_certificate",
    requiresDocument: false,
    documentId: null,
    systemManaged: false,
    sortOrder: 2,
    status: "open",
    dueAt: "2026-11-07T09:00:00.000Z",
    doneBy: null,
    doneAt: null,
    blockReason: null,
    waiveReason: null,
  }),
];

// ---- Attendance ----------------------------------------------------------

const attendancePolicy = attendancePolicySchema.parse({
  geofenceRadiusM: 150,
  outsideGeofenceAction: "flag",
  unboundDeviceAction: "flag",
  requireSelfie: true,
  requireDeviceBinding: true,
  allowRotatingQr: true,
  selfieRetentionDays: 90,
});

const attendanceQr = attendanceQrTokenSchema.parse({
  outletId: outletA,
  token: "QR-BDG01-20261101T0930",
  issuedAt: "2026-11-01T02:30:00.000Z",
  expiresAt: fixtureTimeAfter({ minutes: 30, seconds: 30 }, now),
  serverTime: "2026-11-01T02:30:12.000Z",
  rotationSeconds: 30,
});

const attendanceEmployeeNos = [1003, 1004, 1005, 1006, 1008, 1009, 1012, 1014];
const attendanceTimes = [
  ["in", 1, 50],
  ["break_start", 5, 0],
  ["break_end", 6, 0],
  ["out", 9, 5],
] as const;

const attendanceLogs = attendanceEmployeeNos.flatMap(
  (employeeNo, employeeIndex) =>
    attendanceTimes.map(([type, utcHour, utcMinute], logIndex) => {
      const flagged = employeeNo === 1006 && type === "in";
      return attendanceLogSchema.parse({
        id: ulid(100 + employeeIndex * 4 + logIndex),
        tenantId: tenant.id,
        employeeId: id(employeeNo),
        outletId: outletA,
        type,
        method: flagged
          ? "selfie_geo"
          : logIndex === 0
            ? "selfie_geo"
            : "rotating_qr",
        occurredAt: `2026-10-26T${String(utcHour).padStart(2, "0")}:${String(utcMinute).padStart(2, "0")}:00.000Z`,
        geoDistanceM: flagged ? 420 : logIndex === 0 ? 62 : null,
        deviceIdHash: String(employeeNo).padStart(64, "0"),
        photoUrl:
          logIndex === 0
            ? `https://files.cafelegend.example/attendance/selfie-${employeeNo}.jpg`
            : null,
        validity: flagged ? "flagged" : "valid",
        shiftAssignmentId: null,
      });
    }),
);

const attendanceCorrections = [
  attendanceCorrectionSchema.parse({
    id: id(7101),
    tenantId: tenant.id,
    outletId: outletA,
    employeeId: id(1006),
    attendanceLogId: ulid(108),
    requestedType: "out",
    requestedOccurredAt: "2026-10-26T09:10:00.000Z",
    reason: "Lupa clock out setelah shift; mesin QR sudah berganti.",
    status: "pending",
    requestedAt: "2026-10-26T10:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
  }),
  attendanceCorrectionSchema.parse({
    id: id(7102),
    tenantId: tenant.id,
    outletId: outletA,
    employeeId: id(1008),
    attendanceLogId: null,
    requestedType: "in",
    requestedOccurredAt: "2026-10-25T00:55:00.000Z",
    reason: "Ponsel kehabisan baterai, absen tidak tercatat.",
    status: "approved",
    requestedAt: "2026-10-25T01:10:00.000Z",
    decidedBy: userId(1001),
    decidedAt: "2026-10-25T02:00:00.000Z",
  }),
];

// ---- Shifts and roster ---------------------------------------------------

const shiftTemplates = [
  shiftTemplateSchema.parse({
    id: id(8001),
    tenantId: tenant.id,
    outletId: outletA,
    name: "Pagi",
    segments: [{ startTime: "08:00", endTime: "16:00" }],
    breakMinutes: 60,
    stationId: null,
    positionId: null,
    isActive: true,
  }),
  shiftTemplateSchema.parse({
    id: id(8002),
    tenantId: tenant.id,
    outletId: outletA,
    name: "Siang",
    segments: [{ startTime: "14:00", endTime: "22:00" }],
    breakMinutes: 60,
    stationId: null,
    positionId: null,
    isActive: true,
  }),
  shiftTemplateSchema.parse({
    id: id(8003),
    tenantId: tenant.id,
    outletId: outletA,
    name: "Malam",
    segments: [{ startTime: "22:00", endTime: "06:00" }],
    breakMinutes: 45,
    stationId: null,
    positionId: null,
    isActive: true,
  }),
  shiftTemplateSchema.parse({
    id: id(8004),
    tenantId: tenant.id,
    outletId: outletA,
    name: "Split",
    segments: [
      { startTime: "10:00", endTime: "14:00" },
      { startTime: "17:00", endTime: "21:00" },
    ],
    breakMinutes: 60,
    stationId: null,
    positionId: null,
    isActive: true,
  }),
  shiftTemplateSchema.parse({
    id: id(8005),
    tenantId: tenant.id,
    outletId: outletB,
    name: "Pagi Preopening",
    segments: [{ startTime: "09:00", endTime: "17:00" }],
    breakMinutes: 60,
    stationId: null,
    positionId: null,
    isActive: true,
  }),
];

const publishedAt = "2026-10-24T03:00:00.000Z";
const publishedBy = userId(1001);

function makeAssignment(
  rowNo: number,
  employeeNo: number,
  templateNo: number,
  businessDate: string,
  status: "draft" | "published" | "swapped" | "cancelled",
): ShiftAssignment {
  const template = shiftTemplates.find((row) => row.id === id(templateNo));
  if (!template)
    throw new Error(`Missing shift template fixture ${templateNo}`);
  const segments = template.segments.map((segment) => {
    const endsOnNextDay = segment.endTime <= segment.startTime;
    return {
      startsAt: `${businessDate}T${segment.startTime}:00${JAKARTA}`,
      endsAt: `${endsOnNextDay ? addBusinessDays(businessDate, 1) : businessDate}T${segment.endTime}:00${JAKARTA}`,
    };
  });
  return shiftAssignmentSchema.parse({
    id: id(7300 + rowNo),
    tenantId: tenant.id,
    outletId: outletA,
    employeeId: id(employeeNo),
    shiftTemplateId: template.id,
    stationId: null,
    businessDate,
    segments,
    breakMinutes: template.breakMinutes,
    status,
    source: "user",
    publishedBy:
      status === "published" || status === "swapped" ? publishedBy : null,
    publishedAt:
      status === "published" || status === "swapped" ? publishedAt : null,
  });
}

const dayTwo = addBusinessDays(weekOne, 1);
const dayThree = addBusinessDays(weekOne, 2);

const shiftAssignments: ShiftAssignment[] = [
  makeAssignment(1, 1003, 8001, weekOne, "published"),
  makeAssignment(2, 1003, 8001, dayTwo, "published"),
  makeAssignment(3, 1003, 8001, dayThree, "published"),
  makeAssignment(4, 1004, 8001, weekOne, "published"),
  makeAssignment(5, 1004, 8001, dayTwo, "published"),
  makeAssignment(6, 1004, 8002, dayThree, "published"),
  makeAssignment(7, 1005, 8002, weekOne, "published"),
  makeAssignment(8, 1005, 8002, dayTwo, "published"),
  makeAssignment(9, 1005, 8002, dayThree, "published"),
  makeAssignment(10, 1006, 8002, weekOne, "draft"),
  makeAssignment(11, 1006, 8002, dayTwo, "draft"),
  makeAssignment(12, 1008, 8001, weekOne, "published"),
  makeAssignment(13, 1008, 8001, dayTwo, "published"),
  makeAssignment(14, 1009, 8002, weekOne, "published"),
  makeAssignment(15, 1009, 8002, dayTwo, "published"),
  makeAssignment(16, 1012, 8001, weekOne, "published"),
  makeAssignment(17, 1012, 8001, dayTwo, "published"),
  makeAssignment(18, 1014, 8002, weekOne, "published"),
  makeAssignment(19, 1014, 8002, dayTwo, "published"),
  makeAssignment(20, 1015, 8001, dayThree, "cancelled"),
  // The employee PWA opens on the fixture "now" (2026-11-01T02:00Z = 09:00 WIB),
  // so the Beranda has a shift in progress to show (PRD §3 "HRIS Self-Service
  // Karyawan" — Beranda: jadwal hari ini).
  makeAssignment(21, 1003, 8001, "2026-11-01", "published"),
];

const shiftCompliancePolicy = shiftCompliancePolicySchema.parse({
  tenantId: tenant.id,
  outletId: null,
  maxShiftMinutes: 600,
  maxDailyMinutes: 660,
  maxWeeklyMinutes: 2_400,
  minRestMinutesBetweenShifts: 660,
  maxConsecutiveWorkDays: 5,
});

const swapComplianceIssues = evaluateShiftSwapCompliance({
  assignments: shiftAssignments,
  fromAssignmentId: id(7301),
  toEmployeeId: employeeRef(1005),
  policy: shiftCompliancePolicy,
});
const cleanSwapIssues = evaluateShiftSwapCompliance({
  assignments: shiftAssignments,
  fromAssignmentId: id(7316),
  toEmployeeId: employeeRef(1029),
  policy: shiftCompliancePolicy,
});

const shiftSwapRequests = [
  shiftSwapRequestSchema.parse({
    id: id(7401),
    tenantId: tenant.id,
    outletId: outletA,
    fromAssignmentId: id(7301),
    toAssignmentId: null,
    requestedBy: id(1003),
    toEmployeeId: id(1005),
    status: "pending",
    complianceIssues: swapComplianceIssues,
    overrideReason: null,
    rejectionReason: null,
    peerAcceptedAt: null,
    approvedBy: null,
    requestedAt: "2026-10-25T01:00:00.000Z",
    decidedAt: null,
  }),
  shiftSwapRequestSchema.parse({
    id: id(7402),
    tenantId: tenant.id,
    outletId: outletA,
    fromAssignmentId: id(7316),
    toAssignmentId: null,
    requestedBy: id(1012),
    toEmployeeId: id(1029),
    status: "approved",
    complianceIssues: cleanSwapIssues,
    overrideReason: null,
    rejectionReason: null,
    peerAcceptedAt: "2026-10-25T02:30:00.000Z",
    approvedBy: userId(1001),
    requestedAt: "2026-10-25T02:00:00.000Z",
    decidedAt: "2026-10-25T03:00:00.000Z",
  }),
];

// ---- Leave, holidays, overtime ------------------------------------------

const leaveTypes = [
  leaveTypeSchema.parse({
    id: id(8101),
    tenantId: tenant.id,
    code: "ANNUAL",
    name: "Cuti Tahunan",
    paid: true,
    requiresAttachment: false,
    policy: {
      annualDays: "12.0000",
      carryOverMaxDays: "5.0000",
      carryOverExpiryMonths: 3,
    },
    isActive: true,
  }),
  leaveTypeSchema.parse({
    id: id(8102),
    tenantId: tenant.id,
    code: "SICK",
    name: "Cuti Sakit",
    paid: true,
    requiresAttachment: true,
    policy: {
      annualDays: "12.0000",
      carryOverMaxDays: "0.0000",
      carryOverExpiryMonths: 0,
    },
    isActive: true,
  }),
  leaveTypeSchema.parse({
    id: id(8103),
    tenantId: tenant.id,
    code: "MARRIAGE",
    name: "Cuti Menikah",
    paid: true,
    requiresAttachment: true,
    policy: {
      annualDays: "3.0000",
      carryOverMaxDays: "0.0000",
      carryOverExpiryMonths: 0,
    },
    isActive: true,
  }),
  leaveTypeSchema.parse({
    id: id(8104),
    tenantId: tenant.id,
    code: "MATERNITY",
    name: "Cuti Melahirkan",
    paid: true,
    requiresAttachment: true,
    policy: {
      annualDays: "90.0000",
      carryOverMaxDays: "0.0000",
      carryOverExpiryMonths: 0,
    },
    isActive: true,
  }),
  leaveTypeSchema.parse({
    id: id(8105),
    tenantId: tenant.id,
    code: "BEREAVEMENT",
    name: "Cuti Duka",
    paid: true,
    requiresAttachment: false,
    policy: {
      annualDays: "3.0000",
      carryOverMaxDays: "0.0000",
      carryOverExpiryMonths: 0,
    },
    isActive: true,
  }),
  leaveTypeSchema.parse({
    id: id(8106),
    tenantId: tenant.id,
    code: "UNPAID",
    name: "Izin Tanpa Gaji",
    paid: false,
    requiresAttachment: false,
    policy: {
      annualDays: "0.0000",
      carryOverMaxDays: "0.0000",
      carryOverExpiryMonths: 0,
    },
    isActive: true,
  }),
];

const leaveBalances = [
  [1003, "12.0000", "2.0000", "3.0000", "0.0000"],
  [1004, "12.0000", "0.0000", "4.0000", "3.0000"],
  [1005, "12.0000", "1.0000", "2.0000", "0.0000"],
  [1006, "12.0000", "0.0000", "0.0000", "0.0000"],
  [1008, "12.0000", "3.0000", "5.0000", "2.0000"],
  [1012, "12.0000", "0.0000", "1.5000", "0.0000"],
  [1014, "12.0000", "2.0000", "2.0000", "0.0000"],
  [1015, "12.0000", "0.0000", "0.0000", "2.0000"],
].map(([employeeNo, entitled, carried, used, pending], index) =>
  leaveBalanceSchema.parse({
    id: id(8200 + index),
    tenantId: tenant.id,
    employeeId: id(Number(employeeNo)),
    leaveTypeId: id(8101),
    periodYear: 2026,
    entitledDays: entitled,
    carriedOverDays: carried,
    usedDays: used,
    pendingDays: pending,
  }),
);

const leaveRequests = [
  leaveRequestSchema.parse({
    id: id(8251),
    tenantId: tenant.id,
    employeeId: id(1004),
    leaveTypeId: id(8101),
    startDate: "2026-11-16",
    endDate: "2026-11-18",
    days: "3.0000",
    reason: "Acara keluarga di luar kota.",
    attachmentUrl: null,
    status: "pending",
    requestedAt: "2026-10-28T02:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
  }),
  leaveRequestSchema.parse({
    id: id(8252),
    tenantId: tenant.id,
    employeeId: id(1005),
    leaveTypeId: id(8101),
    startDate: "2026-10-12",
    endDate: "2026-10-13",
    days: "2.0000",
    reason: "Keperluan pribadi.",
    attachmentUrl: null,
    status: "approved",
    requestedAt: "2026-10-01T02:00:00.000Z",
    decidedBy: userId(1002),
    decidedAt: "2026-10-02T02:00:00.000Z",
  }),
  leaveRequestSchema.parse({
    id: id(8253),
    tenantId: tenant.id,
    employeeId: id(1006),
    leaveTypeId: id(8102),
    startDate: "2026-10-05",
    endDate: "2026-10-06",
    days: "2.0000",
    reason: "Demam dan surat dokter.",
    attachmentUrl:
      "https://files.cafelegend.example/leave/surat-dokter-1006.pdf",
    status: "approved",
    requestedAt: "2026-10-04T01:00:00.000Z",
    decidedBy: userId(1002),
    decidedAt: "2026-10-04T03:00:00.000Z",
  }),
  leaveRequestSchema.parse({
    id: id(8254),
    tenantId: tenant.id,
    employeeId: id(1008),
    leaveTypeId: id(8101),
    startDate: "2026-09-21",
    endDate: "2026-09-22",
    days: "2.0000",
    reason: null,
    attachmentUrl: null,
    status: "cancelled",
    requestedAt: "2026-09-10T02:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
  }),
];

const holidays = [
  [8301, "2026-01-01", "Tahun Baru 2026", "national"],
  [8302, "2026-03-19", "Hari Suci Nyepi", "national"],
  [8303, "2026-03-20", "Idul Fitri 1447 H", "national"],
  [8304, "2026-03-21", "Idul Fitri 1447 H (hari kedua)", "national"],
  [8305, "2026-04-03", "Wafat Isa Al Masih", "national"],
  [8306, "2026-05-01", "Hari Buruh Internasional", "national"],
  [8307, "2026-05-14", "Kenaikan Isa Al Masih", "national"],
  [8308, "2026-06-01", "Hari Lahir Pancasila", "national"],
  [8309, "2026-08-17", "Hari Kemerdekaan RI", "national"],
  [8310, "2026-12-25", "Hari Raya Natal", "national"],
  [8311, "2026-12-24", "Cuti bersama Natal", "collective"],
].map(([idNo, date, name, type]) =>
  holidaySchema.parse({
    id: id(Number(idNo)),
    tenantId: tenant.id,
    date,
    name,
    type,
    outletId: null,
  }),
);

const overtimeRequests = [
  overtimeRequestSchema.parse({
    id: id(8401),
    tenantId: tenant.id,
    employeeId: id(1004),
    outletId: outletA,
    date: "2026-10-30",
    minutes: 120,
    reason: "Persiapan event jazz malam.",
    dayType: "workday",
    formulaId: null,
    status: "pending",
    requestedAt: "2026-10-28T02:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
  }),
  overtimeRequestSchema.parse({
    id: id(8402),
    tenantId: tenant.id,
    employeeId: id(1008),
    outletId: outletA,
    date: "2026-10-24",
    minutes: 90,
    reason: "Stock opname dapur.",
    dayType: "workday",
    formulaId: null,
    status: "approved",
    requestedAt: "2026-10-22T02:00:00.000Z",
    decidedBy: userId(1001),
    decidedAt: "2026-10-23T02:00:00.000Z",
  }),
];

// ---- KPI, SOP, training, announcements ----------------------------------

const kpiDefinitions = [
  kpiDefinitionSchema.parse({
    id: id(8501),
    tenantId: tenant.id,
    positionId: id(positionIds.server),
    name: "Serving time",
    source: "system",
    metricCode: "serving_time_avg",
    target: "300.0000",
    unit: "detik",
    direction: "lower_is_better",
    isActive: true,
  }),
  kpiDefinitionSchema.parse({
    id: id(8502),
    tenantId: tenant.id,
    positionId: id(positionIds.cashier),
    name: "Selisih kas",
    source: "system",
    metricCode: "cash_variance",
    target: "0.0000",
    unit: "rupiah",
    direction: "lower_is_better",
    isActive: true,
  }),
  kpiDefinitionSchema.parse({
    id: id(8503),
    tenantId: tenant.id,
    positionId: null,
    name: "Kehadiran",
    source: "system",
    metricCode: "attendance_rate",
    target: "98.0000",
    unit: "%",
    direction: "higher_is_better",
    isActive: true,
  }),
  kpiDefinitionSchema.parse({
    id: id(8504),
    tenantId: tenant.id,
    positionId: id(positionIds.server),
    name: "Rating pelanggan",
    source: "system",
    metricCode: "customer_rating",
    target: "4.5000",
    unit: "bintang",
    direction: "higher_is_better",
    isActive: true,
  }),
  kpiDefinitionSchema.parse({
    id: id(8505),
    tenantId: tenant.id,
    positionId: null,
    name: "Penilaian atasan",
    source: "manager",
    metricCode: null,
    target: null,
    unit: "skor",
    direction: "higher_is_better",
    isActive: true,
  }),
];

const kpiReviews = [
  kpiReviewSchema.parse({
    id: id(8601),
    tenantId: tenant.id,
    employeeId: id(1012),
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    cycle: "monthly",
    scores: [
      {
        kpiDefinitionId: id(8501),
        actual: "285.0000",
        score: 90,
        systemActual: "285.0000",
        systemAvailability: null,
        actualSource: "system",
        comment: null,
      },
      {
        kpiDefinitionId: id(8503),
        actual: "99.0000",
        score: 95,
        systemActual: "99.0000",
        systemAvailability: null,
        actualSource: "system",
        comment: null,
      },
      {
        kpiDefinitionId: id(8504),
        actual: "4.7000",
        score: 94,
        systemActual: "4.7000",
        systemAvailability: null,
        actualSource: "system",
        comment: null,
      },
    ],
    reviewerId: userId(1011),
    status: "submitted",
    submittedAt: "2026-11-01T01:00:00.000Z",
    note: null,
    overallScore: 93,
  }),
];

const sopDocuments = [
  sopDocumentSchema.parse({
    id: id(8701),
    tenantId: tenant.id,
    stationId: null,
    positionId: id(positionIds.barista),
    title: "SOP Barista — Dasar",
    version: 1,
    body: "1. Kalibrasi grinder setiap pagi.\n2. Cek suhu air 92–94 °C.\n3. Bersihkan steam wand setelah setiap pitcher.",
    mediaIds: [],
    requiresAcknowledgement: true,
    effectiveFrom: "2026-01-15",
    publishedAt: "2026-01-10T02:00:00.000Z",
    supersedesId: null,
  }),
  sopDocumentSchema.parse({
    id: id(8702),
    tenantId: tenant.id,
    stationId: null,
    positionId: id(positionIds.barista),
    title: "SOP Barista — Dasar",
    version: 2,
    body: "1. Kalibrasi grinder setiap pagi dan catat di log.\n2. Cek suhu air 92–94 °C.\n3. Bersihkan steam wand setelah setiap pitcher.\n4. Tutup shift dengan backflush.",
    mediaIds: [],
    requiresAcknowledgement: true,
    effectiveFrom: "2026-10-01",
    publishedAt: "2026-09-25T02:00:00.000Z",
    supersedesId: id(8701),
  }),
  sopDocumentSchema.parse({
    id: id(8703),
    tenantId: tenant.id,
    stationId: null,
    positionId: id(positionIds.cook),
    title: "SOP Dapur — Keamanan Pangan",
    version: 1,
    body: "Simpan bahan dingin di bawah 4 °C, beri label tanggal, dan catat suhu dua kali sehari.",
    mediaIds: [],
    requiresAcknowledgement: true,
    effectiveFrom: "2026-02-01",
    publishedAt: "2026-01-28T02:00:00.000Z",
    supersedesId: null,
  }),
  sopDocumentSchema.parse({
    id: id(8704),
    tenantId: tenant.id,
    stationId: null,
    positionId: id(positionIds.cashier),
    title: "SOP Kasir — Buka dan Tutup Shift",
    version: 1,
    body: "Hitung float awal, catat cash in/out dengan alasan, lalu lakukan blind count saat tutup.",
    mediaIds: [],
    requiresAcknowledgement: false,
    effectiveFrom: "2026-03-01",
    publishedAt: "2026-02-25T02:00:00.000Z",
    supersedesId: null,
  }),
];

const sopAcknowledgements = [
  sopAcknowledgementSchema.parse({
    id: id(8801),
    tenantId: tenant.id,
    sopDocumentId: id(8702),
    employeeId: id(1004),
    documentVersion: 2,
    acknowledgedAt: "2026-10-02T02:00:00.000Z",
  }),
  sopAcknowledgementSchema.parse({
    id: id(8802),
    tenantId: tenant.id,
    sopDocumentId: id(8701),
    employeeId: id(1005),
    documentVersion: 1,
    acknowledgedAt: "2026-02-02T02:00:00.000Z",
  }),
];

const trainings = [
  trainingSchema.parse({
    id: id(8901),
    tenantId: tenant.id,
    title: "Dasar Barista",
    description: "Espresso, susu, dan kebersihan bar untuk barista baru.",
    stationId: null,
    positionId: id(positionIds.barista),
    questions: [
      {
        id: id(8911),
        prompt: "Suhu air espresso yang dianjurkan?",
        options: ["80–84 °C", "92–94 °C", "98–100 °C"],
        points: 2,
      },
      {
        id: id(8912),
        prompt: "Berapa gram dosis espresso untuk satu shot ganda?",
        options: ["8–10 g", "14–16 g", "18–20 g"],
        points: 2,
      },
      {
        id: id(8913),
        prompt: "Kapan steam wand dibersihkan?",
        options: [
          "Setiap tutup shift",
          "Setelah setiap pitcher",
          "Sekali sehari",
        ],
        points: 1,
      },
    ],
    passingScore: 70,
    validityMonths: 12,
    scheduledStart: "2026-10-20T01:00:00.000Z",
    scheduledEnd: "2026-10-20T05:00:00.000Z",
  }),
  trainingSchema.parse({
    id: id(8902),
    tenantId: tenant.id,
    title: "Keamanan Pangan",
    description: "Suhu penyimpanan, label, dan kebersihan area dapur.",
    stationId: null,
    positionId: id(positionIds.cook),
    questions: [
      {
        id: id(8921),
        prompt: "Batas suhu penyimpanan bahan dingin?",
        options: ["Di bawah 4 °C", "Di bawah 10 °C", "Di bawah 15 °C"],
        points: 3,
      },
      {
        id: id(8922),
        prompt: "Berapa kali suhu chiller dicatat setiap hari?",
        options: ["Sekali", "Dua kali", "Seminggu sekali"],
        points: 2,
      },
    ],
    passingScore: 80,
    validityMonths: 12,
    scheduledStart: null,
    scheduledEnd: null,
  }),
  trainingSchema.parse({
    id: id(8903),
    tenantId: tenant.id,
    title: "Layanan Pelanggan",
    description: "Menyambut tamu, menangani komplain, dan standar komunikasi.",
    stationId: null,
    positionId: null,
    questions: [
      {
        id: id(8931),
        prompt: "Langkah pertama saat menerima komplain?",
        options: [
          "Membela diri",
          "Mendengarkan dan meminta maaf",
          "Memanggil manajer",
        ],
        points: 2,
      },
      {
        id: id(8932),
        prompt: "Waktu maksimal menyambut tamu yang duduk?",
        options: ["1 menit", "5 menit", "10 menit"],
        points: 1,
      },
    ],
    passingScore: 75,
    validityMonths: 0,
    scheduledStart: null,
    scheduledEnd: null,
  }),
];

const trainingAnswerKeys = [
  {
    trainingId: id(8901),
    answers: [
      { questionId: id(8911), correctOptionIndex: 1 },
      { questionId: id(8912), correctOptionIndex: 2 },
      { questionId: id(8913), correctOptionIndex: 1 },
    ],
  },
  {
    trainingId: id(8902),
    answers: [
      { questionId: id(8921), correctOptionIndex: 0 },
      { questionId: id(8922), correctOptionIndex: 1 },
    ],
  },
  {
    trainingId: id(8903),
    answers: [
      { questionId: id(8931), correctOptionIndex: 1 },
      { questionId: id(8932), correctOptionIndex: 0 },
    ],
  },
].map((key) => trainingAnswerKeySchema.parse(key));

const trainingCompletions = [
  trainingCompletionSchema.parse({
    id: id(8951),
    tenantId: tenant.id,
    employeeId: id(1004),
    trainingId: id(8901),
    score: 85,
    passed: true,
    completedAt: "2026-10-20T05:30:00.000Z",
    expiresOn: "2027-10-20",
    attempts: 1,
  }),
  trainingCompletionSchema.parse({
    id: id(8952),
    tenantId: tenant.id,
    employeeId: id(1005),
    trainingId: id(8902),
    score: 60,
    passed: false,
    completedAt: "2026-10-21T05:30:00.000Z",
    expiresOn: null,
    attempts: 2,
  }),
];

const announcements = [
  announcementSchema.parse({
    id: id(9101),
    tenantId: tenant.id,
    title: "Pembaruan SOP Bar versi 2",
    body: "SOP Barista versi 2 berlaku 1 Oktober 2026. Mohon baca dan konfirmasi sebelum shift berikutnya.",
    audience: { kind: "all" },
    requiresReceipt: true,
    publishedBy: userId(1024),
    publishedAt: "2026-09-25T03:00:00.000Z",
    expiresAt: null,
  }),
  announcementSchema.parse({
    id: id(9102),
    tenantId: tenant.id,
    title: "Persiapan preopening Bandung 2",
    body: "Tim outlet Bandung 2 berkumpul Senin 09.00 di lokasi untuk walkthrough.",
    audience: { kind: "outlets", outletIds: [outletB] },
    requiresReceipt: false,
    publishedBy: userId(1019),
    publishedAt: "2026-10-24T02:00:00.000Z",
    expiresAt: fixtureTimeAfter({ days: 9, hours: 8 }, now),
  }),
  announcementSchema.parse({
    id: id(9103),
    tenantId: tenant.id,
    title: "Jadwal libur akhir tahun",
    body: "Pengajuan cuti akhir tahun dibuka sampai 15 November 2026.",
    audience: { kind: "outlets", outletIds: [outletA] },
    requiresReceipt: true,
    publishedBy: userId(1024),
    publishedAt: "2026-10-30T02:00:00.000Z",
    expiresAt: fixtureTimeAfter({ days: 14, hours: 8 }, now),
  }),
];

const announcementReceipts = [
  announcementReceiptSchema.parse({
    id: id(9201),
    tenantId: tenant.id,
    announcementId: id(9101),
    employeeId: id(1004),
    readAt: "2026-09-26T02:00:00.000Z",
    acknowledgedAt: "2026-09-26T02:01:00.000Z",
  }),
  announcementReceiptSchema.parse({
    id: id(9202),
    tenantId: tenant.id,
    announcementId: id(9101),
    employeeId: id(1005),
    readAt: "2026-09-27T02:00:00.000Z",
    acknowledgedAt: null,
  }),
];

// ---- Event envelopes -----------------------------------------------------

const admittedActor = { type: "user" as const, id: userId(1001) };

const attendanceEvent = attendanceLogged.envelopeSchema.parse({
  id: ulid(201),
  tenantId: tenant.id,
  outletId: outletA,
  name: "attendance.logged",
  version: 1,
  aggregateType: "attendance",
  aggregateId: ulid(100),
  sequence: 1,
  occurredAt: "2026-10-26T00:55:00.000Z",
  actor: admittedActor,
  deviceId: null,
  idempotencyKey: "attendance-1003-20261026-in",
  payloadSchemaRef: "attendance.logged.v1",
  payload: {
    attendanceLogId: ulid(100),
    employeeId: id(1003),
    outletId: outletA,
    type: "in",
    method: "selfie_geo",
    occurredAt: "2026-10-26T00:50:00.000Z",
    validity: "valid",
    shiftAssignmentId: id(7301),
  },
});

const shiftEvent = shiftPublished.envelopeSchema.parse({
  id: ulid(202),
  tenantId: tenant.id,
  outletId: outletA,
  name: "shift.published",
  version: 1,
  aggregateType: "shift",
  aggregateId: id(7301),
  sequence: 1,
  occurredAt: publishedAt,
  actor: admittedActor,
  deviceId: null,
  idempotencyKey: "roster-2026-10-26-bdg-01-1003",
  payloadSchemaRef: "shift.published.v1",
  payload: {
    shiftAssignmentId: id(7301),
    employeeId: id(1003),
    outletId: outletA,
    shiftTemplateId: id(8001),
    stationId: null,
    businessDate: weekOne,
    segments: [
      {
        startsAt: `${weekOne}T08:00:00+07:00`,
        endsAt: `${weekOne}T16:00:00+07:00`,
      },
    ],
    publishedBy,
    publishedAt,
  },
});

const shiftCancelledEvent = shiftCancelled.envelopeSchema.parse({
  id: ulid(204),
  tenantId: tenant.id,
  outletId: outletA,
  name: "shift.cancelled",
  version: 1,
  aggregateType: "shift",
  aggregateId: id(7301),
  sequence: 2,
  occurredAt: publishedAt,
  actor: admittedActor,
  deviceId: null,
  idempotencyKey: "shift.cancelled:roster-2026-10-26-bdg-01-1003:2",
  payloadSchemaRef: "shift.cancelled.v1",
  payload: {
    shiftAssignmentId: id(7301),
    employeeId: id(1003),
    outletId: outletA,
    businessDate: weekOne,
    cause: "cancelled",
    cancelledBy: publishedBy,
    cancelledAt: publishedAt,
  },
});

const leaveEvent = leaveApproved.envelopeSchema.parse({
  id: ulid(203),
  tenantId: tenant.id,
  outletId: outletA,
  name: "leave.approved",
  version: 1,
  aggregateType: "leave",
  aggregateId: id(8252),
  sequence: 1,
  occurredAt: "2026-10-02T02:00:00.000Z",
  actor: { type: "user", id: userId(1002) },
  deviceId: null,
  idempotencyKey: "leave-approved-8252",
  payloadSchemaRef: "leave.approved.v1",
  payload: {
    leaveRequestId: id(8252),
    employeeId: id(1005),
    leaveTypeId: id(8101),
    startDate: "2026-10-12",
    endDate: "2026-10-13",
    days: "2.0000",
    decidedBy: userId(1002),
    decidedAt: "2026-10-02T02:00:00.000Z",
  },
});

const leaveChangedEvent = leaveChanged.envelopeSchema.parse({
  id: ulid(204),
  tenantId: tenant.id,
  outletId: outletA,
  name: "leave.changed",
  version: 1,
  aggregateType: "leave",
  aggregateId: id(8252),
  sequence: 2,
  occurredAt: "2026-10-12T02:00:00.000Z",
  actor: { type: "user", id: userId(1024) },
  deviceId: null,
  idempotencyKey: "leave.changed:8252:2",
  payloadSchemaRef: "leave.changed.v1",
  payload: {
    leaveRequestId: id(8252),
    employeeId: id(1005),
    outletId: outletA,
    startDate: "2026-10-12",
    endDate: "2026-10-12",
    days: "1.0000",
    excludedHolidayDates: [],
    status: "approved",
    changeReason: "range_split",
    splitFromLeaveRequestId: null,
  },
});

const leaveRedeductedAfterSettlementEvent =
  leaveRedeductedAfterSettlement.envelopeSchema.parse({
    id: ulid(205),
    tenantId: tenant.id,
    outletId: outletA,
    name: "leave.rededucted_after_settlement",
    version: 1,
    aggregateType: "leave",
    aggregateId: id(8253),
    sequence: 1,
    occurredAt: "2026-10-13T02:00:00.000Z",
    actor: { type: "user", id: userId(1024) },
    deviceId: null,
    idempotencyKey: "leave.rededucted_after_settlement:8253",
    payloadSchemaRef: "leave.rededucted_after_settlement.v1",
    payload: {
      offboardingId: id(8601),
      employeeId: id(1005),
      outletId: outletA,
      date: "2026-10-12",
      periodYear: 2026,
      days: "1.0000",
    },
  });

// ---- Whole-fixture schema ------------------------------------------------

export const employeePiiFixtureSchema = z.strictObject({
  employeeId: employeeIdSchema,
  pii: employeePiiSchema,
});
export type EmployeePiiFixture = z.infer<typeof employeePiiFixtureSchema>;

export const hrisFixtureSchema = z.strictObject({
  orgUnits: z.array(orgUnitSchema),
  grades: z.array(positionGradeSchema),
  positions: z.array(positionSchema),
  employees: z.array(employeeSchema),
  employeePii: z.array(employeePiiFixtureSchema),
  employeeDetails: z.array(employeeDetailSchema),
  contracts: z.array(employmentContractSchema),
  documents: z.array(employeeDocumentSchema),
  checklistTemplates: z.array(checklistTemplateSchema),
  checklistTasks: z.array(checklistTaskSchema),
  attendancePolicy: attendancePolicySchema,
  attendanceQr: attendanceQrTokenSchema,
  attendanceLogs: z.array(attendanceLogSchema),
  attendanceCorrections: z.array(attendanceCorrectionSchema),
  shiftTemplates: z.array(shiftTemplateSchema),
  shiftAssignments: z.array(shiftAssignmentSchema),
  shiftCompliancePolicy: shiftCompliancePolicySchema,
  shiftSwapRequests: z.array(shiftSwapRequestSchema),
  leaveTypes: z.array(leaveTypeSchema),
  leaveBalances: z.array(leaveBalanceSchema),
  leaveRequests: z.array(leaveRequestSchema),
  holidays: z.array(holidaySchema),
  overtimeRequests: z.array(overtimeRequestSchema),
  kpiDefinitions: z.array(kpiDefinitionSchema),
  kpiReviews: z.array(kpiReviewSchema),
  sopDocuments: z.array(sopDocumentSchema),
  sopAcknowledgements: z.array(sopAcknowledgementSchema),
  trainings: z.array(trainingSchema),
  trainingCompletions: z.array(trainingCompletionSchema),
  announcements: z.array(announcementSchema),
  announcementReceipts: z.array(announcementReceiptSchema),
});
export type HrisFixture = z.infer<typeof hrisFixtureSchema>;

export const cafeLegendHrisFixtures = {
  tenant,
  outlets,
  /** Server-resolved "now" the fixtures were authored against. */
  now,
  orgUnits,
  grades,
  positions,
  employees,
  employeePii: employeePiiRows,
  employeeDetails,
  contracts,
  documents,
  checklistTemplates,
  checklistTasks,
  attendancePolicy,
  attendanceQr,
  attendanceLogs,
  attendanceCorrections,
  shiftTemplates,
  shiftAssignments,
  shiftCompliancePolicy,
  shiftSwapRequests,
  leaveTypes,
  leaveBalances,
  leaveRequests,
  holidays,
  overtimeRequests,
  kpiDefinitions,
  kpiReviews,
  sopDocuments,
  sopAcknowledgements,
  trainings,
  trainingAnswerKeys,
  trainingCompletions,
  announcements,
  announcementReceipts,
  events: {
    attendanceLogged: attendanceEvent,
    shiftPublished: shiftEvent,
    shiftCancelled: shiftCancelledEvent,
    leaveApproved: leaveEvent,
    leaveChanged: leaveChangedEvent,
    leaveRedeductedAfterSettlement: leaveRedeductedAfterSettlementEvent,
  },
  userIds: {
    outletManager: userId(1001),
    assistantManager: userId(1002),
    hrAdmin: userId(1024),
  },
} as const;
