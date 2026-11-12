// The only way components touch equipment/handover data: queries keep their
// endpoint keys, every write invalidates the reads it can change (equipment
// status also moves when a breakdown ticket marks it broken, OPS-04).
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  getEquipment,
  getMaintenanceTicket,
  getShiftHandover,
  listEquipment,
  listMaintenanceSchedules,
  listMaintenanceTickets,
  listShiftHandovers,
} from "@starter/shared/operations";
import { newIdempotencyKey } from "@/lib/idempotency";
import * as api from "./api.ts";
import {
  equipmentListQuery,
  equipmentQuery,
  handoverQuery,
  handoversQuery,
  menuItemsQuery,
  schedulesQuery,
  serviceVendorsQuery,
  ticketsQuery,
} from "./queries.ts";

function useInvalidate(endpoints: readonly AnyEndpoint[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      endpoints.map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

const EQUIPMENT_READS = [
  listEquipment,
  getEquipment,
  listMaintenanceTickets,
  getMaintenanceTicket,
] as const;

const HANDOVER_READS = [listShiftHandovers, getShiftHandover] as const;

function useEquipmentMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
) {
  const refresh = useInvalidate(EQUIPMENT_READS);
  return useMutation({ mutationFn, onSuccess: () => refresh() });
}

function useHandoverMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
) {
  const refresh = useInvalidate(HANDOVER_READS);
  return useMutation({ mutationFn, onSuccess: () => refresh() });
}

export function useEquipmentList(outletId: string | undefined) {
  return useQuery({
    ...equipmentListQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

export function useEquipment(equipmentId: string | undefined) {
  return useQuery({
    ...equipmentQuery(equipmentId ?? ""),
    enabled: Boolean(equipmentId),
  });
}

export function useSchedules(outletId: string | undefined) {
  return useQuery({
    ...schedulesQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

export function useTickets(outletId: string | undefined) {
  return useQuery({
    ...ticketsQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

export function useHandovers(outletId: string | undefined) {
  return useQuery({
    ...handoversQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

export function useHandover(handoverId: string | undefined) {
  return useQuery({
    ...handoverQuery(handoverId ?? ""),
    enabled: Boolean(handoverId),
  });
}

export function useServiceVendors() {
  return useQuery(serviceVendorsQuery());
}

export function useMenuItems() {
  return useQuery(menuItemsQuery());
}

type CreateEquipmentBody = Parameters<typeof api.createEquipment>[0];
type UpdateEquipmentBody = Parameters<typeof api.updateEquipment>[1];
type EquipmentTransitionBody = Parameters<
  typeof api.postEquipmentTransition
>[1];
type CreateScheduleBody = Parameters<typeof api.createMaintenanceSchedule>[0];
type CreateTicketBody = Parameters<typeof api.createMaintenanceTicket>[0];
type TicketTransitionBody = Parameters<
  typeof api.postMaintenanceTicketTransition
>[1];
type CreateHandoverBody = Parameters<typeof api.createShiftHandover>[0];

export function useCreateEquipment() {
  return useEquipmentMutation((body: CreateEquipmentBody) =>
    api.createEquipment(body),
  );
}

export function useUpdateEquipment() {
  const refresh = useInvalidate(EQUIPMENT_READS);
  return useMutation({
    mutationFn: (input: { equipmentId: string; body: UpdateEquipmentBody }) =>
      api.updateEquipment({ equipmentId: input.equipmentId }, input.body),
    onSuccess: () => refresh(),
  });
}

export function useEquipmentTransition() {
  return useEquipmentMutation(
    (input: { equipmentId: string; body: EquipmentTransitionBody }) =>
      api.postEquipmentTransition(
        { equipmentId: input.equipmentId },
        input.body,
      ),
  );
}

export function useCreateSchedule() {
  const refresh = useInvalidate([
    listMaintenanceSchedules,
    getEquipment,
    listEquipment,
  ]);
  return useMutation({
    mutationFn: (body: CreateScheduleBody) =>
      api.createMaintenanceSchedule(body),
    onSuccess: () => refresh(),
  });
}

export function useCreateTicket() {
  return useEquipmentMutation((body: CreateTicketBody) =>
    api.createMaintenanceTicket(body),
  );
}

export function useTicketTransition() {
  return useEquipmentMutation(
    (input: { ticketId: string; body: TicketTransitionBody }) =>
      api.postMaintenanceTicketTransition(
        { ticketId: input.ticketId },
        input.body,
      ),
  );
}

export function useCreateHandover() {
  return useHandoverMutation((body: CreateHandoverBody) =>
    api.createShiftHandover(body),
  );
}

export function useAcknowledgeHandover() {
  return useHandoverMutation((input: { handoverId: string }) =>
    api.acknowledgeShiftHandover(
      { handoverId: input.handoverId },
      { idempotencyKey: newIdempotencyKey() },
    ),
  );
}

export function useCloseHandover() {
  return useHandoverMutation(
    (input: { handoverId: string; idempotencyKey: string }) =>
      api.closeShiftHandover(
        { handoverId: input.handoverId },
        { idempotencyKey: input.idempotencyKey },
      ),
  );
}

/**
 * One idempotency key per business attempt (Opus review, legend-1j7): a retry
 * of the same payload after a timeout or network drop must reuse its key, or
 * the API creates a second document. A changed payload is a new attempt and
 * gets a new key; success clears it.
 */
export function useAttemptKey() {
  const attempt = React.useRef<{ signature: string; key: string } | null>(null);
  return React.useMemo(
    () => ({
      keyFor(payload: unknown): string {
        const signature = JSON.stringify(payload);
        if (attempt.current?.signature !== signature)
          attempt.current = { signature, key: newIdempotencyKey() };
        return attempt.current.key;
      },
      settle() {
        attempt.current = null;
      },
    }),
    [],
  );
}
