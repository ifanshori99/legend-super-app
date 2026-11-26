// Standard report catalog: 100+ reports across every family named in PRD v1.7
// §3.36 "Laporan" (sales per hour/channel/menu/employee, menu engineering,
// payments, tax, inventory, HPP, purchasing, finance, loyalty, CRM,
// reservation, attendance, payroll, performance) plus the facility and
// operations reports the owner dashboard drills into. Each entry names the
// metric codes it displays and the dimensions it supports, so the viewer, the
// report builder and the export service all read one definition (DASH-01).
//
// Routes are derived from the code; ids are not stored because the catalog is
// global and code-keyed (PRD §6 has no report table). Tenant-specific rows are
// the saved reports/schedules/exports in builder.ts and exports.ts.

import {
  REPORT_FAMILY_INFO,
  REPORT_PERIOD_PRESETS,
  reportDefinitionSchema,
  PERSONAL_DATA_DIMENSIONS,
  reportRouteForCode,
  selectionContainsPersonalData,
} from "./reports.ts";
import type {
  ReportDefinition,
  ReportExportFormat,
  ReportFamily,
  ReportPeriodPreset,
} from "./reports.ts";
import type { MetricBucket } from "../metrics/index.ts";
import { reportMetricByCode } from "./metric-catalog.ts";

type ReportSeed = {
  code: string;
  name: string;
  description: string;
  family: ReportFamily;
  metrics: readonly string[];
  dimensions?: readonly string[];
  periodPresets?: readonly ReportPeriodPreset[];
  defaultPeriod?: ReportPeriodPreset;
  defaultBucket?: MetricBucket;
  requiredPermissions?: readonly string[];
  containsPersonalData?: boolean;
  closedPeriodOnly?: boolean;
  exportFormats?: readonly ReportExportFormat[];
};

/** Financial, tax and payroll reports are official only for closed periods. */
const CLOSED_PERIOD_FAMILIES = new Set<ReportFamily>([
  "finance",
  "tax",
  "payroll",
]);

const MONTHLY_PRESETS: readonly ReportPeriodPreset[] = [
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "year_to_date",
  "custom",
];

const FAMILY_PERMISSIONS: Record<ReportFamily, readonly string[]> = {
  sales: ["report.sales.view"],
  traffic: ["report.operational.view"],
  menu: ["report.operational.view"],
  payments: ["report.operational.view"],
  tax: ["report.financial.view"],
  inventory: ["report.operational.view"],
  cogs: ["report.financial.view"],
  purchasing: ["report.operational.view"],
  finance: ["report.financial.view"],
  loyalty: ["report.operational.view"],
  crm: ["report.operational.view"],
  reservation: ["report.operational.view"],
  delivery: ["report.operational.view"],
  attendance: ["report.operational.view", "hr.employee.view"],
  payroll: ["report.financial.view", "payroll.view"],
  performance: ["report.operational.view"],
  facility: ["report.operational.view"],
  operations: ["report.operational.view"],
};

/** The only report permission a shareholder holds (access/roles.ts, SH-01). */
export const REPORT_AGGREGATE_VIEW_PERMISSION = "report.aggregate.view";

/**
 * Reports the shareholder dashboard tiles link to. They also accept
 * `report.aggregate.view`, but only as aggregates: see
 * `reportAcceptsAggregateView`. Every other report keeps its own permissions.
 */
export const AGGREGATE_VIEW_REPORT_CODES: readonly string[] = Object.freeze([
  "sales.daily",
  "sales.per_pax",
  "traffic.pax",
  "finance.gross_margin",
  "finance.ebitda",
  "finance.income_statement",
  "finance.cash_position",
]);

/**
 * Founder decision Q59 (2026-11-10, DECISIONS.md butir 8): metrics a
 * `report.aggregate.view` holder (the shareholder) may read as one business
 * total through `GET /api/metrics/query`, although their source report does
 * not accept the aggregate view. Only a request with no `groupBy` at all gets
 * the aggregate reach; any split (outlet, menu, category) stays 403
 * REPORT_NOT_PERMITTED. The source report itself (`inventory.food_cost` for
 * `cogs`) is not added to `AGGREGATE_VIEW_REPORT_CODES`: its report run, with
 * per-menu detail, stays closed to the aggregate view.
 */
export const AGGREGATE_TOTAL_METRIC_CODES: readonly string[] = Object.freeze([
  "cogs",
]);

/**
 * SH-01: a report accepts `report.aggregate.view` only when it is a
 * shareholder-linked report and shows no person: not flagged personal and no
 * identity split (employee, customer, member) on offer.
 */
export function reportAcceptsAggregateView(
  report: Pick<
    ReportDefinition,
    "code" | "containsPersonalData" | "dimensions"
  >,
): boolean {
  return (
    AGGREGATE_VIEW_REPORT_CODES.includes(report.code) &&
    !report.containsPersonalData &&
    !report.dimensions.some((key) => PERSONAL_DATA_DIMENSIONS.includes(key))
  );
}

/**
 * Whether the held permissions open a report: every required permission, or
 * `report.aggregate.view` for an aggregate-only report. One rule for the page
 * guard, the builder, the export gate and the shareholder drill-down links.
 */
