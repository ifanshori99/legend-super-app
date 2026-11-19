// Browser side of the menu bulk import (bead legend-b6r; PRD v1.7 §3 F8,
// §8 "Impor Massal"): full reference reads for the preview, the client-side
// CSV template, and the sequential commit. Parsing and validation stay pure
// in ./import-lib.ts; this file is the only place that writes.
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";
import { callEndpoint } from "@/lib/api/endpoint";
import { ApiError } from "@/lib/api/errors";
import { idr } from "@starter/shared/core";
import {
  createItem as createItemEndpoint,
  listCategories,
  listPriceListItems,
  listPriceLists,
  listStations,
  setPriceListItems as setPriceListItemsEndpoint,
  type Category,
  MENU_IMPORT_MAX_FILE_BYTES,
  type MenuImportReport,
  type MenuImportRow,
  type PriceList,
  type Station,
} from "@starter/shared/menu";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import {
  IMPORT_COLUMNS,
  importRowToCells,
  mergePriceListEntries,
  pickImportPriceList,
  toCsvText,
  type ImportRowResult,
  type PriceEntry,
} from "./import-lib";
import { businessDateToday } from "./lib";

export const IMPORT_TEMPLATE_FILENAME = "template-impor-menu.csv";

/** File picker filter: the server parses both CSV and XLSX. */
export const IMPORT_SERVER_ACCEPT =
  ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: spreading a whole megabyte into fromCharCode overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The picked file is over the server's size limit; nothing was sent. */
export class ImportFileTooLargeError extends Error {
  constructor() {
    super("Import file is over the size limit.");
    this.name = "ImportFileTooLargeError";
  }
}

/**
 * The server's own text, only when it is a `MENU_IMPORT_*` refusal (always
 * Indonesian). Network, auth and generic errors return null so the screen
 * shows its Indonesian fallback instead of an English transport message.
 */
export function importServerMessage(error: unknown): string | null {
  return error instanceof ApiError && error.code.startsWith("MENU_IMPORT_")
    ? error.message
    : null;
}

/**
 * XLSX (and CSV) through the existing server import (legend-az32): send the
 * file as base64 and read the per-row report back. `validate` writes nothing;
 * `preview` also returns each normalised row. Throws
 * `ImportFileTooLargeError` before reading a file over 1 MB, and `ApiError` on
 * a whole-file refusal (413, 415, 422 MENU_IMPORT_*).
 */
export async function analyzeImportOnServer(
  file: File,
  mode: "validate" | "preview" = "preview",
  signal?: AbortSignal,
): Promise<MenuImportReport> {
  if (file.size > MENU_IMPORT_MAX_FILE_BYTES)
    throw new ImportFileTooLargeError();
  const dataBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  const result = await apiFetch<{ data: MenuImportReport }>(
    `/api/menu/import/${mode}`,
    { method: "POST", body: { fileName: file.name, dataBase64 }, signal },
  );
  return result.data;
}

export type ImportReferences = {
  categories: Category[];
  stations: Station[];
  priceLists: PriceList[];
};

type CursorPage<Row> = {
  data: Row[];
  meta: { nextCursor: string | null };
};

/**
 * Reads every page of a cursor list. The import must validate against the
 * complete category/station catalog and, at commit time, send the complete
 * price grid — reading only the first page would drop rows beyond `limit`.
 */
async function readAllPages<Row>(
  read: (cursor: string | undefined) => Promise<CursorPage<Row>>,
): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  // A broken cursor loop must fail loudly instead of loading forever.
  for (let page = 0; page < 50; page += 1) {
    const result = await read(cursor);
    rows.push(...result.data);
    if (!result.meta.nextCursor) return rows;
    cursor = result.meta.nextCursor;
  }
  throw new Error("Pagination did not terminate while reading import data.");
}

export async function fetchImportReferences(): Promise<ImportReferences> {
  const [categories, stations, priceLists] = await Promise.all([
    readAllPages((cursor) =>
      callEndpoint(listCategories, {
        query: cursor ? { limit: 100, cursor } : { limit: 100 },
      }),
    ),
    readAllPages((cursor) =>
      callEndpoint(listStations, {
        query: cursor ? { limit: 100, cursor } : { limit: 100 },
      }),
    ),
    readAllPages((cursor) =>
      callEndpoint(listPriceLists, {
        query: cursor ? { limit: 100, cursor } : { limit: 100 },
      }),
    ),
  ]);
  return { categories, stations, priceLists };
}

/** One key for the whole reference read so the loader and screen share it. */
export const importReferencesQuery = queryOptions({
  queryKey: ["menuImport", "references"] as const,
  queryFn: fetchImportReferences,
});

const TEMPLATE_EXAMPLE_ROWS: readonly MenuImportRow[] = [
  {
    category: "Kopi",
    name: "Espresso",
    description: "Espresso",
    type: "single",
    priceIdr: idr(20000),
    station: "Kopi",
    course: "drink",
    labels: [],
    allergens: [],
  },
];

