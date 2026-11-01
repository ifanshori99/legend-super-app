// Mock handlers for the floor editor (docs/frontend.md "Typed endpoints and
// mock mode"). `VITE_API_MOCK=true` makes the screens fully workable: the
// handlers serve the Cafe Legend fixtures from @starter/shared/qr-order and
// keep edits in a mock store until reset.
//
// The handlers refuse what the API must refuse, so the screens show the real
// failure modes: a duplicate table number (409), a zone that still holds
// tables (409) and a table with an open session (409, PRD ORD-10).
import { idr, toIsoDateTime } from "@starter/shared/core";
import {
  cafeLegendQrOrderFixtures as fixtures,
  createFloorZone,
  createTable,
  deleteFloorZone,
  deleteTable,
  floorZoneSchema,
  getCurrentFloor,
  issueTableQr,
  rotateTableQr,
  saveFloorLayout,
  tableQrSchema,
  tableSchema,
  updateFloorZone,
  updateTable,
} from "@starter/shared/qr-order";
import type {
  FloorBoard,
  FloorZone,
  Table,
  TableLiveStatus,
  TableQr,
} from "@starter/shared/qr-order";
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";

const seedBoard: FloorBoard = fixtures.floorBoard;
const store = createMockStore<FloorBoard>(() => ({
  ...seedBoard,
  zones: [...seedBoard.zones],
  tables: seedBoard.tables.map((row) => ({ ...row })),
}));

const now = () => toIsoDateTime(new Date());

/** Fixture ids stop below 900000, so new rows never collide with them. */
let sequence = 900_000;
function nextId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function notFound(what: string): never {
  throw new ApiError(404, "NOT_FOUND", `${what} tidak ditemukan.`);
}

function conflict(message: string): never {
  throw new ApiError(409, "CONFLICT", message);
}

function board(): FloorBoard {
  return store.get();
}

function commit(next: Partial<FloorBoard>) {
  store.set({ ...board(), ...next, generatedAt: now() });
}

function commitTables(tables: TableLiveStatus[]) {
  commit({ tables });
}

function rowOf(tableId: string): TableLiveStatus {
  const row = board().tables.find((entry) => entry.table.id === tableId);
  return row ?? notFound("Meja");
}

function tableOf(tableId: string): Table {
  return rowOf(tableId).table;
}

function zoneOf(zoneId: string): FloorZone {
  const zone = board().zones.find((entry) => entry.id === zoneId);
  return zone ?? notFound("Zona");
}

function assertUniqueCode(code: string, exceptTableId?: string) {
  const taken = board().tables.some(
    (row) => row.table.code === code && row.table.id !== exceptTableId,
  );
  if (taken) conflict(`Kode meja ${code} sudah dipakai.`);
}

// ---- Read ---------------------------------------------------------------

registerMock(getCurrentFloor, ({ scenario }) => {
  if (scenario === "empty")
    return {
      data: {
        outletId: seedBoard.outletId,
        zones: [],
        tables: [],
        generatedAt: now(),
      },
    };
  return { data: board() };
});

// ---- Zones --------------------------------------------------------------

registerMock(createFloorZone, ({ body }) => {
  const zone = floorZoneSchema.parse({
    id: nextId(),
    tenantId: seedBoard.zones[0]?.tenantId,
    outletId: seedBoard.outletId,
    name: body.name,
    paymentMode: body.paymentMode,
    serviceChargeBp: body.serviceChargeBp,
    minimumSpendIdr: body.minimumSpendIdr,
    hours: body.hours,
    status: body.status,
    sortOrder: body.sortOrder,
  });
  commit({ zones: [...board().zones, zone] });
  return { data: zone };
});

registerMock(updateFloorZone, ({ params, body }) => {
  const current = zoneOf(params.zoneId);
  const zone = floorZoneSchema.parse({
    ...current,
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.paymentMode === undefined
      ? {}
      : { paymentMode: body.paymentMode }),
    ...(body.serviceChargeBp === undefined
      ? {}
      : { serviceChargeBp: body.serviceChargeBp }),
    ...(body.minimumSpendIdr === undefined
      ? {}
      : { minimumSpendIdr: body.minimumSpendIdr }),
    ...(body.hours === undefined ? {} : { hours: body.hours }),
    ...(body.status === undefined ? {} : { status: body.status }),
    ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
  });
  commit({
    zones: board().zones.map((entry) => (entry.id === zone.id ? zone : entry)),
  });
  return { data: zone };
});

registerMock(deleteFloorZone, ({ params }) => {
  zoneOf(params.zoneId);
  const used = board().tables.filter(
    (row) => row.table.zoneId === params.zoneId,
  ).length;
  if (used > 0)
    conflict(`Zona masih berisi ${used} meja. Pindahkan atau hapus dulu.`);
  commit({ zones: board().zones.filter((zone) => zone.id !== params.zoneId) });
  return undefined;
});

