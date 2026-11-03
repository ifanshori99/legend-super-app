// /kelola/pelatihan/$trainingId — one module's material and quiz (PRD v1.7 §3
// F32 "Pelatihan", F29 certification). Answers go to `completeTraining`; the
// mock handler grades them against the server-side answer key and returns the
// completion, so the key never reaches this component. A passing attempt shows
// the internal certificate; there is no PDF endpoint yet, and the result says
// so instead of offering a dead download.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, CircleAlert, CircleCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBand } from "@/components/ui/status-band";
import { useToast } from "@/components/ui/toast";
import type { TrainingCompletion } from "@starter/shared/hris";
import { newIdempotencyKey } from "@/lib/idempotency";
import {
  useCompleteTraining,
  useMyProfile,
  usePositions,
  useTrainings,
} from "../hooks";
import { formatBusinessDate, formatDateTime, latestCompletion } from "../lib";
import {
  fixtureTrainingCompletions,
  recordTrainingCompletion,
} from "../read-model";

export function TrainingDetailPage({ trainingId }: { trainingId: string }) {
  const t = useT();
  const toast = useToast();
  const trainingsQuery = useTrainings();
  const positionsQuery = usePositions();
  const profileQuery = useMyProfile();
  const complete = useCompleteTraining();

  const [answers, setAnswers] = React.useState<Record<string, number>>({});
  const [showRequired, setShowRequired] = React.useState(false);
  const [result, setResult] = React.useState<TrainingCompletion | null>(null);

  const training = React.useMemo(
    () =>
      (trainingsQuery.data?.data ?? []).find(
        (candidate) => candidate.id === trainingId,
      ) ?? null,
    [trainingsQuery.data, trainingId],
  );
  const employeeId = profileQuery.data?.employee.id;
  const position = training?.positionId
    ? (positionsQuery.data?.data ?? []).find(
        (candidate) => candidate.id === training.positionId,
      )
    : undefined;
  const previous =
    result === null
      ? latestCompletion(fixtureTrainingCompletions(), trainingId, employeeId)
      : null;

  if (trainingsQuery.isPending || positionsQuery.isPending)
    return (
      <Card aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );

  if (trainingsQuery.isError)
    return (
      <Card>
        <ErrorState onRetry={() => void trainingsQuery.refetch()} />
      </Card>
    );

  if (training === null)
    return (
      <Card>
        <EmptyState
          title={t("learning.training.notFound")}
          action={
            <Button asChild variant="outline">
              <Link to="/kelola/pelatihan">
                {t("learning.training.backToList")}
              </Link>
            </Button>
          }
        />
      </Card>
    );

  const answeredCount = training.questions.filter(
    (question) => answers[question.id] !== undefined,
  ).length;

  function choose(questionId: string, optionIndex: number) {
    setAnswers((current) => ({ ...current, [questionId]: optionIndex }));
    setShowRequired(false);
  }

  function submit() {
    if (training === null) return;
    const given = training.questions
      .map((question) => ({
        questionId: question.id,
        optionIndex: answers[question.id] ?? -1,
      }))
      .filter((answer) => answer.optionIndex >= 0);
    if (given.length < training.questions.length) {
      setShowRequired(true);
      return;
    }
    setShowRequired(false);
    complete.mutate(
      {
        trainingId: training.id,
        answers: given,
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: (completion) => {
          setResult(completion);
          recordTrainingCompletion(completion);
          toast({
            title: t("learning.training.submitToast"),
            tone: "success",
          });
        },
      },
    );
  }

  function retake() {
    setResult(null);
    setAnswers({});
    setShowRequired(false);
    complete.reset();
  }

  return (
    <div className="grid min-w-0 gap-4">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ms-2">
          <Link to="/kelola/pelatihan">
            <ArrowLeft aria-hidden="true" />
            {t("learning.training.backToList")}
          </Link>
        </Button>
      </div>

      <div className="grid gap-1">
        <h2 className="type-display">{training.title}</h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {training.description}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("learning.training.materialTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Badge tone="brand">
            {position?.name ?? t("learning.training.categoryAllPositions")}
          </Badge>
          <Badge tone="neutral">
            {t("learning.training.passingScore", {
              score: training.passingScore,
            })}
          </Badge>
          <Badge tone="neutral">
            {training.validityMonths === 0
              ? t("learning.training.validityNone")
              : t("learning.training.validity", {
                  months: training.validityMonths,
                })}
          </Badge>
          <Badge tone="neutral">
            {training.scheduledStart === null || training.scheduledEnd === null
              ? t("learning.training.scheduleNone")
              : t("learning.training.schedule", {
                  start: formatDateTime(training.scheduledStart),
                  end: formatDateTime(training.scheduledEnd),
                })}
          </Badge>
        </CardContent>
      </Card>

      {previous !== null && (
        <Card>
          <CardHeader>
            <CardTitle>{t("learning.training.previousTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <StatusPill status={previous.passed ? "success" : "danger"}>
              {t(
                previous.passed
                  ? "learning.training.result.passed"
                  : "learning.training.result.failed",
              )}
            </StatusPill>
            <span className="text-sm tabular">
              {t("learning.training.result.score", { score: previous.score })}
            </span>
            <span className="text-sm text-muted-foreground tabular">
              {t("learning.training.result.attempts", {
                attempts: previous.attempts,
              })}
            </span>
          </CardContent>
        </Card>
      )}

      {result !== null ? (
        <Card className="overflow-hidden p-0">
          <StatusBand
            tone={result.passed ? "success" : "danger"}
            icon={result.passed ? CircleCheck : CircleAlert}
            label={t(
              result.passed
                ? "learning.training.result.passed"
                : "learning.training.result.failed",
            )}
            aside={
              <span className="text-sm tabular">
                {t("learning.training.result.attempts", {
                  attempts: result.attempts,
                })}
              </span>
            }
          >
            <p className="type-title">{t("learning.training.resultTitle")}</p>
          </StatusBand>
          <div className="grid gap-3 p-card">
            <div className="flex flex-wrap items-center gap-2">
              <p className="type-title tabular">
                {t("learning.training.result.score", { score: result.score })}
              </p>
              {result.passed && (
                <Badge tone="success">
                  {t("learning.training.result.certificateBadge")}
                </Badge>
              )}
            </div>
            <p className="text-sm leading-5">
              {!result.passed
                ? t("learning.training.result.certificateMissing")
                : result.expiresOn === null
                  ? t("learning.training.result.certificateNoExpiry")
                  : t("learning.training.result.certificateActive", {
                      date: formatBusinessDate(result.expiresOn),
                    })}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("learning.training.result.pdfGap")}
            </p>
            <div>
              <Button variant="outline" onClick={retake}>
                {t("learning.training.retake")}
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t("learning.training.quizTitle")}</CardTitle>
            <CardDescription>
              {t("learning.training.quizDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {training.questions.map((question, index) => (
              <fieldset
                key={question.id}
                className="grid gap-2 rounded-container bg-surface-2 p-3"
              >
                <legend className="px-1 text-sm leading-5 font-semibold">
                  {t("learning.training.questionNumber", {
                    number: index + 1,
                    total: training.questions.length,
                  })}
                </legend>
                <p className="text-sm leading-5 font-medium">
                  {question.prompt}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("learning.training.questionPoints", {
                    points: question.points,
                  })}
                </p>
                <div className="grid gap-1">
                  {question.options.map((option, optionIndex) => {
                    const id = `${question.id}-${optionIndex}`;
                    return (
                      <label
                        key={id}
                        htmlFor={id}
                        className="flex min-h-control-sm cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 hover:bg-card"
                      >
                        <input
                          id={id}
                          type="radio"
                          name={question.id}
                          className="size-check accent-primary"
                          checked={answers[question.id] === optionIndex}
                          onChange={() => choose(question.id, optionIndex)}
                        />
                        <span className="text-sm leading-5">{option}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}

            <p className="text-sm text-muted-foreground tabular">
              {t("learning.training.questionProgress", {
                answered: answeredCount,
                total: training.questions.length,
              })}
            </p>
            {showRequired && (
              <p role="alert" className="text-sm text-danger">
                {t("learning.training.answerRequired")}
              </p>
            )}
            {complete.isError && (
              <p role="alert" className="text-sm text-danger">
                {t("learning.common.actionFailed")}
              </p>
            )}
            <div>
              <Button onClick={submit} loading={complete.isPending}>
                {t("learning.training.submit")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
