import { useEffect } from "react";
import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  MemberPointsRedeemStatus,
  MemberPointsRedeemStatusInput,
  MemberQrToken,
} from "@starter/shared/crm";
import { memberKeys } from "../ws08-member/queries";
import { localExpiry } from "../ws08-member/qr-token";
import { fetchRedeemStatus, requestRedeemQrToken } from "./api";
import {
  memberOpenBillsQuery,
  memberPointsQuoteQuery,
  redeemStatusQuery,
} from "./queries";

// Components only touch this data through these hooks. Only the page (not the
// presentational components) calls them.

/** Poll interval while the QR is on screen and the cashier has not scanned it. */
export const REDEEM_STATUS_POLL_MS = 3000;

export function useMemberOpenBills() {
  return useQuery(memberOpenBillsQuery());
}

/** `null` = no bill chosen yet; nothing is requested. */
export function useMemberPointsQuote(orderId: string | null) {
  const options = memberPointsQuoteQuery(orderId ?? "");
  return useQuery({
    ...options,
    queryFn: orderId === null ? skipToken : options.queryFn,
  });
}

/**
 * Mints the single-use QR token for one bill and one amount of points. Like the
 * member QR dialog, the 120 s countdown is anchored to the device clock at the
 * moment the token arrives, and the mutation runs offline so a failure shows as
 * a failure instead of waiting forever.
 */
export function useMintRedeemQr() {
  return useMutation<MemberQrToken, Error, { orderId: string; points: number }>(
    {
      networkMode: "always",
      mutationFn: async (input) => {
        const result = await requestRedeemQrToken(input);
        return { ...result, expiresAt: localExpiry(Date.now()) };
      },
    },
  );
}

function refreshMemberData(
  queryClient: ReturnType<typeof useQueryClient>,
  status: MemberPointsRedeemStatus,
) {
  // Consumed: balance, bills and quotes all changed at the till.
  if (status.state === "consumed")
    void queryClient.invalidateQueries({ queryKey: memberKeys.all });
}

/**
 * Status of one issued token. `poll` turns on a refetch every 3 s; it stops by
 * itself once the server reports anything other than "pending".
 */
export function useRedeemStatus(
  input: MemberPointsRedeemStatusInput | null,
  { poll }: { poll: boolean },
) {
  const queryClient = useQueryClient();
  const options = redeemStatusQuery(input ?? { orderId: "", token: "" });
  const query = useQuery({
    ...options,
    queryFn: input === null ? skipToken : options.queryFn,
    refetchInterval: (current) =>
      poll &&
      (current.state.data === undefined ||
        current.state.data.state === "pending")
        ? REDEEM_STATUS_POLL_MS
        : false,
  });
  const data = query.data;
  useEffect(() => {
    if (data) refreshMemberData(queryClient, data);
  }, [data, queryClient]);
  return query;
}

/** One-off check ("Periksa status penukaran"), e.g. after the QR expired. */
export function useCheckRedeemStatus() {
  const queryClient = useQueryClient();
  return useMutation<
    MemberPointsRedeemStatus,
    Error,
    MemberPointsRedeemStatusInput
  >({
    // Same reasoning as the mint: a check offline must fail visibly.
    networkMode: "always",
    mutationFn: (input) => fetchRedeemStatus(input),
    onSuccess: (status) => refreshMemberData(queryClient, status),
  });
}
