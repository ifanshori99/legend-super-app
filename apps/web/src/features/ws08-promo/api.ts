// One typed caller per promo-admin endpoint (docs/frontend.md "Typed endpoints
// and mock mode"). Components never call these directly: they use the hooks in
// ./hooks.ts, which own cache keys and invalidation. Endpoints come from the
// CRM contract (bead legend-zk25): promotions, stacking policy, vouchers.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createPromotion as createPromotionEndpoint,
  issueVoucher as issueVoucherEndpoint,
  updatePromoStackingPolicy as updateStackingEndpoint,
  updatePromotion as updatePromotionEndpoint,
  validateVoucher as validateVoucherEndpoint,
} from "@starter/shared/crm";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

export const createPromotion = (body: Body<typeof createPromotionEndpoint>) =>
  callEndpoint(createPromotionEndpoint, { body }).then(
    (response) => response.data,
  );

export const updatePromotion = (
  params: Params<typeof updatePromotionEndpoint>,
  body: Body<typeof updatePromotionEndpoint>,
) =>
  callEndpoint(updatePromotionEndpoint, { params, body }).then(
    (response) => response.data,
  );

export const saveStackingPolicy = (body: Body<typeof updateStackingEndpoint>) =>
  callEndpoint(updateStackingEndpoint, { body }).then(
    (response) => response.data,
  );

export const issueVoucher = (body: Body<typeof issueVoucherEndpoint>) =>
  callEndpoint(issueVoucherEndpoint, { body }).then(
    (response) => response.data,
  );

export const validateVoucher = (body: Body<typeof validateVoucherEndpoint>) =>
  callEndpoint(validateVoucherEndpoint, { body }).then(
    (response) => response.data,
  );
