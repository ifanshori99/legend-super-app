// The only way components touch learning data: queries keep their endpoint
// keys, and each mutation invalidates every endpoint whose rows it can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  listAnnouncements,
  listSopDocuments,
  listTrainings,
  type SopAcknowledgement,
  type TrainingCompletion,
} from "@starter/shared/hris";
import * as api from "./api";
import {
  announcementsQuery,
  employeesQuery,
  kpiReviewsQuery,
  myProfileQuery,
  positionsQuery,
  sopDocumentsQuery,
  trainingsQuery,
} from "./queries";

function useInvalidate(endpoints: readonly AnyEndpoint[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      endpoints.map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

// ---- Reads ----------------------------------------------------------------

export const useKpiReviews = () => useQuery(kpiReviewsQuery());

export const useSopDocuments = () => useQuery(sopDocumentsQuery());

export const useTrainings = () => useQuery(trainingsQuery());

export const useAnnouncements = () => useQuery(announcementsQuery());

export const useEmployees = () => useQuery(employeesQuery());

export const usePositions = () => useQuery(positionsQuery());

export const useMyProfile = () => useQuery(myProfileQuery());

// ---- Writes ---------------------------------------------------------------

export function useAcknowledgeSop() {
  const refresh = useInvalidate([listSopDocuments]);
  return useMutation({
    mutationFn: (variables: {
      sopDocumentId: SopAcknowledgement["sopDocumentId"];
      idempotencyKey: string;
    }) =>
      api.acknowledgeSop(
        { sopDocumentId: variables.sopDocumentId },
        {
          idempotencyKey: variables.idempotencyKey,
        },
      ),
    onSuccess: () => refresh(),
  });
}

export function useCompleteTraining() {
  const refresh = useInvalidate([listTrainings]);
  return useMutation({
    mutationFn: (variables: {
      trainingId: TrainingCompletion["trainingId"];
      answers: Parameters<typeof api.submitTrainingAnswers>[1]["answers"];
      idempotencyKey: string;
    }) =>
      api.submitTrainingAnswers(
        { trainingId: variables.trainingId },
        {
          answers: variables.answers,
          idempotencyKey: variables.idempotencyKey,
        },
      ),
    onSuccess: () => refresh(),
  });
}

export function useMarkAnnouncementRead() {
  const refresh = useInvalidate([listAnnouncements]);
  return useMutation({
    mutationFn: (variables: {
      announcementId: Parameters<
        typeof api.markAnnouncementRead
      >[0]["announcementId"];
      acknowledged: boolean;
      idempotencyKey: string;
    }) =>
      api.markAnnouncementRead(
        { announcementId: variables.announcementId },
        {
          acknowledged: variables.acknowledged,
          idempotencyKey: variables.idempotencyKey,
        },
      ),
    onSuccess: () => refresh(),
  });
}
