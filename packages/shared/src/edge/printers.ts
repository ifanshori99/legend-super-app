// Cloud printer registry contract (bead legend-2lp.6; PRD v1.7 §3 F5 "Print
// Agent", "Registri Perangkat"). Back office only: `device.registry.manage` on
// the printer's outlet. The tenant always comes from the session (TEN-02).
//
// Input rules mirror the CHECK constraints of `edge_printers`
// (db/schema/edge-print.ts), so a bad request is a 422 here instead of a
// database error: private LAN IPv4 literal only, raw-print ports 9100-9102,
// Linux USB printer nodes, paper 32 or 48 characters, a station only for the
// station role.

import {
  z,
  clientInputSchema,
  dataResponseSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";

export const printerRoleSchema = z.enum(["receipt", "station"]);
export const printerTransportSchema = z.enum(["network", "usb"]);
export const printerPaperWidthSchema = z.union([z.literal(32), z.literal(48)]);
export const printerStatusSchema = z.enum(["unknown", "online", "offline"]);

export const PRINTER_PORTS = [9100, 9101, 9102] as const;
export const printerPortSchema = z
  .number()
  .int()
  .min(PRINTER_PORTS[0])
  .max(PRINTER_PORTS[2]);

const IPV4 =
  /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;

/** True for a dotted-quad in 10/8, 172.16/12 or 192.168/16. */
export function isPrivateLanIpv4(host: string): boolean {
  if (!IPV4.test(host)) return false;
  const [a, b] = host.split(".").map(Number) as [number, number];
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

export const printerHostSchema = z
  .string()
  .refine(isPrivateLanIpv4, "Host harus alamat IPv4 jaringan lokal (LAN).");

export const printerDevicePathSchema = z
  .string()
  .regex(/^\/dev\/(usb\/lp|lp)[0-9]+$/, "Jalur perangkat USB tidak valid.");

const labelSchema = z.string().trim().min(1).max(255);

const printerParams = z.strictObject({ printerId: uuidSchema });
export { printerParams };

type ConnectionFields = {
  transport?: "network" | "usb";
  host?: string;
  port?: number;
  devicePath?: string;
};

type ConnectionIssue = { path: string; message: string };

/** The transport check of the table: network = host + port only, usb = path only. */
function connectionIssues(value: ConnectionFields): ConnectionIssue[] {
  const { transport, host, devicePath } = value;
  const issues: ConnectionIssue[] = [];
  if (transport === undefined) {
    for (const key of ["host", "port", "devicePath"] as const)
      if (value[key] !== undefined)
        issues.push({
          path: key,
          message: "Kirim transport bersama pengaturan koneksi.",
        });
  } else if (transport === "network") {
    if (host === undefined)
      issues.push({
        path: "host",
        message: "Host wajib untuk printer jaringan.",
      });
    if (devicePath !== undefined)
      issues.push({
        path: "devicePath",
        message: "Printer jaringan tidak memakai devicePath.",
      });
  } else {
    if (devicePath === undefined)
      issues.push({
        path: "devicePath",
        message: "devicePath wajib untuk printer USB.",
      });
    for (const key of ["host", "port"] as const)
      if (value[key] !== undefined)
        issues.push({
          path: key,
          message: "Printer USB tidak memakai host atau port.",
        });
  }
  return issues;
}

const connectionShape = {
  transport: printerTransportSchema,
  host: printerHostSchema.optional(),
  port: printerPortSchema.optional(),
  devicePath: printerDevicePathSchema.optional(),
};

export const createPrinterBodySchema = clientInputSchema({
  outletId: outletIdSchema,
  label: labelSchema,
  role: printerRoleSchema,
  stationId: uuidSchema.nullable().optional(),
  ...connectionShape,
  paperWidth: printerPaperWidthSchema.optional(),
  fallbackPrinterId: uuidSchema.nullable().optional(),
}).superRefine((value, ctx) => {
  for (const issue of connectionIssues(value))
    ctx.addIssue({
      code: "custom",
      path: [issue.path],
      message: issue.message,
    });
  if (value.role === "receipt" && value.stationId)
    ctx.addIssue({
      code: "custom",
      path: ["stationId"],
      message: "Stasiun hanya untuk printer berperan station.",
    });
});
export type CreatePrinterBody = z.infer<typeof createPrinterBodySchema>;

/**
 * A partial update. Connection fields are all-or-nothing: send `transport`
 * with the fields that belong to it, or none of them.
 */
export const updatePrinterBodySchema = clientInputSchema({
  label: labelSchema.optional(),
  role: printerRoleSchema.optional(),
  stationId: uuidSchema.nullable().optional(),
  transport: connectionShape.transport.optional(),
  host: connectionShape.host,
  port: connectionShape.port,
  devicePath: connectionShape.devicePath,
  paperWidth: printerPaperWidthSchema.optional(),
  fallbackPrinterId: uuidSchema.nullable().optional(),
}).superRefine((value, ctx) => {
  for (const issue of connectionIssues(value))
    ctx.addIssue({
      code: "custom",
      path: [issue.path],
      message: issue.message,
    });
  if (value.role === "receipt" && value.stationId)
    ctx.addIssue({
      code: "custom",
      path: ["stationId"],
      message: "Stasiun hanya untuk printer berperan station.",
    });
  if (Object.keys(value).length === 0)
    ctx.addIssue({
      code: "custom",
      message: "Tidak ada perubahan yang dikirim.",
    });
});
export type UpdatePrinterBody = z.infer<typeof updatePrinterBodySchema>;

export const printerListQuerySchema = z.strictObject({
  outletId: outletIdSchema,
});
export type PrinterListQuery = z.infer<typeof printerListQuerySchema>;

/** A printer as the back office sees it. */
export const printerSchema = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  id: uuidSchema,
  label: z.string(),
  role: printerRoleSchema,
  stationId: uuidSchema.nullable(),
  transport: printerTransportSchema,
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  devicePath: z.string().nullable(),
  paperWidth: printerPaperWidthSchema,
  fallbackPrinterId: uuidSchema.nullable(),
  status: printerStatusSchema,
  lastSeenAt: isoDateTimeSchema.nullable(),
  offlineSince: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Printer = z.infer<typeof printerSchema>;

export const listPrinters = defineEndpoint({
  method: "GET",
  path: "/api/printers",
  query: printerListQuerySchema,
  response: dataResponseSchema(z.array(printerSchema)),
});

export const getPrinter = defineEndpoint({
  method: "GET",
  path: "/api/printers/:printerId",
  params: printerParams,
  response: dataResponseSchema(printerSchema),
});

export const createPrinter = defineEndpoint({
  method: "POST",
  path: "/api/printers",
  body: createPrinterBodySchema,
  response: dataResponseSchema(printerSchema),
});

export const updatePrinter = defineEndpoint({
  method: "PATCH",
  path: "/api/printers/:printerId",
  params: printerParams,
  body: updatePrinterBodySchema,
  response: dataResponseSchema(printerSchema),
});

/** 409 while another printer falls back to it or it has print jobs. */
export const deletePrinter = defineEndpoint({
  method: "DELETE",
  path: "/api/printers/:printerId",
  params: printerParams,
});
