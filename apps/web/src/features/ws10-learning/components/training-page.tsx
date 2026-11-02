// /kelola/pelatihan — the training module list (PRD v1.7 §3 F32 "Pelatihan"):
// title, category (the position it targets), certification validity, question
// count and the employee's own result. Completion history has no list endpoint
// yet, so the result column reads the mock read model and says so otherwise.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatNumber } from "@starter/shared/i18n";
import { isCertificationValid, type Training } from "@starter/shared/hris";
import { useMyProfile, usePositions, useTrainings } from "../hooks";
import { latestCompletion } from "../lib";
import {
  fixtureReferenceDate,
  fixtureTrainingCompletions,
} from "../read-model";

export function TrainingPage() {
  const t = useT();
  const trainingsQuery = useTrainings();
  const positionsQuery = usePositions();
  const profileQuery = useMyProfile();

  // Completion writes on the detail screen are recorded in the read model, so
  // returning to this list shows the attempt without a list endpoint.
  const completions = fixtureTrainingCompletions();
  const employeeId = profileQuery.data?.employee.id;
  const referenceDate = fixtureReferenceDate();

  const positionsById = React.useMemo(
    () =>
      new Map(
        (positionsQuery.data?.data ?? []).map((position) => [
          position.id,
          position,
        ]),
      ),
    [positionsQuery.data],
  );
  const trainings = React.useMemo(
    () => trainingsQuery.data?.data ?? [],
    [trainingsQuery.data],
  );

  const categoryName = (training: Training) =>
    training.positionId === null
      ? t("learning.training.categoryAllPositions")
      : (positionsById.get(training.positionId)?.name ??
        t("learning.training.categoryAllPositions"));

  const completedCount =
    completions === null
      ? null
      : trainings.filter(
          (training) =>
            latestCompletion(completions, training.id, employeeId) !== null,
        ).length;
  const certifiedCount =
    completions === null || referenceDate === null
      ? null
      : trainings.filter((training) => {
          const completion = latestCompletion(
            completions,
            training.id,
            employeeId,
          );
          return (
            completion !== null &&
            isCertificationValid(completion, referenceDate)
          );
        }).length;

  const state: DataState =
    trainingsQuery.isPending || positionsQuery.isPending
      ? "loading"
      : trainingsQuery.isError || positionsQuery.isError
        ? "error"
        : trainings.length === 0
          ? "empty"
          : "ready";

  return (
    <div className="grid min-w-0 gap-4">
      <StatStrip label={t("learning.training.summaryLabel")} columns={3}>
        <StatTile
          label={t("learning.training.metric.modules")}
          value={
            <span className="tabular">{formatNumber(trainings.length)}</span>
          }
        />
        <StatTile
          label={t("learning.training.metric.completed")}
          value={
            <span className="tabular">
              {completedCount === null
                ? t("learning.common.none")
                : formatNumber(completedCount)}
            </span>
          }
        />
        <StatTile
          label={t("learning.training.metric.certified")}
          value={
            <span className="tabular">
              {certifiedCount === null
                ? t("learning.common.none")
                : formatNumber(certifiedCount)}
            </span>
          }
        />
      </StatStrip>

      <DataTableShell
        title={t("learning.training.tableTitle")}
        description={t("learning.training.description")}
        state={state}
        onRetry={() => {
          void trainingsQuery.refetch();
          void positionsQuery.refetch();
        }}
        empty={{
          title: t("learning.training.emptyTitle"),
          description: t("learning.training.emptyHint"),
        }}
        rowCount={trainings.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("learning.training.table.module")}</TableHead>
              <TableHead>{t("learning.training.table.category")}</TableHead>
              <TableHead>
                {t("learning.training.table.certification")}
              </TableHead>
              <TableHead>{t("learning.training.table.questions")}</TableHead>
              <TableHead>{t("learning.training.table.status")}</TableHead>
              <TableHead>
                <span className="sr-only">
                  {t("learning.training.table.action")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trainings.map((training) => {
              const completion = latestCompletion(
                completions,
                training.id,
                employeeId,
              );
              return (
                <TableRow key={training.id}>
                  <TableCell>
                    <p className="font-medium">{training.title}</p>
                    <p className="max-w-prose text-xs leading-5 text-muted-foreground">
                      {training.description}
                    </p>
                  </TableCell>
                  <TableCell>{categoryName(training)}</TableCell>
                  <TableCell>
                    {training.validityMonths === 0
                      ? t("learning.training.certificationNone")
                      : t("learning.training.certificationMonths", {
                          months: training.validityMonths,
                        })}
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap">
                    {t("learning.training.questionsCount", {
                      count: training.questions.length,
                    })}
                  </TableCell>
                  <TableCell>
                    {completion === null ? (
                      <StatusPill status="info">
                        {t("learning.training.status.notStarted")}
                      </StatusPill>
                    ) : completion.passed ? (
                      <StatusPill status="success">
                        {t("learning.training.status.passed", {
                          score: completion.score,
                        })}
                      </StatusPill>
                    ) : (
                      <StatusPill status="danger">
                        {t("learning.training.status.failed", {
                          score: completion.score,
                        })}
                      </StatusPill>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button asChild variant="outline" size="sm">
                      <Link
                        to="/kelola/pelatihan/$trainingId"
                        params={{ trainingId: training.id }}
                      >
                        {t("learning.training.open")}
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTableShell>

      {completions === null && state === "ready" && (
        <p className="rounded-container border-(length:--border-w) bg-card p-3 text-sm leading-5 text-muted-foreground shadow-hairline">
          {t("learning.training.completionsUnavailable")}
        </p>
      )}
    </div>
  );
}