/**
 * The template is generated in the browser: no server endpoint exists for it.
 * The header is exactly the nine `importRowSchema` columns; the example row is
 * an inline sample (`TEMPLATE_EXAMPLE_ROWS`, same content the shared fixtures
 * held), so the template never loads the fixture catalog. The UTF-8 BOM
 * keeps Excel from mangling the Indonesian text; `analyzeImport` strips it.
 */
export function templateCsvText(): string {
  return toCsvText([
    [...IMPORT_COLUMNS],
    ...TEMPLATE_EXAMPLE_ROWS.map((row) => importRowToCells(row)),
  ]);
}

export function downloadImportTemplate(): void {
  const blob = new Blob([`\uFEFF${templateCsvText()}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = IMPORT_TEMPLATE_FILENAME;
  // Safari needs the anchor in the document for a programmatic download.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next task so the navigation has started in every browser.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export type ImportCommitRowResult = {
  rowNumber: number;
  name: string;
  status: "created" | "failed";
  itemId?: string;
  /** The API's own message (already Indonesian) for a failed row. */
  message?: string;
};

export type ImportCommitOutcome = {
  results: ImportCommitRowResult[];
  /** The list the prices were written to, or null when there is none. */
  priceList: PriceList | null;
  priceSaved: boolean;
  /** Set when the items were created but the price grid write failed. */
  priceError?: string;
};

async function readCompletePriceGrid(
  priceListId: string,
): Promise<PriceEntry[]> {
  const rows = await readAllPages((cursor) =>
    callEndpoint(listPriceListItems, {
      params: { priceListId },
      query: cursor ? { limit: 100, cursor } : { limit: 100 },
    }),
  );
  // The write body is a strict schema (`priceListEntrySchema`): send only the
  // three entry fields. Passing the stored rows through with their `id`,
  // `tenantId` and `priceListId` fails validation and drops the whole write.
  return rows.map(({ itemId, variantId, priceIdr }) => ({
    itemId,
    variantId,
    priceIdr,
  }));
}

/**
 * Creates the valid rows one by one (sequential, so progress is honest and
 * one failure never rolls back the rows before it), then appends every price
 * to the outlet's dine-in list in one `setPriceListItems` write containing the
 * complete union of stored entries and the new rows.
 *
 * Owner Q23: the template has no photo column, so `isActive` is always false.
 * Imported items are drafts until someone uploads a photo.
 */
export async function commitImport(input: {
  rows: readonly ImportRowResult[];
  onProgress?: (done: number, total: number) => void;
}): Promise<ImportCommitOutcome> {
  const valid = input.rows.filter((row) => row.valid);
  const results: ImportCommitRowResult[] = [];
  const additions: PriceEntry[] = [];

  for (let index = 0; index < valid.length; index += 1) {
    const row = valid[index];
    const parsed = row.parsed;
    try {
      if (
        !parsed.categoryId ||
        !parsed.stationId ||
        !parsed.type ||
        parsed.priceIdr === undefined
      )
        throw new Error("Preview row is missing a resolved reference.");
      const created = await callEndpoint(
        createItemEndpoint,
        {
          body: {
            categoryId: parsed.categoryId,
            name: row.raw.name,
            description: row.raw.description,
            type: parsed.type,
            stationId: parsed.stationId,
            course: parsed.course,
            labels: parsed.labels,
            allergens: parsed.allergens,
            // Q23: drafts only; never publish from the importer.
            isActive: false,
          },
        },
        { headers: { "Idempotency-Key": newIdempotencyKey() } },
      );
      results.push({
        rowNumber: row.rowNumber,
        name: row.raw.name,
        status: "created",
        itemId: created.data.id,
      });
      additions.push({
        itemId: created.data.id,
        variantId: null,
        priceIdr: parsed.priceIdr,
      });
    } catch (error) {
      results.push({
        rowNumber: row.rowNumber,
        name: row.raw.name,
        status: "failed",
        message: error instanceof ApiError ? error.message : undefined,
      });
    }
    input.onProgress?.(index + 1, valid.length);
  }

  if (additions.length === 0)
    return { results, priceList: null, priceSaved: false };

  let priceList: PriceList | null = null;
  try {
    // Re-read at commit time (PRD §8 "Harga per Kanal"): the grid write
    // replaces every entry, so stale reads would delete concurrent edits.
    const lists = await readAllPages((cursor) =>
      callEndpoint(listPriceLists, {
        query: cursor ? { limit: 100, cursor } : { limit: 100 },
      }),
    );
    priceList = pickImportPriceList(lists, businessDateToday()) ?? null;
    if (!priceList) return { results, priceList: null, priceSaved: false };
    const existing = await readCompletePriceGrid(priceList.id);
    const entries = mergePriceListEntries(existing, additions);
    await callEndpoint(setPriceListItemsEndpoint, {
      params: { priceListId: priceList.id },
      body: { items: entries },
    });
    return { results, priceList, priceSaved: true };
  } catch (error) {
    return {
      results,
      priceList,
      priceSaved: false,
      // An empty string marks "attempted and failed" without inventing UI copy
      // here; the screen substitutes its catalog's generic message.
      priceError: error instanceof ApiError ? error.message : "",
    };
  }
}
