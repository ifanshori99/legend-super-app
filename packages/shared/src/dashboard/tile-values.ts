// Dashboard tile value and queue-row payloads (WS-11 CT, beads legend-v3pt and
// legend-kx94; PRD v1.7 §3.34 "Ringkasan Real-time", DASH-01/DASH-02, SH-02).
//
// A metric tile never carries a figure of its own: the server answers one
// entry per cited metric code, read from the same metric layer the source
// report reads (DASH-02), with the tile target and the previous-period
// comparison next to it. The comparison reuses `metricComparisonSchema`, so a
// tile and the metrics query say "naik/turun" with one definition.
//
// Money values come from the GL (I1) and every value carries its finality: an
// open period is always an estimate, never `final` (SH-02, I2).
//
// Queue tiles (kitchen_queue, waiter_calls, reviews, facility_units) get row
// payloads here. Rows hold no customer or employee identity (SH-01 reaches the
// owner and management homes only through aggregates and operational labels).

import {
  businessDateSchema,
  clientInputSchema,
  isoDateTimeSchema,
  outletIdSchema,
  z,
} from "../core/index.ts";
import {
  compareMetricValues,
  metricCodeSchema,
  metricComparisonSchema,
  metricFinalitySchema,
  metricOutletFilterSchema,
  metricPeriodSchema,
  metricValueSchema,
} from "../metrics/index.ts";
import { facilityIdSchema } from "../facility/ids.ts";
import {
  facilityTypeSchema,
  facilityUnitStatusSchema,
} from "../facility/schemas.ts";
import {
  kitchenTicketIdSchema,
  kitchenTicketStatusSchema,
} from "../kitchen/schemas.ts";
import { cafeLegendFixtures } from "../core/fixtures.ts";
import {
  cafeLegendFacilities,
  cafeLegendFacilityUnits,
} from "../facility/fixtures.ts";
import {
  closedMonthPeriod,
  netSalesDailySeries,
  openDayPeriod,
} from "../metrics/fixtures.ts";
import { reportPeriodPresetSchema } from "./reports.ts";
import { dashboardKindSchema, tileKeySchema } from "./dashboards.ts";

// ---- Metric tile values (legend-v3pt) ---------------------------------------

/** GET /api/dashboards/:dashboardCode/values query; tenant never travels. */
export const dashboardValuesQuerySchema = clientInputSchema({
  /** Overrides every tile's default period; `custom` needs both dates. */
  period: reportPeriodPresetSchema.optional(),
  startDate: businessDateSchema.optional(),
  endDate: businessDateSchema.optional(),
  /** Intersected with the caller's outlet scope server-side (TEN-03). */
  outletIds: z.array(outletIdSchema).min(1).max(50).optional(),
}).superRefine((query, ctx) => {
  const hasDates = query.startDate !== undefined || query.endDate !== undefined;
  if (query.period === "custom") {
    if (query.startDate === undefined || query.endDate === undefined)
      ctx.addIssue({
        code: "custom",
        message: "A custom period needs startDate and endDate",
        path: ["period"],
      });
    else if (query.startDate > query.endDate)
      ctx.addIssue({
        code: "custom",
        message: "startDate must not be after endDate",
        path: ["endDate"],
      });
  } else if (hasDates) {
    ctx.addIssue({
      code: "custom",
      message: "startDate and endDate only go with period=custom",
      path: ["period"],
    });
  }
});
export type DashboardValuesQuery = z.infer<typeof dashboardValuesQuerySchema>;

/** One metric's figure inside a tile: value, target and previous period. */
export const dashboardTileMetricValueSchema = z
  .strictObject({
    metricCode: metricCodeSchema,
    /** Null means no data; a blank is never reported as zero. */
    value: metricValueSchema.nullable(),
    /** Target for the period (PRD §3.34); null when no target is set. */
    target: metricValueSchema.nullable(),
    /** Previous-period comparison; null when not requested or no baseline. */
    comparison: metricComparisonSchema.nullable(),
    /** Money (idr) is final only for a closed accounting period (I2). */
    finality: metricFinalitySchema,
  })
  .superRefine((entry, ctx) => {
    const unit = entry.value?.unit;
    if (entry.value === null && entry.comparison !== null)
      ctx.addIssue({
        code: "custom",
        message: "A tile without a value cannot carry a comparison",
        path: ["comparison"],
      });
    if (unit === undefined) return;
    if (entry.target !== null && entry.target.unit !== unit)
      ctx.addIssue({
        code: "custom",
        message: `Target unit must be ${unit}`,
        path: ["target", "unit"],
      });
    if (
      entry.comparison !== null &&
      (entry.comparison.previousValue.unit !== unit ||
        entry.comparison.changeValue.unit !== unit)
    )
      ctx.addIssue({
        code: "custom",
        message: `Comparison units must be ${unit}`,
        path: ["comparison"],
      });
  });
