// Dashboard tile catalog (WS-11 CT, bead legend-mmjb; PRD v1.7 §3.34 Dashboard
// Owner, §3.35 Dashboard Shareholder, §3.36 Dashboard Manajemen, DASH-01,
// DASH-02, DASH-03, SH-02).
//
// Every number on a dashboard is a `metric` tile: it cites the registry codes
// it shows, the period preset it defaults to, and the source report it drills
// into (DASH-01). The tile never computes a figure itself, so the source
// report and the tile read the same registry row and cannot disagree
// (DASH-02). Lists (approvals, kitchen queue, reviews, documents) are `queue`
// tiles; shareholder personal share is a `personal_share` tile fed by the
// accounting profit-share contract (SH-01); navigation cards are `link` tiles.
//
// Shareholder tiles are `closedPeriodOnly`: official figures come only from
// closed periods and anything inside an open period is labelled an estimate
// (SH-02). The web app renders these definitions mobile-first (DASH-03).

import {
  businessDateSchema,
  clientInputSchema,
  isoDateTimeSchema,
  outletIdSchema,
  z,
} from "../core/index.ts";
import {
  metricBucketSchema,
  metricCodeSchema,
  metricPeriodSchema,
  reportCodeSchema,
} from "../metrics/index.ts";
import type { MetricFinality } from "../metrics/index.ts";
import { permissionCodeSchema } from "../access/index.ts";
import { reportPeriodPresetSchema } from "./reports.ts";
import type { ReportPeriodPreset } from "./reports.ts";

// ---- Vocabulary ------------------------------------------------------------

export const DASHBOARD_KINDS = ["owner", "shareholder", "management"] as const;
export const dashboardKindSchema = z.enum(DASHBOARD_KINDS);
export type DashboardKind = z.infer<typeof dashboardKindSchema>;

/** Roles the management home adapts to (PRD §3.36 "Beranda per Role"). */
export const MANAGEMENT_ROLES = [
  "gm",
  "outlet_manager",
  "kitchen_lead",
  "purchasing",
  "finance",
  "hr",
  "marketing",
] as const;
export const managementRoleSchema = z.enum(MANAGEMENT_ROLES);
export type ManagementRole = z.infer<typeof managementRoleSchema>;

export const DASHBOARD_SECTIONS = [
  "realtime_summary",
  "operations",
  "shower",
  "cost_margin",
  "seats_wfc",
  "service_quality",
  "finance",
  "alerts",
  "daily_summary",
  "multi_outlet",
  "business_condition",
  "personal_share",
  "documents",
  "work_queue",
  "approvals",
  "reports",
] as const;
export const dashboardSectionSchema = z.enum(DASHBOARD_SECTIONS);
export type DashboardSection = z.infer<typeof dashboardSectionSchema>;

const SECTIONS_BY_DASHBOARD: Record<
  DashboardKind,
  readonly DashboardSection[]
> = {
  owner: [
    "realtime_summary",
    "operations",
    "shower",
    "cost_margin",
    "seats_wfc",
    "service_quality",
    "finance",
    "alerts",
    "daily_summary",
    "multi_outlet",
  ],
  shareholder: ["business_condition", "personal_share", "documents"],
  management: ["work_queue", "approvals", "reports"],
};

/** Section labels for the app chrome (text comes from the i18n catalog). */
export const DASHBOARD_SECTION_INFO = {
  realtime_summary: { label: "Ringkasan real-time" },
  operations: { label: "Operasional" },
  shower: { label: "Shower room" },
  cost_margin: { label: "Biaya & margin" },
  seats_wfc: { label: "Kursi & WFC" },
  service_quality: { label: "Kualitas layanan" },
  finance: { label: "Keuangan" },
  alerts: { label: "Peringatan" },
  daily_summary: { label: "Ringkasan harian" },
  multi_outlet: { label: "Multi-outlet" },
  business_condition: { label: "Kondisi bisnis" },
  personal_share: { label: "Bagi hasil pribadi" },
  documents: { label: "Dokumen" },
  work_queue: { label: "Antrean kerja" },
  approvals: { label: "Kotak approval" },
  reports: { label: "Laporan" },
} as const satisfies Record<DashboardSection, { label: string }>;

