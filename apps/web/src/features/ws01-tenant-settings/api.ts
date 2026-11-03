// Typed endpoint callers for the tenant settings screens (docs/frontend.md,
// "Typed endpoints and mock mode"). Components use the hooks in ./hooks.ts.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { uploadMenuImage as uploadMenuImageEndpoint } from "@starter/shared/menu";
import { orgEndpoints, textOverrideEndpoints } from "@starter/shared/platform";
import { callEndpoint } from "@/lib/api/endpoint";
import { deleteTextOverride, importOrgConfig } from "./endpoints";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

export const upsertIntegrationCall = (
  body: Body<typeof orgEndpoints.upsertIntegration>,
) => callEndpoint(orgEndpoints.upsertIntegration, { body });

export const setIntegrationStatusCall = (
  integrationId: string,
  status: "active" | "disabled",
) =>
  callEndpoint(orgEndpoints.setIntegrationStatus, {
    params: { integrationId },
    body: { status },
  });

export const checkThemeCall = (body: Body<typeof orgEndpoints.checkTheme>) =>
  callEndpoint(orgEndpoints.checkTheme, { body });

export const createThemeDraftCall = (
  body: Body<typeof orgEndpoints.createThemeDraft>,
) => callEndpoint(orgEndpoints.createThemeDraft, { body });

export const activateThemeCall = (themeId: string) =>
  callEndpoint(orgEndpoints.activateTheme, { params: { themeId } });

/** The logo is stored as media; the menu media endpoint is the only upload today. */
export const uploadLogoCall = (body: Body<typeof uploadMenuImageEndpoint>) =>
  callEndpoint(uploadMenuImageEndpoint, { body });

export const exportConfigCall = (
  body: Body<typeof orgEndpoints.exportConfig>,
) => callEndpoint(orgEndpoints.exportConfig, { body });

export const importConfigCall = (body: Body<typeof importOrgConfig>) =>
  callEndpoint(importOrgConfig, { body });

export const upsertTextOverrideCall = (
  body: Body<typeof textOverrideEndpoints.putTextOverride>,
) => callEndpoint(textOverrideEndpoints.putTextOverride, { body });

export const deleteTextOverrideCall = (overrideId: string) =>
  callEndpoint(deleteTextOverride, { params: { overrideId } });
