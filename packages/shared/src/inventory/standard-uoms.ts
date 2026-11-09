// Standard F&B unit catalog and per-outlet stock locations provisioned for
// every new tenant/outlet (PRD v1.7 §3.19 and §16 "Lokasi Stok"; bead
// legend-4ryw). Pure data: the API provisioning service inserts these rows
// idempotently and never touches rows that already exist.

import type { StockLocationType } from "./schemas.ts";

/** Codes are lowercase, unique and at most 10 characters. */
export const STANDARD_UOM_CATALOG: readonly { code: string; name: string }[] = [
  { code: "kg", name: "Kilogram" },
  { code: "g", name: "Gram" },
  { code: "l", name: "Liter" },
  { code: "ml", name: "Mililiter" },
  { code: "pcs", name: "Pieces" },
  { code: "pack", name: "Pack" },
  { code: "ctn", name: "Karton" },
  { code: "btl", name: "Botol" },
  { code: "can", name: "Kaleng" },
  { code: "sachet", name: "Sachet" },
  { code: "box", name: "Dus" },
  { code: "porsi", name: "Porsi" },
];

/** One location per type, created for every outlet. */
export const STANDARD_STOCK_LOCATIONS: readonly {
  type: StockLocationType;
  name: string;
}[] = [
  { type: "warehouse", name: "Gudang Utama" },
  { type: "chiller", name: "Chiller" },
  { type: "freezer", name: "Freezer" },
  { type: "bar", name: "Bar" },
  { type: "kitchen", name: "Dapur" },
  { type: "pastry", name: "Pastry" },
];