/** What a metric tile is compared against (PRD §3.34 "Ringkasan Real-time"). */
export const DASHBOARD_TILE_COMPARISONS = [
  "none",
  "previous_period",
  "target",
  "multi_outlet",
] as const;
export const dashboardTileComparisonSchema = z.enum(DASHBOARD_TILE_COMPARISONS);
export type DashboardTileComparison = z.infer<
  typeof dashboardTileComparisonSchema
>;

/** Item lists a queue tile renders; the BE endpoint supplies the rows. */
export const DASHBOARD_QUEUES = [
  "approvals",
  "kitchen_queue",
  "waiter_calls",
  "reviews",
  "alerts",
  "critical_stock",
  "devices",
  "documents",
  "daily_summary",
  "facility_units",
] as const;
export const dashboardQueueSchema = z.enum(DASHBOARD_QUEUES);
export type DashboardQueue = z.infer<typeof dashboardQueueSchema>;

const tileKeySchema = z
  .string()
  .min(3)
  .max(80)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/,
    "Tile keys look like owner.today_sales",
  );

const tilePathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (path) => path.startsWith("/") && !/[?#]/.test(path),
    "Tile paths are app-relative paths without a query or fragment",
  );

// ---- Tile schemas ----------------------------------------------------------

const tileBaseShape = {
  key: tileKeySchema,
  dashboard: dashboardKindSchema,
  section: dashboardSectionSchema,
  title: z.string().min(1).max(120),
  /** Set for the role-specific management home; null on other dashboards. */
  managerRole: managementRoleSchema.nullable().default(null),
  /** Extra permissions the tile needs beyond the dashboard area guard. */
  requiredPermissions: z.array(permissionCodeSchema).max(4).default([]),
};