export function reportPermittedFor(
  report: Pick<
    ReportDefinition,
    "code" | "containsPersonalData" | "dimensions" | "requiredPermissions"
  >,
  held: ReadonlySet<string> | readonly string[],
): boolean {
  const has = (code: string) => holds(held, code);
  return (
    report.requiredPermissions.every(has) ||
    (reportAcceptsAggregateView(report) &&
      has(REPORT_AGGREGATE_VIEW_PERMISSION))
  );
}

/** Every permission a report family asks for: the "full report" permissions. */
const FULL_REPORT_PERMISSIONS: ReadonlySet<string> = new Set(
  Object.values(FAMILY_PERMISSIONS).flat(),
);

function holds(held: ReadonlySet<string> | readonly string[], code: string) {
  return Array.isArray(held)
    ? held.includes(code)
    : (held as ReadonlySet<string>).has(code);
}

/**
 * SH-01: a caller who holds `report.aggregate.view` and no permission of any
 * report family (the shareholder) sees aggregates only: never a split or
 * filter by an employee, customer or member, in the viewer, the builder, an
 * export or a schedule.
 */
export function aggregateOnlyCaller(
  held: ReadonlySet<string> | readonly string[],
): boolean {
  return (
    holds(held, REPORT_AGGREGATE_VIEW_PERMISSION) &&
    ![...FULL_REPORT_PERMISSIONS].some((code) => holds(held, code))
  );
}

/**
 * Server rule for a builder query (preview, save, export, schedule): an
 * aggregate-only caller may not group or filter by an identity (groupBy AND
 * filters), and every selected metric's source report must be one the held
 * permissions open. Other callers pass here: their report permissions and the
 * export gate decide. `metricCodes` is optional for export and schedule
 * payloads that carry only the splits.
 */
export function builderQueryPermittedFor(
  query: {
    readonly metricCodes?: readonly string[];
    readonly groupBy: readonly string[];
    readonly filters: readonly { readonly key: string }[];
  },
  held: ReadonlySet<string> | readonly string[],
): boolean {
  if (aggregateOnlyCaller(held) && selectionContainsPersonalData(query))
    return false;
  for (const code of query.metricCodes ?? []) {
    const metric = reportMetricByCode.get(code);
    const source =
      metric === undefined
        ? undefined
        : reportByCode(metric.sourceReport.reportCode);
    if (source === undefined || !reportPermittedFor(source, held)) return false;
  }
  return true;
}

function defineReport(seed: ReportSeed): ReportDefinition {
  const monthly = CLOSED_PERIOD_FAMILIES.has(seed.family);
  return reportDefinitionSchema.parse({
    code: seed.code,
    name: seed.name,
    description: seed.description,
    family: seed.family,
    ownerModule: REPORT_FAMILY_INFO[seed.family].ownerModule,
    metrics: seed.metrics,
    dimensions: seed.dimensions ?? [],
    defaultBucket: seed.defaultBucket ?? (monthly ? "month" : "day"),
    periodPresets:
      seed.periodPresets ?? (monthly ? MONTHLY_PRESETS : REPORT_PERIOD_PRESETS),
    defaultPeriod: seed.defaultPeriod ?? (monthly ? "last_month" : "today"),
    requiredPermissions:
      seed.requiredPermissions ?? FAMILY_PERMISSIONS[seed.family],
    containsPersonalData: seed.containsPersonalData ?? false,
    closedPeriodOnly: seed.closedPeriodOnly ?? monthly,
    exportFormats: seed.exportFormats ?? ["csv", "xlsx", "pdf"],
    route: reportRouteForCode(seed.code),
  });
}

