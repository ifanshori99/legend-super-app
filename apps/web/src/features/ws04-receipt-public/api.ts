// One function per endpoint; components use the hooks in ./hooks.ts.
import { callEndpoint } from "@/lib/api/endpoint.ts";
import { publicApiUrl } from "@/lib/env";
import { getPublicReceipt } from "./endpoints.ts";

export async function fetchPublicReceipt(token: string, signal?: AbortSignal) {
  const { data } = await callEndpoint(
    getPublicReceipt,
    { params: { token } },
    { signal },
  );
  return data;
}

export type ReceiptPdfKind = "receipt" | "kuitansi";

/** Direct PDF download for the link's token (`?kind=receipt|kuitansi`). */
export function receiptPdfUrl(token: string, kind: ReceiptPdfKind): string {
  return publicApiUrl(
    `/api/public/receipts/${encodeURIComponent(token)}/pdf?kind=${kind}`,
  );
}
