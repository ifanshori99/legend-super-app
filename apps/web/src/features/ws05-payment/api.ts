// One function per customer payment endpoint; components never call these
// directly (they use the hooks in ./hooks.ts). Contracts and fixtures live in
// @starter/shared/payment, so the mock and the future API share one shape.
import {
  createPaymentIntent,
  getPaymentIntent,
  getPaymentLink,
  refreshPaymentIntent,
  requestPayAtCashier,
  type CreatePaymentIntentInput,
} from "@starter/shared/payment";
import { callEndpoint } from "@/lib/api/endpoint";

export async function fetchPaymentLink(token: string, signal?: AbortSignal) {
  const { data } = await callEndpoint(
    getPaymentLink,
    { params: { token } },
    { signal },
  );
  return data;
}

export async function fetchPaymentIntent(
  token: string,
  intentId: string,
  signal?: AbortSignal,
) {
  const { data } = await callEndpoint(
    getPaymentIntent,
    { params: { token, intentId } },
    { signal },
  );
  return data;
}

export async function startPaymentIntent(
  token: string,
  input: CreatePaymentIntentInput,
) {
  const { data } = await callEndpoint(createPaymentIntent, {
    params: { token },
    body: input,
  });
  return data;
}

export async function refreshIntentCode(token: string, intentId: string) {
  const { data } = await callEndpoint(refreshPaymentIntent, {
    params: { token, intentId },
  });
  return data;
}

export async function requestCashierPayment(token: string) {
  const { data } = await callEndpoint(requestPayAtCashier, {
    params: { token },
  });
  return data;
}
