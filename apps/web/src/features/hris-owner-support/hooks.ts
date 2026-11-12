import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supportAccessKeys } from "@/features/ws01-support-access/queries";
import { endOwnerSupportAccessCall } from "./api";

export function useEndOwnerSupportAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) =>
      endOwnerSupportAccessCall(grantId).then((result) => result.data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: supportAccessKeys.all }),
  });
}