export type DashboardTileMetricValue = z.infer<
  typeof dashboardTileMetricValueSchema
>;

/** The resolved figures of one metric tile. */
export const dashboardTileValuesSchema = z
  .strictObject({
    tileKey: tileKeySchema,
    /** The period this tile resolved to (preset default or query override). */
    period: metricPeriodSchema,
    values: z.array(dashboardTileMetricValueSchema).min(1).max(6),
  })
  .superRefine((tile, ctx) => {
    const codes = tile.values.map((entry) => entry.metricCode);
    if (new Set(codes).size !== codes.length)
      ctx.addIssue({
        code: "custom",
        message: "Tile values repeat a metric code",
        path: ["values"],
      });
    // SH-02, I2: nothing inside an open period may be labelled final.
    if (tile.period.status === "open")
      for (const [index, entry] of tile.values.entries())
        if (entry.finality === "final")
          ctx.addIssue({
            code: "custom",
            message: "An open period is an estimate, never final",
            path: ["values", index, "finality"],
          });
    // Money is final only once the accounting period is closed too (I1, I2).
    if (!tile.period.accountingPeriodClosed)
      for (const [index, entry] of tile.values.entries())
        if (entry.value?.unit === "idr" && entry.finality === "final")
          ctx.addIssue({
            code: "custom",
            message: "Money is an estimate until the accounting period closes",
            path: ["values", index, "finality"],
          });
  });
export type DashboardTileValues = z.infer<typeof dashboardTileValuesSchema>;

export const dashboardValuesSchema = z
  .strictObject({
    dashboard: dashboardKindSchema,
    /** The outlet business date the values describe. */
    businessDate: businessDateSchema,
    /** Outlets the server actually queried after the TEN-03 scope check. */
    outlets: metricOutletFilterSchema,
    tiles: z.array(dashboardTileValuesSchema).max(60),
    generatedAt: isoDateTimeSchema,
  })
  .superRefine((payload, ctx) => {
    const keys = payload.tiles.map((tile) => tile.tileKey);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({
        code: "custom",
        message: "Dashboard values repeat a tile key",
        path: ["tiles"],
      });
  });
export type DashboardValues = z.infer<typeof dashboardValuesSchema>;

// ---- Queue rows (legend-kx94) -----------------------------------------------

/** Queues whose rows this contract serves; the rest use their own domains. */
export const DASHBOARD_ROW_QUEUES = [
  "kitchen_queue",
  "waiter_calls",
  "reviews",
  "facility_units",
] as const;
export const dashboardRowQueueSchema = z.enum(DASHBOARD_ROW_QUEUES);
export type DashboardRowQueue = z.infer<typeof dashboardRowQueueSchema>;

const seconds = z.number().int().nonnegative().max(31_536_000);
const rowBase = { outletId: outletIdSchema };

export const kitchenQueueRowSchema = z.strictObject({
  ...rowBase,
  ticketId: kitchenTicketIdSchema,
  /** Order label shown on the ticket, for example "A-014". */
  orderLabel: z.string().min(1).max(40),
  stationName: z.string().min(1).max(150),
  status: kitchenTicketStatusSchema,
  itemCount: z.number().int().positive().max(500),
  createdAt: isoDateTimeSchema,
  waitingSeconds: seconds,
});
export type KitchenQueueRow = z.infer<typeof kitchenQueueRowSchema>;

export const WAITER_CALL_STATUSES = ["open", "acknowledged"] as const;
export const waiterCallStatusSchema = z.enum(WAITER_CALL_STATUSES);

export const waiterCallRowSchema = z.strictObject({
  ...rowBase,
  callId: z.string().min(1).max(64),
  tableLabel: z.string().min(1).max(40),
  reason: z.string().min(1).max(120).nullable(),
  status: waiterCallStatusSchema,
  calledAt: isoDateTimeSchema,
  waitingSeconds: seconds,
});
export type WaiterCallRow = z.infer<typeof waiterCallRowSchema>;

