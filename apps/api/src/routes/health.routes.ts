import { Router, type Express } from "express";
import { checkDatabase } from "../db";
import { logger } from "../lib/logger";
import {
  createScannerHealthCheck,
  type ScannerHealth,
} from "../services/clamd-scanner";
import type { MalwareScanner } from "../services/core-image";

export const healthRouter = Router();

const SCANNER_HEALTH_LOCAL_KEY = "scannerHealthCheck";

/** Called once by createApp with the storage runtime's scanner (or null). */
export function setScannerHealth(
  app: Express,
  scanner: MalwareScanner | null | undefined,
): void {
  app.locals[SCANNER_HEALTH_LOCAL_KEY] = createScannerHealthCheck(
    scanner ?? null,
  );
}

// Liveness: the process answers. Does not touch the database, so an outage
// there never makes an orchestrator restart a healthy process. The malware
// scanner is reported (cached PING) but never changes the status code.
healthRouter.get("/", async (req, res) => {
  const check = req.app.locals[SCANNER_HEALTH_LOCAL_KEY] as
    (() => Promise<ScannerHealth>) | undefined;
  res.json({ status: "ok", scanner: check ? await check() : "disabled" });
});

// Readiness: the database answers too.
healthRouter.get("/ready", async (_req, res) => {
  try {
    await checkDatabase();
    res.json({ status: "ok", database: "ok" });
  } catch (err) {
    logger.warn({ err }, "Readiness check: PostgreSQL is unreachable");
    res.status(503).json({ status: "unavailable", database: "unreachable" });
  }
});
