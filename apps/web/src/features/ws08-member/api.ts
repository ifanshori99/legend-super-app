// Member PWA endpoints (PRD v1.7 §3.20 "Halaman Member"). One function per
// contract endpoint from @starter/shared/crm; the typed caller validates the
// path/query/body and the response shape, and mock mode serves the same
// functions from the domain fixtures (features/ws08-member/mock.ts).
//
// Lists return their cursor page unchanged (`{ data, meta }`); single-resource
// endpoints unwrap the `{ data }` envelope so components see the resource.
import {
  getMemberOverview,
  issueMemberQrToken,
  listMemberFavorites,
  listMemberMissions,
  listMemberPoints,
  listMemberRewards,
  listMemberVisits,
  listMemberVouchers,
  redeemReward,
  updateMemberConsent,
} from "@starter/shared/crm";
import type { ConsentPurpose } from "@starter/shared/crm";
import { callEndpoint } from "@/lib/api/endpoint";
import { buildQrTokenBody } from "./qr-token";

/** Page size for the member's own lists; small enough for a phone screen. */
export const MEMBER_PAGE_SIZE = 10;

export type PageInput = { limit: number; cursor?: string };

export function fetchMemberOverview(signal?: AbortSignal) {
  return callEndpoint(getMemberOverview, undefined, { signal }).then(
    (response) => response.data,
  );
}

export function fetchMemberPoints(input: PageInput, signal?: AbortSignal) {
  return callEndpoint(listMemberPoints, { query: input }, { signal });
}

export function fetchMemberRewards(signal?: AbortSignal) {
  return callEndpoint(listMemberRewards, { query: { limit: 50 } }, { signal });
}

export function fetchMemberMissions(signal?: AbortSignal) {
  return callEndpoint(listMemberMissions, undefined, { signal }).then(
    (response) => response.data,
  );
}

export function fetchMemberVouchers(signal?: AbortSignal) {
  return callEndpoint(listMemberVouchers, { query: { limit: 50 } }, { signal });
}

export function fetchMemberVisits(input: PageInput, signal?: AbortSignal) {
  return callEndpoint(listMemberVisits, { query: input }, { signal });
}

export function fetchMemberFavorites(signal?: AbortSignal) {
  return callEndpoint(listMemberFavorites, undefined, { signal }).then(
    (response) => response.data,
  );
}

/** LOY-03: the idempotency key makes a retried tap spend points once. */
export function requestRedemption(rewardId: string, idempotencyKey: string) {
  return callEndpoint(redeemReward, {
    params: { rewardId },
    body: { idempotencyKey },
  }).then((response) => response.data);
}

export function saveMemberConsent(input: {
  purpose: ConsentPurpose;
  granted: boolean;
  policyVersion: string;
}) {
  return callEndpoint(updateMemberConsent, { body: input }).then(
    (response) => response.data,
  );
}

/** 1150: mints a 120 s single-use token; `input` binds it to one order and amount of points. */
export function requestMemberQrToken(
  input?: { orderId?: string; points?: number },
  signal?: AbortSignal,
) {
  return callEndpoint(
    issueMemberQrToken,
    { body: buildQrTokenBody(input) },
    { signal },
  ).then((response) => response.data);
}