/** Review rows carry no reviewer identity (SH-01). */
export const reviewRowSchema = z.strictObject({
  ...rowBase,
  reviewId: z.string().min(1).max(64),
  rating: z.number().int().min(1).max(5),
  excerpt: z.string().max(280).nullable(),
  /** Where the review came from, for example "google" or "in_app". */
  source: z.string().min(1).max(40),
  createdAt: isoDateTimeSchema,
  replied: z.boolean(),
});
export type ReviewRow = z.infer<typeof reviewRowSchema>;

/** Unit counts by status for one facility, so the tile needs no extra call. */
export const facilityUnitSummaryRowSchema = z
  .strictObject({
    ...rowBase,
    facilityId: facilityIdSchema,
    facilityName: z.string().min(1).max(150),
    facilityType: facilityTypeSchema,
    unitCounts: z.strictObject({
      available: z.number().int().nonnegative().max(1000),
      in_use: z.number().int().nonnegative().max(1000),
      needs_cleaning: z.number().int().nonnegative().max(1000),
      cleaning: z.number().int().nonnegative().max(1000),
      maintenance: z.number().int().nonnegative().max(1000),
    }),
  })
  .superRefine((row, ctx) => {
    // Keep the counts keyed by the facility unit status machine.
    for (const status of facilityUnitStatusSchema.options)
      if (!(status in row.unitCounts))
        ctx.addIssue({
          code: "custom",
          message: `unitCounts is missing ${status}`,
          path: ["unitCounts", status],
        });
  });
export type FacilityUnitSummaryRow = z.infer<
  typeof facilityUnitSummaryRowSchema
>;

const queueRowsPayload = <
  Queue extends DashboardRowQueue,
  Row extends z.ZodType,
>(
  queue: Queue,
  row: Row,
) =>
  z.strictObject({
    queue: z.literal(queue),
    rows: z.array(row).max(100),
    /** Rows beyond the page cap exist; the tile links to its full screen. */
    hasMore: z.boolean(),
    generatedAt: isoDateTimeSchema,
  });

/** GET /api/dashboards/queues/:queue/rows payload, keyed by queue. */
export const dashboardQueueRowsSchema = z.discriminatedUnion("queue", [
  queueRowsPayload("kitchen_queue", kitchenQueueRowSchema),
  queueRowsPayload("waiter_calls", waiterCallRowSchema),
  queueRowsPayload("reviews", reviewRowSchema),
  queueRowsPayload("facility_units", facilityUnitSummaryRowSchema),
]);
export type DashboardQueueRows = z.infer<typeof dashboardQueueRowsSchema>;