// ---- Tables -------------------------------------------------------------

registerMock(createTable, ({ body }) => {
  zoneOf(body.zoneId);
  assertUniqueCode(body.code);
  const table = tableSchema.parse({
    id: nextId(),
    tenantId: seedBoard.tables[0]?.table.tenantId,
    outletId: seedBoard.outletId,
    zoneId: body.zoneId,
    code: body.code,
    capacity: body.capacity,
    type: body.type,
    layout: body.layout,
    status: body.status,
  });
  commitTables([
    ...board().tables,
    {
      table,
      session: null,
      openServiceRequestCount: 0,
      outstandingIdr: idr(0),
    },
  ]);
  return { data: table };
});

registerMock(updateTable, ({ params, body }) => {
  const current = tableOf(params.tableId);
  if (body.zoneId !== undefined) zoneOf(body.zoneId);
  if (body.code !== undefined) assertUniqueCode(body.code, current.id);
  // The editor only activates or deactivates; live states stay on the board.
  if (body.status === "available" && current.status !== "inactive")
    conflict("Meja ini sudah aktif.");
  if (body.status === "inactive") {
    if (rowOf(current.id).session || current.status !== "available")
      conflict(
        "Meja yang sedang dipakai tidak bisa dinonaktifkan. Kosongkan dulu (ORD-10).",
      );
  }
  const table = tableSchema.parse({
    ...current,
    ...(body.zoneId === undefined ? {} : { zoneId: body.zoneId }),
    ...(body.code === undefined ? {} : { code: body.code }),
    ...(body.capacity === undefined ? {} : { capacity: body.capacity }),
    ...(body.type === undefined ? {} : { type: body.type }),
    ...(body.layout === undefined ? {} : { layout: body.layout }),
    ...(body.status === undefined ? {} : { status: body.status }),
  });
  commitTables(
    board().tables.map((row) =>
      row.table.id === table.id ? { ...row, table } : row,
    ),
  );
  return { data: table };
});

registerMock(deleteTable, ({ params }) => {
  const row = rowOf(params.tableId);
  // ORD-10: a table with an open session cannot leave the floor.
  if (row.session)
    conflict("Meja masih punya sesi aktif. Tutup sesinya dulu (ORD-10).");
  commitTables(
    board().tables.filter((entry) => entry.table.id !== row.table.id),
  );
  return undefined;
});

/** Moves many tables at once; answers the tables that were saved. */
registerMock(saveFloorLayout, ({ body }) => {
  const saved = new Map<string, Table>();
  for (const placement of body.placements) {
    const table = tableOf(placement.tableId);
    saved.set(
      table.id,
      tableSchema.parse({ ...table, layout: placement.layout }),
    );
  }
  commitTables(
    board().tables.map((row) => {
      const next = saved.get(row.table.id);
      return next ? { ...row, table: next } : row;
    }),
  );
  return { data: [...saved.values()] };
});

// ---- Signed QR ----------------------------------------------------------

const SIGNATURE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Deterministic stand-in for the server's HMAC signature, so a fixture QR is
 * stable across renders and prints. The real API signs with the tenant key
 * (§3 "Keamanan Sesi", ORD-04); the client never verifies it.
 */
function mockSignature(seed: string): string {
  let hash = 2166136261;
  let out = "";
  for (let index = 0; index < 43; index += 1) {
    for (const character of seed) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    hash = Math.imul(hash ^ index, 16777619) >>> 0;
    out += SIGNATURE_ALPHABET[hash % 64];
  }
  return out;
}

const base64Url = (value: string) =>
  btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

// Stored QR per table: reprint returns it unchanged, only "Ganti QR" rotates.
const issuedQr = new Map<string, { qr: TableQr; generation: number }>();

function mintQr(tableId: string, generation: number): TableQr {
  const seed = `${tableId}:${generation}`;
  const token = `v1.${base64Url(`${generation}:${tableId}:qr-2026-11`)}.${mockSignature(seed)}`;
  return tableQrSchema.parse({
    tableId,
    token,
    url: `https://legend.example/t/${token}`,
    issuedAt: now(),
  });
}

registerMock(issueTableQr, ({ params }) => {
  const table = tableOf(params.tableId);
  const stored = issuedQr.get(table.id);
  if (stored) return { data: stored.qr };
  const qr = mintQr(table.id, 1);
  issuedQr.set(table.id, { qr, generation: 1 });
  return { data: qr };
});

registerMock(rotateTableQr, ({ params }) => {
  const table = tableOf(params.tableId);
  const generation = (issuedQr.get(table.id)?.generation ?? 0) + 1;
  const qr = mintQr(table.id, generation);
  issuedQr.set(table.id, { qr, generation });
  return { data: qr };
});