function refineTileBase(
  tile: {
    dashboard: DashboardKind;
    section: DashboardSection;
    managerRole: ManagementRole | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (!SECTIONS_BY_DASHBOARD[tile.dashboard].includes(tile.section))
    ctx.addIssue({
      code: "custom",
      message: `Section ${tile.section} does not belong to the ${tile.dashboard} dashboard`,
      path: ["section"],
    });
  // A management tile may serve one role or, with a null role, every
  // management home (the approval inbox and the reports/audit links).
  if (tile.dashboard !== "management" && tile.managerRole !== null)
    ctx.addIssue({
      code: "custom",
      message: "Only management tiles carry a managerRole",
      path: ["managerRole"],
    });
}

export const metricDashboardTileSchema = z
  .strictObject({
    ...tileBaseShape,
    kind: z.literal("metric"),
    /** Registry codes this tile shows; every number cites a definition. */
    metricCodes: z.array(metricCodeSchema).min(1).max(6),
    /** DASH-01 drill-down: the standard report that produced the number. */
    reportCode: reportCodeSchema,
    period: reportPeriodPresetSchema,
    bucket: metricBucketSchema.default("day"),
    comparison: dashboardTileComparisonSchema.default("none"),
    /**
     * SH-02: official figures only from closed periods. The server labels an
     * open-period value an estimate and never returns `final` for it.
     */
    closedPeriodOnly: z.boolean().default(false),
  })
  .superRefine((tile, ctx) => {
    refineTileBase(tile, ctx);
    if (new Set(tile.metricCodes).size !== tile.metricCodes.length)
      ctx.addIssue({
        code: "custom",
        message: "Tile metricCodes repeat a code",
        path: ["metricCodes"],
      });
    if (tile.comparison === "target" && tile.metricCodes.length < 1)
      ctx.addIssue({
        code: "custom",
        message: "A target comparison needs the metric it targets",
        path: ["comparison"],
      });
  });
export type MetricDashboardTile = z.infer<typeof metricDashboardTileSchema>;

export const queueDashboardTileSchema = z
  .strictObject({
    ...tileBaseShape,
    kind: z.literal("queue"),
    queue: dashboardQueueSchema,
    /** Optional drill-down report for the queue's backing numbers. */
    reportCode: reportCodeSchema.nullable().default(null),
  })
  .superRefine(refineTileBase);
export type QueueDashboardTile = z.infer<typeof queueDashboardTileSchema>;

/** Shareholder personal share; data comes from the accounting contract (SH-01). */
export const personalShareDashboardTileSchema = z
  .strictObject({
    ...tileBaseShape,
    kind: z.literal("personal_share"),
  })
  .superRefine(refineTileBase);
export type PersonalShareDashboardTile = z.infer<
  typeof personalShareDashboardTileSchema
>;

export const linkDashboardTileSchema = z
  .strictObject({
    ...tileBaseShape,
    kind: z.literal("link"),
    targetPath: tilePathSchema,
    reportCode: reportCodeSchema.nullable().default(null),
  })
  .superRefine(refineTileBase);
export type LinkDashboardTile = z.infer<typeof linkDashboardTileSchema>;

export const dashboardTileSchema = z.discriminatedUnion("kind", [
  metricDashboardTileSchema,
  queueDashboardTileSchema,
  personalShareDashboardTileSchema,
  linkDashboardTileSchema,
]);
export type DashboardTile = z.infer<typeof dashboardTileSchema>;

/** GET /api/dashboards/:dashboard — resolved layout for the caller's scope. */
export const dashboardLayoutSchema = z.strictObject({
  dashboard: dashboardKindSchema,
  title: z.string().min(1).max(120),
  /** The outlet business date the monitoring values describe. */
  businessDate: businessDateSchema,
  /** Outlets the server actually queried, after the TEN-03 scope check. */
  availableOutlets: z.array(outletIdSchema).min(1),
  tiles: z.array(dashboardTileSchema).min(1),
  generatedAt: isoDateTimeSchema,
  /** Period the monitoring tiles describe, resolved server-side. */
  monitoringPeriod: metricPeriodSchema,
});
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

export const dashboardQuerySchema = clientInputSchema({
  outletIds: z.array(outletIdSchema).min(1).max(50).optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

// ---- Tile catalog ----------------------------------------------------------

type TileBaseSeed = {
  key: string;
  dashboard: DashboardKind;
  section: DashboardSection;
  title: string;
  managerRole?: ManagementRole | null;
  requiredPermissions?: readonly string[];
};

type MetricTileSeed = TileBaseSeed & {
  metricCodes: readonly string[];
  reportCode: string;
  period?: ReportPeriodPreset;
  bucket?: "day" | "week" | "month" | "quarter" | "year" | "total";
  comparison?: DashboardTileComparison;
  closedPeriodOnly?: boolean;
};

function metricTile(seed: MetricTileSeed): MetricDashboardTile {
  return metricDashboardTileSchema.parse({
    ...seed,
    managerRole: seed.managerRole ?? null,
    requiredPermissions: seed.requiredPermissions ?? [],
    kind: "metric",
    period: seed.period ?? "today",
    bucket: seed.bucket ?? "day",
    comparison: seed.comparison ?? "none",
    closedPeriodOnly: seed.closedPeriodOnly ?? false,
  });
}

function queueTile(
  seed: TileBaseSeed & {
    queue: DashboardQueue;
    reportCode?: string | null;
  },
): QueueDashboardTile {
  return queueDashboardTileSchema.parse({
    ...seed,
    managerRole: seed.managerRole ?? null,
    requiredPermissions: seed.requiredPermissions ?? [],
    kind: "queue",
    reportCode: seed.reportCode ?? null,
  });
}

function personalShareTile(seed: TileBaseSeed): PersonalShareDashboardTile {
  return personalShareDashboardTileSchema.parse({
    ...seed,
    managerRole: seed.managerRole ?? null,
    requiredPermissions: seed.requiredPermissions ?? [],
    kind: "personal_share",
  });
}

function linkTile(
  seed: TileBaseSeed & { targetPath: string; reportCode?: string | null },
): LinkDashboardTile {
  return linkDashboardTileSchema.parse({
    ...seed,
    managerRole: seed.managerRole ?? null,
    requiredPermissions: seed.requiredPermissions ?? [],
    kind: "link",
    reportCode: seed.reportCode ?? null,
  });
}

const OWNER_TILES: readonly DashboardTile[] = [
  // Ringkasan real-time
  metricTile({
    key: "owner.today_sales",
    dashboard: "owner",
    section: "realtime_summary",
    title: "Penjualan hari ini vs target",
    metricCodes: ["net_sales", "sales_target", "target_achievement_pct"],
    reportCode: "sales.target",
    comparison: "target",
  }),
  metricTile({
    key: "owner.pax_today",
    dashboard: "owner",
    section: "realtime_summary",
    title: "Tamu dan belanja per tamu",
    metricCodes: ["pax", "avg_spend_per_pax"],
    reportCode: "traffic.pax",
    comparison: "previous_period",
  }),
  metricTile({
    key: "owner.transactions_today",
    dashboard: "owner",
    section: "realtime_summary",
    title: "Transaksi dan nilai rata-rata",
    metricCodes: ["transaction_count", "avg_ticket"],
    reportCode: "sales.transactions",
    comparison: "previous_period",
  }),
  metricTile({
    key: "owner.table_occupancy",
    dashboard: "owner",
    section: "realtime_summary",
    title: "Okupansi meja dan table turnover",
    metricCodes: ["table_occupancy_pct", "table_turnover"],
    reportCode: "operations.table_turnover",
  }),
  metricTile({
    key: "owner.sales_by_channel",
    dashboard: "owner",
    section: "realtime_summary",
    title: "Penjualan per kanal",
    metricCodes: ["net_sales", "pax"],
    reportCode: "sales.per_channel",
  }),

  // Operasional
  metricTile({
    key: "owner.serving_time",
    dashboard: "owner",
    section: "operations",
    title: "Waktu saji per stasiun",
    metricCodes: ["avg_serving_time"],
    reportCode: "operations.serving_time",
  }),
  metricTile({
    key: "owner.best_sellers",
    dashboard: "owner",
    section: "operations",
    title: "Menu terlaris",
    metricCodes: ["menu_sold_qty"],
    reportCode: "menu.best_sellers",
  }),
  metricTile({
    key: "owner.sold_out",
    dashboard: "owner",
    section: "operations",
    title: "Menu habis",
    metricCodes: ["sold_out_menu_count"],
    reportCode: "menu.sold_out",
  }),
  queueTile({
    key: "owner.kitchen_queue",
    dashboard: "owner",
    section: "operations",
    title: "Antrean dapur saat ini",
    queue: "kitchen_queue",
    reportCode: "operations.kitchen_queue",
  }),
  queueTile({
    key: "owner.waiter_calls",
    dashboard: "owner",
    section: "operations",
    title: "Panggilan waiter belum ditangani",
    queue: "waiter_calls",
    reportCode: "operations.waiter_calls",
  }),
  metricTile({
    key: "owner.review_rating",
    dashboard: "owner",
    section: "operations",
    title: "Rating ulasan",
    metricCodes: ["review_rating", "review_count"],
    reportCode: "crm.reviews",
  }),
  queueTile({
    key: "owner.latest_reviews",
    dashboard: "owner",
    section: "operations",
    title: "Ulasan terbaru",
    queue: "reviews",
    reportCode: "crm.reviews",
  }),

  // Shower room
  queueTile({
    key: "owner.shower_status",
    dashboard: "owner",
    section: "shower",
    title: "Status bilik saat ini",
    queue: "facility_units",
    reportCode: "facility.occupancy",
  }),
  metricTile({
    key: "owner.shower_utilization",
    dashboard: "owner",
    section: "shower",
    title: "Utilisasi shower hari ini",
    metricCodes: ["shower_occupancy_pct", "shower_sessions"],
    reportCode: "facility.occupancy",
  }),
  metricTile({
    key: "owner.shower_revenue",
    dashboard: "owner",
    section: "shower",
    title: "Pendapatan fasilitas",
    metricCodes: ["shower_revenue"],
    reportCode: "facility.revenue",
  }),
  metricTile({
    key: "owner.shower_subscriptions",
    dashboard: "owner",
    section: "shower",
    title: "Langganan aktif",
    metricCodes: ["active_subscriptions"],
    reportCode: "facility.subscriptions",
  }),
  metricTile({
    key: "owner.shower_fnb_conversion",
    dashboard: "owner",
    section: "shower",
    title: "Konversi shower ke F&B",
    metricCodes: ["shower_fnb_conversion_pct"],
    reportCode: "facility.fnb_conversion",
  }),

  // Biaya & margin
  metricTile({
    key: "owner.food_cost",
    dashboard: "owner",
    section: "cost_margin",
    title: "Food cost",
    metricCodes: ["food_cost_pct"],
    reportCode: "inventory.food_cost",
    period: "this_month",
    comparison: "previous_period",
    closedPeriodOnly: true,
  }),
  metricTile({
    key: "owner.labor_cost",
    dashboard: "owner",
    section: "cost_margin",
    title: "Labor cost",
    metricCodes: ["labor_cost_pct"],
    reportCode: "payroll.labor_cost",
    period: "this_month",
    comparison: "previous_period",
    closedPeriodOnly: true,
  }),
  metricTile({
    key: "owner.prime_cost",
    dashboard: "owner",
    section: "cost_margin",
    title: "Prime cost",
    metricCodes: ["prime_cost_pct"],
    reportCode: "finance.prime_cost",
    period: "this_month",
    comparison: "previous_period",
    closedPeriodOnly: true,
  }),
  metricTile({
    key: "owner.waste",
    dashboard: "owner",
    section: "cost_margin",
    title: "Waste",
    metricCodes: ["waste_cost", "waste_cost_pct"],
    reportCode: "inventory.waste",
    period: "this_month",
  }),
  metricTile({
    key: "owner.promo_cost",
    dashboard: "owner",
    section: "cost_margin",
    title: "Biaya promo",
    metricCodes: ["promo_cost"],
    reportCode: "crm.promo_cost",
    period: "this_month",
  }),

  // Kursi & WFC
  metricTile({
    key: "owner.zone_occupancy",
    dashboard: "owner",
    section: "seats_wfc",
    title: "Okupansi kursi per zona",
    metricCodes: ["seat_occupancy_pct"],
    reportCode: "facility.revpash",
  }),
  metricTile({
    key: "owner.revpash",
    dashboard: "owner",
    section: "seats_wfc",
    title: "RevPASH",
    metricCodes: ["revpash"],
    reportCode: "facility.revpash",
  }),
  metricTile({
    key: "owner.dwell_vs_spend",
    dashboard: "owner",
    section: "seats_wfc",
    title: "Durasi duduk dibanding belanja",
    metricCodes: ["avg_dwell_minutes", "avg_spend_per_pax"],
    reportCode: "traffic.dwell_time",
  }),
  metricTile({
    key: "owner.wifi_usage",
    dashboard: "owner",
    section: "seats_wfc",
    title: "Pemakaian Wi-Fi",
    metricCodes: ["wifi_sessions", "wifi_quota_used"],
    reportCode: "facility.wifi",
  }),

  // Kualitas layanan
  metricTile({
    key: "owner.failed_items",
    dashboard: "owner",
    section: "service_quality",
    title: "Item gagal setelah bayar",
    metricCodes: ["failed_item_count"],
    reportCode: "operations.failed_items",
  }),
  metricTile({
    key: "owner.remake_comp",
    dashboard: "owner",
    section: "service_quality",
    title: "Remake dan comp",
    metricCodes: ["remake_count", "comp_count"],
    reportCode: "operations.remake_comp",
  }),
  metricTile({
    key: "owner.apology_vouchers",
    dashboard: "owner",
    section: "service_quality",
    title: "Voucher permintaan maaf",
    metricCodes: ["apology_voucher_count"],
    reportCode: "operations.failed_items",
  }),
  metricTile({
    key: "owner.checklist_compliance",
    dashboard: "owner",
    section: "service_quality",
    title: "Kepatuhan checklist",
    metricCodes: ["checklist_compliance_pct"],
    reportCode: "performance.checklist",
  }),

  // Keuangan
  metricTile({
    key: "owner.cash_position",
    dashboard: "owner",
    section: "finance",
    title: "Posisi kas dan bank",
    metricCodes: ["cash_balance", "bank_balance"],
    reportCode: "finance.cash_position",
  }),
  metricTile({
    key: "owner.supplier_due",
    dashboard: "owner",
    section: "finance",
    title: "Utang supplier jatuh tempo",
    metricCodes: ["supplier_due"],
    reportCode: "finance.supplier_due",
  }),
  metricTile({
    key: "owner.pending_settlement",
    dashboard: "owner",
    section: "finance",
    title: "Settlement gateway tertunda",
    metricCodes: ["pending_settlement"],
    reportCode: "finance.pending_settlement",
  }),
  // PRD §3.34: running P&L is explicitly labelled an estimate, so the tile is
  // not closed-period-only; finality comes from the metric definition.
  metricTile({
    key: "owner.income_statement",
    dashboard: "owner",
    section: "finance",
    title: "Laba rugi berjalan (estimasi)",
    metricCodes: ["net_profit", "gross_profit"],
    reportCode: "finance.income_statement",
    period: "this_month",
    comparison: "previous_period",
  }),

  // Peringatan
  queueTile({
    key: "owner.alerts",
    dashboard: "owner",
    section: "alerts",
    title: "Anomali void, diskon, refund, dan selisih kas",
    queue: "alerts",
    reportCode: "operations.alerts",
  }),
  queueTile({
    key: "owner.critical_stock",
    dashboard: "owner",
    section: "alerts",
    title: "Stok kritis",
    queue: "critical_stock",
    reportCode: "inventory.critical_stock",
  }),
  queueTile({
    key: "owner.devices",
    dashboard: "owner",
    section: "alerts",
    title: "Perangkat outlet bermasalah",
    queue: "devices",
    reportCode: "operations.devices",
  }),

  // Ringkasan harian & multi-outlet
  queueTile({
    key: "owner.daily_summary",
    dashboard: "owner",
    section: "daily_summary",
    title: "Ringkasan tutup hari (AI-10)",
    queue: "daily_summary",
  }),
  metricTile({
    key: "owner.multi_outlet",
    dashboard: "owner",
    section: "multi_outlet",
    title: "Perbandingan antar-outlet",
    metricCodes: ["net_sales", "pax"],
    reportCode: "sales.per_channel",
    period: "this_month",
    comparison: "multi_outlet",
  }),
];

const SHAREHOLDER_TILES: readonly DashboardTile[] = [
  metricTile({
    key: "shareholder.revenue",
    dashboard: "shareholder",
    section: "business_condition",
    title: "Omzet",
    metricCodes: ["net_sales"],
    reportCode: "sales.daily",
    period: "last_month",
    bucket: "month",
    closedPeriodOnly: true,
  }),
  metricTile({
    key: "shareholder.gross_profit",
    dashboard: "shareholder",
    section: "business_condition",
    title: "Laba kotor",
    metricCodes: ["gross_profit"],
    reportCode: "finance.gross_margin",
    period: "last_month",
    bucket: "month",
    closedPeriodOnly: true,
  }),
  metricTile({
    key: "shareholder.ebitda",
    dashboard: "shareholder",
    section: "business_condition",
    title: "EBITDA",
    metricCodes: ["ebitda"],
    reportCode: "finance.ebitda",
    period: "last_month",
    bucket: "month",
    closedPeriodOnly: true,
  }),
  metricTile({
    key: "shareholder.net_profit",
    dashboard: "shareholder",
    section: "business_condition",
    title: "Laba bersih",
    metricCodes: ["net_profit"],
    reportCode: "finance.income_statement",
    period: "last_month",
    bucket: "month",
    closedPeriodOnly: true,
  }),
  metricTile({
    key: "shareholder.cash_position",
    dashboard: "shareholder",
    section: "business_condition",
    title: "Arus kas dan saldo kas",
    metricCodes: ["cash_balance", "bank_balance"],
    reportCode: "finance.cash_position",
    period: "last_month",
    bucket: "month",
    closedPeriodOnly: true,
  }),
  metricTile({
    key: "shareholder.pax",
    dashboard: "shareholder",
    section: "business_condition",
    title: "Jumlah pengunjung",
    metricCodes: ["pax", "avg_spend_per_pax"],
    reportCode: "traffic.pax",
    period: "last_month",
    bucket: "month",
    closedPeriodOnly: true,
  }),
  metricTile({
    key: "shareholder.kpi_month",
    dashboard: "shareholder",
    section: "business_condition",
    title: "KPI bulanan",
    metricCodes: ["net_sales", "pax", "avg_spend_per_pax"],
    reportCode: "sales.per_pax",
    period: "last_month",
    bucket: "month",
    closedPeriodOnly: true,
  }),
  metricTile({
    key: "shareholder.kpi_ytd",
    dashboard: "shareholder",
    section: "business_condition",
    title: "KPI year-to-date",
    metricCodes: ["net_sales", "net_profit"],
    reportCode: "finance.income_statement",
    period: "year_to_date",
    bucket: "month",
    closedPeriodOnly: true,
  }),
  personalShareTile({
    key: "shareholder.profit_share",
    dashboard: "shareholder",
    section: "personal_share",
    title: "Bagi hasil pribadi",
    requiredPermissions: ["profit_share.own.view"],
  }),
  queueTile({
    key: "shareholder.documents",
    dashboard: "shareholder",
    section: "documents",
    title: "Dokumen",
    queue: "documents",
  }),
];

const MANAGEMENT_TILES: readonly DashboardTile[] = [
  queueTile({
    key: "management.approvals",
    dashboard: "management",
    section: "approvals",
    title: "Kotak approval",
    queue: "approvals",
    requiredPermissions: ["approval.inbox.view"],
  }),
  metricTile({
    key: "management.gm_kpi",
    dashboard: "management",
    section: "work_queue",
    title: "Kinerja outlet hari ini",
    metricCodes: ["net_sales", "pax", "transaction_count"],
    reportCode: "sales.per_channel",
    managerRole: "gm",
  }),
  queueTile({
    key: "management.gm_queue",
    dashboard: "management",
    section: "work_queue",
    title: "Approval menunggu",
    queue: "approvals",
    managerRole: "gm",
    requiredPermissions: ["approval.inbox.view"],
  }),
  metricTile({
    key: "management.outlet_kpi",
    dashboard: "management",
    section: "work_queue",
    title: "Okupansi dan turnover meja",
    metricCodes: ["table_occupancy_pct", "table_turnover"],
    reportCode: "operations.table_turnover",
    managerRole: "outlet_manager",
  }),
  queueTile({
    key: "management.outlet_queue",
    dashboard: "management",
    section: "work_queue",
    title: "Stok kritis outlet",
    queue: "critical_stock",
    managerRole: "outlet_manager",
    reportCode: "inventory.critical_stock",
  }),
  metricTile({
    key: "management.kitchen_kpi",
    dashboard: "management",
    section: "work_queue",
    title: "Antrean dan waktu saji",
    metricCodes: ["avg_serving_time", "order_queue_count"],
    reportCode: "operations.kitchen_queue",
    managerRole: "kitchen_lead",
  }),
  queueTile({
    key: "management.kitchen_queue",
    dashboard: "management",
    section: "work_queue",
    title: "Tiket dapur berjalan",
    queue: "kitchen_queue",
    managerRole: "kitchen_lead",
    reportCode: "operations.kitchen_queue",
  }),
  metricTile({
    key: "management.purchasing_kpi",
    dashboard: "management",
    section: "work_queue",
    title: "Utang supplier dan pembelian",
    metricCodes: ["supplier_due", "purchase_total"],
    reportCode: "purchasing.supplier_due",
    managerRole: "purchasing",
    period: "this_month",
  }),
  queueTile({
    key: "management.purchasing_queue",
    dashboard: "management",
    section: "work_queue",
    title: "PR dan PO menunggu approval",
    queue: "approvals",
    managerRole: "purchasing",
    requiredPermissions: ["approval.inbox.view"],
  }),
  metricTile({
    key: "management.finance_kpi",
    dashboard: "management",
    section: "work_queue",
    title: "Posisi kas dan bank",
    metricCodes: ["cash_balance", "bank_balance"],
    reportCode: "finance.cash_position",
    managerRole: "finance",
  }),
  queueTile({
    key: "management.finance_queue",
    dashboard: "management",
    section: "work_queue",
    title: "Approval keuangan",
    queue: "approvals",
    managerRole: "finance",
    requiredPermissions: ["approval.inbox.view"],
  }),
  metricTile({
    key: "management.hr_kpi",
    dashboard: "management",
    section: "work_queue",
    title: "Keterlambatan dan lembur",
    metricCodes: ["attendance_late_count", "overtime_hours"],
    reportCode: "attendance.by_station",
    managerRole: "hr",
  }),
  queueTile({
    key: "management.hr_queue",
    dashboard: "management",
    section: "work_queue",
    title: "Cuti dan koreksi absensi",
    queue: "approvals",
    managerRole: "hr",
    requiredPermissions: ["approval.inbox.view"],
  }),
  metricTile({
    key: "management.marketing_kpi",
    dashboard: "management",
    section: "work_queue",
    title: "Member baru dan aktif",
    metricCodes: ["new_customers", "active_members"],
    reportCode: "loyalty.members",
    managerRole: "marketing",
  }),
  queueTile({
    key: "management.marketing_reviews",
    dashboard: "management",
    section: "work_queue",
    title: "Ulasan menunggu respons",
    queue: "reviews",
    managerRole: "marketing",
    reportCode: "crm.reviews",
  }),
  linkTile({
    key: "management.reports",
    dashboard: "management",
    section: "reports",
    title: "Katalog laporan",
    targetPath: "/reports",
  }),
  linkTile({
    key: "management.audit_log",
    dashboard: "management",
    section: "reports",
    title: "Audit log",
    targetPath: "/audit",
    requiredPermissions: ["audit.log.view"],
  }),
];

export const OWNER_DASHBOARD_TILES = Object.freeze(OWNER_TILES);
export const SHAREHOLDER_DASHBOARD_TILES = Object.freeze(SHAREHOLDER_TILES);
export const MANAGEMENT_DASHBOARD_TILES = Object.freeze(MANAGEMENT_TILES);

export const DASHBOARD_CATALOG = Object.freeze([
  ...OWNER_DASHBOARD_TILES,
  ...SHAREHOLDER_DASHBOARD_TILES,
  ...MANAGEMENT_DASHBOARD_TILES,
]);

export const DASHBOARD_TITLES = {
  owner: "Dashboard Owner",
  shareholder: "Dashboard Shareholder",
  management: "Dashboard Manajemen",
} as const satisfies Record<DashboardKind, string>;

export function dashboardTilesFor(
  dashboard: DashboardKind,
  managerRole: ManagementRole | null = null,
): readonly DashboardTile[] {
  if (dashboard === "owner") return OWNER_DASHBOARD_TILES;
  if (dashboard === "shareholder") return SHAREHOLDER_DASHBOARD_TILES;
  return MANAGEMENT_DASHBOARD_TILES.filter(
    (tile) => tile.managerRole === null || tile.managerRole === managerRole,
  );
}

/** Finality label a tile's numbers carry (SH-02). Null for non-metric tiles. */
export function dashboardTileFinality(
  tile: DashboardTile,
  input: { periodClosed: boolean; accountingPeriodClosed: boolean },
): MetricFinality | null {
  if (tile.kind !== "metric") return null;
  if (!input.periodClosed) return "estimate";
  if (tile.closedPeriodOnly && !input.accountingPeriodClosed) return "estimate";
  return "final";
}