export const dashboardQueueRowsQuerySchema = clientInputSchema({
  outletIds: z.array(outletIdSchema).min(1).max(50).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type DashboardQueueRowsQuery = z.infer<
  typeof dashboardQueueRowsQuerySchema
>;

/** Facilities of one outlet; the FE then reads units per facility. */
export const dashboardFacilityScopeEntrySchema = z.strictObject({
  outletId: outletIdSchema,
  facilityIds: z.array(facilityIdSchema).max(50),
});
export type DashboardFacilityScopeEntry = z.infer<
  typeof dashboardFacilityScopeEntrySchema
>;

/**
 * Facility scope per outlet, after the TEN-03 scope check. The tile calls
 * `GET /api/facility/units?facilityId=` (`getFacilityUnitBoard`) once per id.
 */
export const dashboardFacilityScopeSchema = z.strictObject({
  outlets: z.array(dashboardFacilityScopeEntrySchema).max(100),
});
export type DashboardFacilityScope = z.infer<
  typeof dashboardFacilityScopeSchema
>;

export const dashboardFacilityScopeQuerySchema = clientInputSchema({
  outletIds: z.array(outletIdSchema).min(1).max(50).optional(),
});
export type DashboardFacilityScopeQuery = z.infer<
  typeof dashboardFacilityScopeQuerySchema
>;

// ---- Fixtures ----------------------------------------------------------------
// Small samples for FE mock mode and the contract test. The money figures are
// reconciled with the other WS-11 fixtures (I4, tests/ws11-fixture-reconcile
// .test.mjs): the open day is the owner board's day, the target is its
// sales.target run, the comparison is the previous day of the metric series
// and the closed month is the October every screen shows. Mock helpers that
// show the same tile must read them from here or from the metric fixtures,
// not retype them.

const sampleOutletId = cafeLegendFixtures.outlets[0].id;

const openDayNetSales = metricValueSchema.parse({
  unit: "idr",
  valueIdr: 7_420_000,
});
// 31 October 2026, the last point of the net sales series.
const previousDayNetSales = metricValueSchema.parse(
  netSalesDailySeries.points[6].value,
);

/** Owner "today vs target" tile on the open fixture day: estimate (I2). */
export const ownerTodaySalesValuesFixture = dashboardTileValuesSchema.parse({
  tileKey: "owner.today_sales",
  period: openDayPeriod,
  values: [
    {
      metricCode: "net_sales",
      value: openDayNetSales,
      // sales.target of the owner board.
      target: { unit: "idr", valueIdr: 24_000_000 },
      comparison: compareMetricValues(openDayNetSales, previousDayNetSales),
      finality: "estimate",
    },
  ],
});

/** A closed month: money may be final once the accounting period is closed. */
export const closedMonthSalesValuesFixture = dashboardTileValuesSchema.parse({
  tileKey: "owner.month_sales",
  period: closedMonthPeriod,
  values: [
    {
      metricCode: "net_sales",
      value: { unit: "idr", valueIdr: 412_800_000 },
      target: null,
      comparison: null,
      finality: "final",
    },
  ],
});

export const dashboardValuesFixture = dashboardValuesSchema.parse({
  dashboard: "owner",
  businessDate: "2026-11-01",
  outlets: { kind: "outlets", outletIds: [sampleOutletId] },
  tiles: [ownerTodaySalesValuesFixture],
  generatedAt: "2026-11-01T10:30:00.000Z",
});

export const dashboardQueueRowsFixtures = {
  kitchen_queue: dashboardQueueRowsSchema.parse({
    queue: "kitchen_queue",
    rows: [
      {
        outletId: sampleOutletId,
        ticketId: "01JBQ7Z8K3M4N5P6Q7R8S9T0VW",
        orderLabel: "A-014",
        stationName: "Dapur panas",
        status: "in_progress",
        itemCount: 3,
        createdAt: "2026-11-01T10:20:00.000Z",
        waitingSeconds: 600,
      },
    ],
    hasMore: false,
    generatedAt: "2026-11-01T10:30:00.000Z",
  }),
  waiter_calls: dashboardQueueRowsSchema.parse({
    queue: "waiter_calls",
    rows: [
      {
        outletId: sampleOutletId,
        callId: "call-0001",
        tableLabel: "Meja 7",
        reason: "Minta tagihan",
        status: "open",
        calledAt: "2026-11-01T10:27:00.000Z",
        waitingSeconds: 180,
      },
    ],
    hasMore: false,
    generatedAt: "2026-11-01T10:30:00.000Z",
  }),
  reviews: dashboardQueueRowsSchema.parse({
    queue: "reviews",
    rows: [
      {
        outletId: sampleOutletId,
        reviewId: "review-0001",
        rating: 5,
        excerpt: "Kopinya enak, tempatnya nyaman.",
        source: "google",
        createdAt: "2026-11-01T08:00:00.000Z",
        replied: false,
      },
    ],
    hasMore: false,
    generatedAt: "2026-11-01T10:30:00.000Z",
  }),
  facility_units: dashboardQueueRowsSchema.parse({
    queue: "facility_units",
    rows: cafeLegendFacilities.map((facility) => {
      const units = cafeLegendFacilityUnits.filter(
        (unit) => unit.facilityId === facility.id,
      );
      const count = (status: string) =>
        units.filter((unit) => unit.status === status).length;
      return {
        outletId: facility.outletId,
        facilityId: facility.id,
        facilityName: facility.name,
        facilityType: facility.type,
        unitCounts: {
          available: count("available"),
          in_use: count("in_use"),
          needs_cleaning: count("needs_cleaning"),
          cleaning: count("cleaning"),
          maintenance: count("maintenance"),
        },
      };
    }),
    hasMore: false,
    generatedAt: "2026-11-01T10:30:00.000Z",
  }),
} as const;

/** Facility ids per outlet, derived from the facility fixtures. */
export const dashboardFacilityScopeFixture = dashboardFacilityScopeSchema.parse(
  {
    outlets: [
      {
        outletId: sampleOutletId,
        facilityIds: cafeLegendFacilities
          .filter((facility) => facility.outletId === sampleOutletId)
          .map((facility) => facility.id),
      },
    ],
  },
);
