// Text overrides (PRD v1.7 §3 F4 "Teks & Kamus Istilah") and versioned consents
// (PRD §2 privacy, LOY-04).
// - `textOverridesRouter`: mount at /api/org/text-overrides.
// - `consentRouter`: mount at /api/consents.
// The tenant comes from the server-minted context (TEN-02).

import { Router } from "express";
import {
  listConsentsQuerySchema,
  listTextOverridesQuerySchema,
  recordConsentInputSchema,
  textOverrideEndpoints,
} from "@starter/shared/platform";
import { textOverrideInputSchema } from "@starter/shared/text";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { listConsents, recordConsent } from "../services/consent.service.ts";
import {
  deleteTextOverride,
  listTextOverrides,
  putTextOverride,
} from "../services/text-override.service.ts";

const base = [
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
];

// ------------------------------------------------------------ text overrides

export const textOverridesRouter = Router();
const manageSettings = requireTenantPermission("org.settings.manage");

textOverridesRouter.get("/", ...base, manageSettings, async (req, res) => {
  const query = listTextOverridesQuerySchema.parse(req.query);
  res.json(await listTextOverrides(getScopedTenantContext(req), query));
});

textOverridesRouter.put(
  "/",
  ...base,
  manageSettings,
  jsonBody,
  async (req, res) => {
    const input = textOverrideInputSchema.parse(req.body);
    res.json({
      data: await putTextOverride(
        getScopedTenantContext(req),
        input,
        getAuth(req).user.id,
      ),
    });
  },
);

textOverridesRouter.delete(
  "/:overrideId",
  ...base,
  manageSettings,
  async (req, res) => {
    const { overrideId } =
      textOverrideEndpoints.deleteTextOverride.params.parse(req.params);
    await deleteTextOverride(
      getScopedTenantContext(req),
      overrideId,
      getAuth(req).user.id,
    );
    res.status(204).end();
  },
);

// ------------------------------------------------------------------ consents

export const consentRouter = Router();
const viewCustomers = requireTenantPermission("crm.customer.view");
// legend-ovi8: recording consent is a write, not a customer-view read. The
// cashier template is outlet-scoped, so the gate mints the caller's reachable
// scope (tenant or their outlets) instead of demanding a tenant-wide grant;
// recordConsent limits outlet-scoped callers to source "cashier".
const recordConsentPermission = requireMenuPermission("crm.consent.record");

consentRouter.get("/", ...base, viewCustomers, async (req, res) => {
  const query = listConsentsQuerySchema.parse(req.query);
  res.json(await listConsents(getScopedTenantContext(req), query));
});

consentRouter.post(
  "/",
  ...base,
  recordConsentPermission,
  jsonBody,
  async (req, res) => {
    const input = recordConsentInputSchema.parse(req.body);
    const consent = await recordConsent(
      getScopedTenantContext(req),
      input,
      getAuth(req).user.id,
    );
    res.status(201).json({ data: consent });
  },
);