const reportSeeds: readonly ReportDefinition[] = [
  // ---- Sales (PRD §3.36: per jam, per kanal, per menu, per karyawan) --------
  defineReport({
    code: "sales.daily",
    name: "Penjualan harian",
    description:
      "Ringkasan omzet kotor, diskon, refund, dan transaksi per outlet dan kanal.",
    family: "sales",
    metrics: [
      "net_sales",
      "gross_sales",
      "discount_amount",
      "refund_amount",
      "transaction_count",
    ],
    dimensions: ["outlet", "channel"],
  }),
  defineReport({
    code: "sales.per_hour",
    name: "Penjualan per jam",
    description: "Omzet, transaksi, dan tamu per jam untuk melihat jam ramai.",
    family: "sales",
    metrics: ["net_sales", "transaction_count", "pax"],
    dimensions: ["hour", "outlet"],
  }),
  defineReport({
    code: "sales.per_channel",
    name: "Penjualan per kanal",
    description:
      "Perbandingan omzet, transaksi, dan tamu antar kanal penjualan.",
    family: "sales",
    metrics: ["net_sales", "transaction_count", "pax"],
    dimensions: ["channel"],
  }),
  defineReport({
    code: "sales.per_menu",
    name: "Penjualan per menu",
    description: "Omzet dan porsi terjual per menu dan kategori.",
    family: "sales",
    metrics: ["net_sales", "menu_sold_qty"],
    dimensions: ["menu_item", "menu_category"],
  }),
  defineReport({
    code: "sales.per_employee",
    name: "Penjualan per karyawan",
    description: "Omzet dan transaksi yang dilayani tiap karyawan.",
    family: "sales",
    metrics: ["net_sales", "transaction_count"],
    dimensions: ["employee"],
    containsPersonalData: true,
  }),
  defineReport({
    code: "sales.transactions",
    name: "Rincian transaksi",
    description: "Jumlah transaksi, nilai rata-rata, dan metode pembayaran.",
    family: "sales",
    metrics: ["transaction_count", "avg_ticket", "net_sales"],
    dimensions: ["outlet", "payment_method"],
  }),
  defineReport({
    code: "sales.per_pax",
    name: "Belanja per tamu",
    description: "Rata-rata belanja per tamu per outlet dan kanal.",
    family: "sales",
    metrics: ["avg_spend_per_pax", "net_sales", "pax"],
    dimensions: ["outlet", "channel"],
  }),
  defineReport({
    code: "sales.void",
    name: "Void dan pembatalan",
    description: "Void rate dan nilai void per outlet dan karyawan (AI-09).",
    family: "sales",
    metrics: ["void_rate_pct", "void_amount"],
    dimensions: ["outlet", "employee"],
    containsPersonalData: true,
  }),
  defineReport({
    code: "sales.discount",
    name: "Diskon",
    description: "Nilai dan persentase diskon per outlet dan promo.",
    family: "sales",
    metrics: ["discount_amount", "discount_rate_pct"],
    dimensions: ["outlet", "promo"],
  }),
  defineReport({
    code: "sales.refund",
    name: "Refund",
    description: "Nilai dan persentase refund per outlet dan metode bayar.",
    family: "sales",
    metrics: ["refund_amount", "refund_rate_pct"],
    dimensions: ["outlet", "payment_method"],
  }),
  defineReport({
    code: "sales.target",
    name: "Target vs realisasi",
    description:
      "Penjualan bersih terhadap target dan pencapaiannya per outlet.",
    family: "sales",
    metrics: ["net_sales", "sales_target", "target_achievement_pct"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "sales.by_day",
    name: "Penjualan per hari",
    description: "Pola omzet dan tamu menurut hari dalam seminggu.",
    family: "sales",
    metrics: ["net_sales", "pax"],
    dimensions: ["day_of_week"],
    defaultPeriod: "last_month",
  }),
  defineReport({
    code: "sales.by_category",
    name: "Penjualan per kategori",
    description: "Omzet dan porsi terjual per kategori menu.",
    family: "sales",
    metrics: ["net_sales", "menu_sold_qty"],
    dimensions: ["menu_category"],
  }),

  // ---- Traffic -------------------------------------------------------------
  defineReport({
    code: "traffic.pax",
    name: "Kunjungan (pax)",
    description: "Jumlah tamu per jam dan kanal kedatangan.",
    family: "traffic",
    metrics: ["pax", "avg_spend_per_pax"],
    dimensions: ["hour", "channel"],
  }),
  defineReport({
    code: "traffic.by_zone",
    name: "Tamu per zona",
    description: "Sebaran tamu dan okupansi meja per zona.",
    family: "traffic",
    metrics: ["pax", "table_occupancy_pct"],
    dimensions: ["zone"],
  }),
  defineReport({
    code: "traffic.new_vs_returning",
    name: "Tamu baru vs kembali",
    description: "Perbandingan pelanggan baru dan pelanggan yang kembali.",
    family: "traffic",
    metrics: ["new_customers", "returning_customers"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "traffic.dwell_time",
    name: "Durasi duduk",
    description:
      "Rata-rata durasi duduk, belanja per tamu, dan table turnover.",
    family: "traffic",
    metrics: ["avg_dwell_minutes", "avg_spend_per_pax", "table_turnover"],
    dimensions: ["zone"],
  }),
  defineReport({
    code: "traffic.peak_hours",
    name: "Jam ramai",
    description: "Tamu dan omzet per jam dan hari untuk perencanaan staf.",
    family: "traffic",
    metrics: ["pax", "net_sales"],
    dimensions: ["hour", "day_of_week"],
    defaultPeriod: "last_month",
  }),

  // ---- Menu ----------------------------------------------------------------
  defineReport({
    code: "menu.engineering",
    name: "Menu engineering",
    description:
      "Porsi terjual, margin kotor, dan popularitas menu untuk klasifikasi bintang.",
    family: "menu",
    metrics: ["menu_sold_qty", "menu_gross_margin", "menu_popularity_pct"],
    dimensions: ["menu_item"],
  }),
  defineReport({
    code: "menu.best_sellers",
    name: "Menu terlaris",
    description: "Menu dengan porsi dan omzet tertinggi.",
    family: "menu",
    metrics: ["menu_sold_qty", "net_sales"],
    dimensions: ["menu_item", "menu_category"],
  }),
  defineReport({
    code: "menu.slow_movers",
    name: "Menu lambat",
    description: "Menu dengan penjualan terendah untuk evaluasi katalog.",
    family: "menu",
    metrics: ["menu_sold_qty"],
    dimensions: ["menu_item"],
  }),
  defineReport({
    code: "menu.sold_out",
    name: "Menu habis",
    description: "Menu yang ditandai habis beserta frekuensinya.",
    family: "menu",
    metrics: ["sold_out_menu_count"],
    dimensions: ["menu_item"],
  }),
  defineReport({
    code: "menu.margin",
    name: "Margin per menu",
    description: "Margin kotor dan food cost per menu.",
    family: "menu",
    metrics: ["menu_gross_margin", "food_cost_pct"],
    dimensions: ["menu_item"],
  }),
  defineReport({
    code: "menu.category_sales",
    name: "Penjualan per kategori menu",
    description: "Omzet dan porsi terjual per kategori.",
    family: "menu",
    metrics: ["net_sales", "menu_sold_qty"],
    dimensions: ["menu_category"],
  }),
  defineReport({
    code: "menu.recipe_cost",
    name: "HPP resep",
    description: "HPP terpakai dan food cost per menu.",
    family: "menu",
    metrics: ["cogs", "food_cost_pct"],
    dimensions: ["menu_item"],
  }),

  // ---- Payments ------------------------------------------------------------
  defineReport({
    code: "payments.methods",
    name: "Pembayaran per metode",
    description: "Jumlah transaksi dan nilai per metode pembayaran.",
    family: "payments",
    metrics: ["transaction_count", "net_sales"],
    dimensions: ["payment_method"],
  }),
  defineReport({
    code: "payments.gateway_settlement",
    name: "Settlement gateway",
    description: "Settlement gateway yang cair dan yang masih tertunda.",
    family: "payments",
    metrics: ["gateway_settlement", "pending_settlement"],
    dimensions: ["outlet", "payment_method"],
  }),
  defineReport({
    code: "payments.edc_settlement",
    name: "Settlement EDC",
    description: "Settlement kartu debit/kredit per bank EDC.",
    family: "payments",
    metrics: ["edc_settlement"],
    dimensions: ["outlet", "payment_method"],
  }),
  defineReport({
    code: "payments.failed",
    name: "Pembayaran gagal",
    description: "Percobaan pembayaran yang gagal per metode.",
    family: "payments",
    metrics: ["failed_payment_count"],
    dimensions: ["outlet", "payment_method"],
  }),
  defineReport({
    code: "payments.fees",
    name: "Biaya pembayaran",
    description: "Biaya gateway dan EDC per metode pembayaran.",
    family: "payments",
    metrics: ["payment_fee"],
    dimensions: ["outlet", "payment_method"],
  }),
  defineReport({
    code: "payments.cash_variance",
    name: "Selisih kas",
    description: "Selisih hitung kas shift per outlet dan kasir.",
    family: "payments",
    metrics: ["cash_variance"],
    dimensions: ["outlet", "employee"],
    containsPersonalData: true,
  }),

  // ---- Tax ----------------------------------------------------------------
  defineReport({
    code: "tax.pbjt",
    name: "PBJT",
    description: "Pajak PBJT yang dipungut per outlet pada periode.",
    family: "tax",
    metrics: ["tax_collected"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "tax.service_charge",
    name: "Service charge",
    description: "Service charge yang dipungut pada periode.",
    family: "tax",
    metrics: ["service_charge_collected"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "tax.receivable",
    name: "Utang pajak",
    description: "Saldo pajak yang belum disetor per outlet.",
    family: "tax",
    metrics: ["tax_payable"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "tax.by_rule",
    name: "Pajak per aturan",
    description: "Pajak yang dipungut menurut aturan dan kategori menu.",
    family: "tax",
    metrics: ["tax_collected"],
    dimensions: ["outlet", "menu_category"],
  }),

  // ---- Inventory -----------------------------------------------------------
  defineReport({
    code: "inventory.stock_value",
    name: "Nilai stok",
    description: "Nilai persediaan per outlet dan item pada saat data.",
    family: "inventory",
    metrics: ["stock_value"],
    dimensions: ["outlet", "menu_item"],
  }),
  defineReport({
    code: "inventory.critical_stock",
    name: "Stok kritis",
    description: "Item yang berada di bawah par level beserta jumlahnya.",
    family: "inventory",
    metrics: ["critical_stock_count"],
    dimensions: ["outlet", "menu_item"],
  }),
  defineReport({
    code: "inventory.waste",
    name: "Waste",
    description: "Biaya waste dan persentasenya terhadap penjualan bersih.",
    family: "inventory",
    metrics: ["waste_cost", "waste_cost_pct"],
    dimensions: ["outlet", "menu_item"],
  }),
  defineReport({
    code: "inventory.food_cost",
    name: "Food cost",
    description: "HPP bahan dan food cost % per outlet dan kategori.",
    family: "inventory",
    metrics: ["food_cost_pct", "cogs"],
    dimensions: ["outlet", "menu_category"],
  }),
  defineReport({
    code: "inventory.movement",
    name: "Pergerakan stok",
    description: "Nilai stok dan HPP terpakai untuk melihat pergerakan.",
    family: "inventory",
    metrics: ["stock_value", "cogs"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "inventory.waste_by_category",
    name: "Waste per kategori",
    description: "Biaya waste menurut kategori menu.",
    family: "inventory",
    metrics: ["waste_cost"],
    dimensions: ["menu_category"],
  }),
  defineReport({
    code: "inventory.stock_usage",
    name: "Pemakaian bahan",
    description: "HPP bahan terpakai per item persediaan.",
    family: "inventory",
    metrics: ["cogs"],
    dimensions: ["menu_item"],
  }),

  // ---- COGS ----------------------------------------------------------------
  defineReport({
    code: "cogs.per_menu",
    name: "HPP per menu",
    description: "HPP dan margin kotor per menu.",
    family: "cogs",
    metrics: ["cogs", "menu_gross_margin"],
    dimensions: ["menu_item"],
  }),
  defineReport({
    code: "cogs.recipe",
    name: "HPP resep",
    description: "HPP terpakai dan food cost per menu.",
    family: "cogs",
    metrics: ["cogs", "food_cost_pct"],
    dimensions: ["menu_item"],
  }),
  defineReport({
    code: "cogs.trend",
    name: "Tren HPP",
    description: "Pergerakan food cost % dan HPP pada periode.",
    family: "cogs",
    metrics: ["food_cost_pct", "cogs"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "cogs.production",
    name: "Produksi semi-finished",
    description: "HPP produksi harian per outlet.",
    family: "cogs",
    metrics: ["cogs"],
    dimensions: ["outlet"],
  }),

  // ---- Purchasing ----------------------------------------------------------
  defineReport({
    code: "purchasing.requests",
    name: "Permintaan pembelian",
    description: "Nilai permintaan pembelian per outlet dan supplier.",
    family: "purchasing",
    metrics: ["purchase_total"],
    dimensions: ["outlet", "supplier"],
  }),
  defineReport({
    code: "purchasing.orders",
    name: "Purchase order",
    description: "Nilai PO yang diterbitkan per outlet dan supplier.",
    family: "purchasing",
    metrics: ["purchase_total"],
    dimensions: ["outlet", "supplier"],
  }),
  defineReport({
    code: "purchasing.receipts",
    name: "Penerimaan barang",
    description: "Nilai barang diterima per outlet dan supplier.",
    family: "purchasing",
    metrics: ["purchase_total"],
    dimensions: ["outlet", "supplier"],
  }),
  defineReport({
    code: "purchasing.supplier_due",
    name: "Utang supplier",
    description: "Invoice supplier yang jatuh tempo dan belum dibayar.",
    family: "purchasing",
    metrics: ["supplier_due", "purchase_total"],
    dimensions: ["outlet", "supplier"],
  }),
  defineReport({
    code: "purchasing.price_history",
    name: "Riwayat harga bahan",
    description:
      "Nilai pembelian per pemasok dan bahan untuk memantau perubahan harga.",
    family: "purchasing",
    // HPP is recognised per sale, not per supplier, so it is not split here.
    metrics: ["purchase_total"],
    dimensions: ["supplier", "menu_item"],
  }),

  // ---- Finance -------------------------------------------------------------
  defineReport({
    code: "finance.income_statement",
    name: "Laba rugi",
    description:
      "Penjualan bersih, HPP, laba kotor, dan laba bersih periode tertutup.",
    family: "finance",
    metrics: ["net_sales", "cogs", "gross_profit", "net_profit"],
    dimensions: ["outlet", "legal_entity"],
  }),
  defineReport({
    code: "finance.prime_cost",
    name: "Prime cost",
    description:
      "Food cost %, labor cost %, dan prime cost % periode tertutup.",
    family: "finance",
    metrics: ["prime_cost_pct", "food_cost_pct", "labor_cost_pct"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "finance.ebitda",
    name: "EBITDA",
    description: "EBITDA dan laba bersih periode tertutup.",
    family: "finance",
    metrics: ["ebitda", "net_profit"],
    dimensions: ["outlet", "legal_entity"],
  }),
  defineReport({
    code: "finance.cash_position",
    name: "Posisi kas dan bank",
    description: "Saldo kas dan bank pada akhir periode.",
    family: "finance",
    metrics: ["cash_balance", "bank_balance"],
    dimensions: ["outlet", "legal_entity"],
    // A cash position is monitored daily even though finance reports are
    // monthly by default, so the presets stay open for the owner tile.
    periodPresets: REPORT_PERIOD_PRESETS,
  }),
  defineReport({
    code: "finance.supplier_due",
    name: "Utang supplier jatuh tempo",
    description: "Utang supplier yang jatuh tempo per outlet dan supplier.",
    family: "finance",
    metrics: ["supplier_due"],
    dimensions: ["outlet", "supplier"],
    periodPresets: REPORT_PERIOD_PRESETS,
  }),
  defineReport({
    code: "finance.pending_settlement",
    name: "Settlement tertunda",
    description: "Pembayaran gateway yang belum cair per metode.",
    family: "finance",
    metrics: ["pending_settlement"],
    dimensions: ["outlet", "payment_method"],
    periodPresets: REPORT_PERIOD_PRESETS,
  }),
  defineReport({
    code: "finance.gross_margin",
    name: "Margin kotor",
    description: "Laba kotor dan margin kotor per outlet dan kategori.",
    family: "finance",
    metrics: ["gross_profit", "gross_margin_pct"],
    dimensions: ["outlet", "menu_category", "legal_entity"],
  }),
  defineReport({
    code: "finance.profit_trend",
    name: "Tren laba",
    description: "Laba bersih dan EBITDA antar periode tertutup.",
    family: "finance",
    metrics: ["net_profit", "ebitda"],
    dimensions: ["outlet", "legal_entity"],
  }),

  // ---- Loyalty -------------------------------------------------------------
  defineReport({
    code: "loyalty.members",
    name: "Member aktif",
    description: "Member aktif dan pelanggan baru per tier.",
    family: "loyalty",
    metrics: ["active_members", "new_customers"],
    dimensions: ["customer_tier"],
  }),
  defineReport({
    code: "loyalty.points",
    name: "Poin ditukar",
    description: "Poin loyalty yang ditukar per tier dan outlet.",
    family: "loyalty",
    metrics: ["points_redeemed"],
    dimensions: ["customer_tier", "outlet"],
  }),
  defineReport({
    code: "loyalty.visits",
    name: "Kunjungan member",
    description: "Pelanggan kembali dan tamu per tier.",
    family: "loyalty",
    metrics: ["returning_customers", "pax"],
    dimensions: ["customer_tier"],
  }),
  defineReport({
    code: "loyalty.new_members",
    name: "Member baru",
    description: "Pelanggan baru per outlet pada periode.",
    family: "loyalty",
    metrics: ["new_customers"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "loyalty.tier_mix",
    name: "Komposisi tier",
    description: "Sebaran member aktif menurut tier.",
    family: "loyalty",
    metrics: ["active_members"],
    dimensions: ["customer_tier"],
  }),

  // ---- CRM -----------------------------------------------------------------
  defineReport({
    code: "crm.customers",
    name: "Daftar pelanggan",
    description: "Pelanggan baru dan aktif per tier; berisi data pribadi.",
    family: "crm",
    metrics: ["new_customers", "active_members"],
    dimensions: ["customer_tier"],
    requiredPermissions: ["report.operational.view", "crm.customer.view"],
    containsPersonalData: true,
  }),
  defineReport({
    code: "crm.segments",
    name: "Segmentasi pelanggan",
    description: "Sebaran member dan pelanggan baru per tier.",
    family: "crm",
    metrics: ["active_members", "new_customers"],
    dimensions: ["customer_tier"],
  }),
  defineReport({
    code: "crm.reviews",
    name: "Ulasan pelanggan",
    description: "Rating rata-rata dan jumlah ulasan per outlet.",
    family: "crm",
    metrics: ["review_rating", "review_count"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "crm.repeat_visit",
    name: "Kunjungan ulang",
    description: "Pelanggan kembali dibanding seluruh tamu.",
    family: "crm",
    metrics: ["returning_customers", "pax"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "crm.promo_cost",
    name: "Biaya promo",
    description: "Biaya promo per program pada periode.",
    family: "crm",
    metrics: ["promo_cost", "discount_amount"],
    dimensions: ["promo"],
  }),
  defineReport({
    code: "crm.campaign_performance",
    name: "Kinerja kampanye",
    description: "Diskon dan omzet yang dipengaruhi kampanye promo.",
    family: "crm",
    metrics: ["discount_amount", "net_sales"],
    dimensions: ["promo"],
  }),

  // ---- Reservation ---------------------------------------------------------
  defineReport({
    code: "reservation.bookings",
    name: "Reservasi",
    description: "Jumlah reservasi dan tamu per outlet.",
    family: "reservation",
    metrics: ["reservation_count", "pax"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "reservation.no_show",
    name: "Reservasi no-show",
    description: "Reservasi no-show dan persentasenya.",
    family: "reservation",
    metrics: ["no_show_reservations", "reservation_no_show_pct"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "reservation.by_zone",
    name: "Reservasi per zona",
    description: "Reservasi dan tamu per zona.",
    family: "reservation",
    metrics: ["reservation_count", "pax"],
    dimensions: ["zone"],
  }),
  defineReport({
    code: "reservation.peak_hours",
    name: "Reservasi per jam",
    description: "Sebaran reservasi menurut jam kedatangan.",
    family: "reservation",
    metrics: ["reservation_count"],
    dimensions: ["hour"],
  }),

  // ---- Delivery ------------------------------------------------------------
  defineReport({
    code: "delivery.orders",
    name: "Pesanan delivery",
    description: "Jumlah dan nilai pesanan delivery per kanal.",
    family: "delivery",
    metrics: ["delivery_orders", "delivery_sales"],
    dimensions: ["channel"],
  }),
  defineReport({
    code: "delivery.channel_sales",
    name: "Penjualan per kanal delivery",
    description: "Nilai bersih dan jumlah pesanan per kanal.",
    family: "delivery",
    metrics: ["delivery_sales", "delivery_orders"],
    dimensions: ["channel"],
  }),
  defineReport({
    code: "delivery.by_menu",
    name: "Menu delivery",
    description: "Nilai dan porsi menu terjual lewat delivery.",
    family: "delivery",
    metrics: ["delivery_sales", "menu_sold_qty"],
    dimensions: ["menu_item"],
  }),
  defineReport({
    code: "delivery.settlement",
    name: "Settlement delivery",
    description: "Penjualan delivery dan biaya kanal yang dibebankan.",
    family: "delivery",
    metrics: ["delivery_sales", "payment_fee"],
    dimensions: ["channel"],
  }),

  // ---- Attendance ----------------------------------------------------------
  defineReport({
    code: "attendance.daily",
    name: "Absensi harian",
    description: "Keterlambatan absensi per outlet dan karyawan.",
    family: "attendance",
    metrics: ["attendance_late_count"],
    dimensions: ["outlet", "employee"],
    containsPersonalData: true,
    defaultBucket: "day",
  }),
  defineReport({
    code: "attendance.overtime",
    name: "Lembur",
    description: "Jam lembur per outlet dan karyawan.",
    family: "attendance",
    metrics: ["overtime_hours"],
    dimensions: ["outlet", "employee"],
    containsPersonalData: true,
    defaultBucket: "day",
  }),
  defineReport({
    code: "attendance.late",
    name: "Keterlambatan",
    description: "Keterlambatan absensi per karyawan.",
    family: "attendance",
    metrics: ["attendance_late_count"],
    dimensions: ["employee"],
    containsPersonalData: true,
    defaultBucket: "day",
  }),
  defineReport({
    code: "attendance.by_station",
    name: "Absensi per stasiun",
    description: "Keterlambatan dan lembur untuk perencanaan shift.",
    family: "attendance",
    metrics: ["attendance_late_count", "overtime_hours"],
    dimensions: ["outlet"],
    defaultBucket: "day",
  }),

  // ---- Payroll -------------------------------------------------------------
  defineReport({
    code: "payroll.labor_cost",
    name: "Labor cost",
    description: "Labor cost % dan gaji bruto periode tertutup.",
    family: "payroll",
    metrics: ["labor_cost_pct", "gross_payroll"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "payroll.gross",
    name: "Gaji bruto",
    description: "Gaji bruto payroll terkunci per karyawan.",
    family: "payroll",
    metrics: ["gross_payroll"],
    dimensions: ["outlet", "employee"],
    containsPersonalData: true,
  }),
  defineReport({
    code: "payroll.overtime",
    name: "Lembur payroll",
    description: "Jam lembur yang dibayarkan pada periode payroll.",
    family: "payroll",
    metrics: ["overtime_hours"],
    dimensions: ["outlet", "employee"],
    containsPersonalData: true,
  }),
  defineReport({
    code: "payroll.cost_trend",
    name: "Tren biaya tenaga kerja",
    description: "Gaji bruto dan labor cost % antar periode tertutup.",
    family: "payroll",
    metrics: ["gross_payroll", "labor_cost_pct"],
    dimensions: ["outlet"],
  }),

  // ---- Performance ---------------------------------------------------------
  defineReport({
    code: "performance.employee",
    name: "Kinerja karyawan",
    description: "Omzet dan transaksi per karyawan untuk penilaian KPI.",
    family: "performance",
    metrics: ["net_sales", "transaction_count"],
    dimensions: ["employee"],
    containsPersonalData: true,
  }),
  defineReport({
    code: "performance.station",
    name: "Kinerja stasiun",
    description: "Waktu saji dan antrean per stasiun dapur.",
    family: "performance",
    metrics: ["avg_serving_time", "order_queue_count"],
    dimensions: ["station"],
  }),
  defineReport({
    code: "performance.service_quality",
    name: "Kualitas layanan",
    description: "Item gagal, remake, dan comp pada periode.",
    family: "performance",
    metrics: ["failed_item_count", "remake_count", "comp_count"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "performance.checklist",
    name: "Kepatuhan checklist",
    description: "Persentase checklist operasional yang selesai.",
    family: "performance",
    metrics: ["checklist_compliance_pct"],
    dimensions: ["outlet"],
  }),

  // ---- Facility ------------------------------------------------------------
  defineReport({
    code: "facility.revenue",
    name: "Pendapatan fasilitas",
    description:
      "Pendapatan shower room dan jumlah sesi per fasilitas dan per unit (bilik).",
    family: "facility",
    metrics: ["shower_revenue", "shower_sessions"],
    dimensions: ["outlet", "facility", "unit"],
  }),
  defineReport({
    code: "facility.revpash",
    name: "RevPASH",
    description: "Pendapatan per kursi per jam dan okupansi kursi per zona.",
    family: "facility",
    metrics: ["revpash", "seat_occupancy_pct"],
    dimensions: ["zone", "hour"],
  }),
  defineReport({
    code: "facility.occupancy",
    name: "Utilisasi shower room",
    description: "Utilisasi bilik dan jumlah sesi per fasilitas dan per unit.",
    family: "facility",
    metrics: ["shower_occupancy_pct", "shower_sessions"],
    dimensions: ["facility", "unit"],
  }),
  defineReport({
    code: "facility.subscriptions",
    name: "Langganan fasilitas",
    description: "Langganan aktif dan pendapatan berulang per fasilitas.",
    family: "facility",
    metrics: ["active_subscriptions", "shower_revenue"],
    dimensions: ["facility"],
  }),
  defineReport({
    code: "facility.wifi",
    name: "Wi-Fi tamu",
    description: "Sesi Wi-Fi dan kuota terpakai per outlet.",
    family: "facility",
    metrics: ["wifi_quota_used", "wifi_sessions"],
    dimensions: ["outlet", "facility"],
  }),
  defineReport({
    code: "facility.fnb_conversion",
    name: "Konversi fasilitas ke F&B",
    description:
      "Sesi shower dengan pesanan F&B dan konversinya per fasilitas dan per unit.",
    family: "facility",
    metrics: ["shower_fnb_conversion_pct", "shower_sessions_with_fnb"],
    dimensions: ["facility", "unit"],
  }),
  defineReport({
    code: "facility.overtime",
    name: "Kelebihan waktu fasilitas",
    description:
      "Sesi yang melewati durasi dan total waktu kelebihan per fasilitas dan per unit.",
    family: "facility",
    metrics: ["facility_overtime_sessions", "facility_overtime_seconds"],
    dimensions: ["outlet", "facility", "unit"],
  }),
  defineReport({
    code: "facility.cleaning_time",
    name: "Waktu pembersihan",
    description:
      "Jumlah pembersihan dan rata-rata lama pembersihan per fasilitas dan per unit.",
    family: "facility",
    metrics: ["facility_cleaning_count", "facility_cleaning_seconds"],
    dimensions: ["outlet", "facility", "unit"],
  }),
  defineReport({
    code: "facility.incidents",
    name: "Insiden fasilitas",
    description:
      "Jumlah insiden dan rata-rata waktu respons per fasilitas dan per unit.",
    family: "facility",
    metrics: ["facility_incident_count", "facility_incident_response_seconds"],
    dimensions: ["outlet", "facility", "unit"],
  }),
  defineReport({
    code: "facility.product_revenue",
    name: "Pendapatan per produk fasilitas",
    description:
      "Pendapatan dan jumlah terjual tiap produk fasilitas: tiket, paket, day pass, reservasi kursi, dan langganan.",
    family: "facility",
    metrics: ["facility_product_revenue", "facility_product_sales"],
    dimensions: ["outlet", "facility", "product"],
  }),
  defineReport({
    code: "facility.unit_utilization",
    name: "Utilisasi unit per jam",
    description:
      "Persentase menit terpakai tiap unit (bilik atau kursi), per unit dan per jam buka.",
    family: "facility",
    metrics: ["unit_utilization_pct"],
    dimensions: ["outlet", "unit", "hour", "facility"],
  }),

  // ---- Operations ----------------------------------------------------------
  defineReport({
    code: "operations.table_turnover",
    name: "Perputaran meja",
    description: "Perputaran dan okupansi meja per zona.",
    family: "operations",
    metrics: ["table_turnover", "table_occupancy_pct"],
    dimensions: ["zone"],
  }),
  defineReport({
    code: "operations.occupancy",
    name: "Okupansi meja",
    description: "Okupansi meja per zona dan jam.",
    family: "operations",
    metrics: ["table_occupancy_pct"],
    dimensions: ["zone", "hour"],
  }),
  defineReport({
    code: "operations.kitchen_queue",
    name: "Antrean dapur",
    description: "Antrean tiket dan waktu saji rata-rata per stasiun.",
    family: "operations",
    metrics: ["order_queue_count", "avg_serving_time"],
    dimensions: ["station"],
  }),
  defineReport({
    code: "operations.serving_time",
    name: "Waktu saji",
    description: "Waktu saji rata-rata per stasiun dan jam.",
    family: "operations",
    metrics: ["avg_serving_time"],
    dimensions: ["station", "hour"],
  }),
  defineReport({
    code: "operations.waiter_calls",
    name: "Panggilan waiter",
    description: "Panggilan waiter yang belum dan sudah ditangani per zona.",
    family: "operations",
    metrics: ["waiter_call_count"],
    dimensions: ["zone"],
  }),
  defineReport({
    code: "operations.failed_items",
    name: "Item gagal",
    description: "Item gagal setelah bayar dan voucher permintaan maaf.",
    family: "operations",
    metrics: ["failed_item_count", "apology_voucher_count"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "operations.remake_comp",
    name: "Remake dan comp",
    description: "Remake dan comp per outlet dan stasiun.",
    family: "operations",
    metrics: ["remake_count", "comp_count"],
    dimensions: ["outlet", "station"],
  }),
  defineReport({
    code: "operations.devices",
    name: "Kesehatan perangkat",
    description: "Perangkat outlet yang sedang offline.",
    family: "operations",
    metrics: ["device_offline_count"],
    dimensions: ["outlet"],
  }),
  defineReport({
    code: "operations.alerts",
    name: "Anomali operasional",
    description: "Void, selisih kas, dan indikator anomali lain (AI-09).",
    family: "operations",
    metrics: ["void_rate_pct", "cash_variance"],
    dimensions: ["outlet"],
  }),
];

const byCode = new Map<string, ReportDefinition>();
for (const report of reportSeeds) {
  if (byCode.has(report.code))
    throw new Error(`Duplicate report code in catalog: ${report.code}`);
  // DASH-02: a report may only split by a dimension every metric it shows
  // declares, otherwise the metrics layer refuses the run it offers.
  for (const code of report.metrics) {
    const metric = reportMetricByCode.get(code);
    if (metric === undefined)
      throw new Error(`Report ${report.code} cites unknown metric ${code}`);
    for (const dimension of report.dimensions)
      if (!metric.dimensions.includes(dimension))
        throw new Error(
          `Report ${report.code} splits by ${dimension}, which ${code} does not declare`,
        );
  }
  byCode.set(report.code, report);
}

/** The full standard report catalog, sorted by code for stable pagination. */
export const reportCatalog: readonly ReportDefinition[] = Object.freeze(
  [...byCode.values()].sort((left, right) =>
    left.code.localeCompare(right.code),
  ),
);

export const reportDefinitionByCode: ReadonlyMap<string, ReportDefinition> =
  byCode;

export function reportByCode(code: string): ReportDefinition | undefined {
  return byCode.get(code);
}

export function reportsByFamily(
  family: ReportFamily,
): readonly ReportDefinition[] {
  return reportCatalog.filter((report) => report.family === family);
}
