// Post-meal review (PRD §3 "Ulasan Pascamakan", §4 flow A). Opens once the bill
// is paid. Only a high rating (GOOGLE_REVIEW_MIN_RATING) sends the guest on to
// the tenant's Google review page; lower ratings just get a thank-you.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, ExternalLink, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useTableJourney } from "@/features/ws03-qr-order/context";
import {
  useReviewEligibility,
  useSubmitReview,
} from "@/features/ws03-qr-order/hooks";
import { ApiError } from "@/lib/api/errors";
import { useOnline } from "@/lib/use-online";
import type { TableReview } from "@starter/shared/qr-order";
import { StarRating } from "./star-rating";

const COMMENT_MAX = 1000;

function ReviewSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-4">
      <span className="sr-only">{t("common.loading")}</span>
      <Skeleton className="h-8 w-3/4" />
      <Skeleton className="h-12 w-64 max-w-full" />
      <Skeleton className="h-28 w-full rounded-field" />
      <Skeleton className="h-12 w-full rounded-control" />
    </div>
  );
}

/** Only web links open from the review page, whatever the server sent. */
function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function errorKey(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 409 || error.code.includes("CONFLICT"))
      return "conflict" as const;
    if (error.status === 403 || error.status === 422)
      return "notEligible" as const;
    if (error.status === 0 || error.code === "NETWORK_ERROR")
      return "network" as const;
  }
  return "generic" as const;
}

function ThankYou({
  review,
  googleUrl,
}: {
  review: TableReview;
  googleUrl: string | null;
}) {
  const t = useT();
  const toGoogle = review.googleReviewPrompt && googleUrl !== null;
  return (
    <section
      aria-live="polite"
      className="grid gap-3 rounded-xl border-(length:--border-w) p-card"
    >
      <h2 className="flex items-start gap-2 text-lg leading-7 font-semibold">
        <CircleCheck className="mt-1 size-icon shrink-0" aria-hidden="true" />
        {t("qrRecovery.review.thanks.title")}
      </h2>
      {toGoogle ? (
        <>
          <p>{t("qrRecovery.review.thanks.high")}</p>
          <p className="text-sm text-muted-foreground">
            {t("qrRecovery.review.thanks.googleHint")}
          </p>
          <a
            href={googleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ size: "lg" })}
          >
            {t("qrRecovery.review.thanks.google")}
            <ExternalLink aria-hidden="true" />
          </a>
        </>
      ) : (
        <p>{t("qrRecovery.review.thanks.low")}</p>
      )}
    </section>
  );
}

export function ReviewPage() {
  const t = useT();
  const online = useOnline();
  const journey = useTableJourney();
  const { qrToken, guest, sessionId } = journey;
  const eligibility = useReviewEligibility(sessionId);
  const submit = useSubmitReview(sessionId ?? "none");
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [missingRating, setMissingRating] = useState(false);

  if (guest === null)
    return (
      <EmptyState
        title={t("qrRecovery.review.notJoined.title")}
        description={t("qrRecovery.review.notJoined.hint")}
        action={
          <Button type="button" onClick={() => journey.openJoin()}>
            {t("qrRecovery.review.notJoined.action")}
          </Button>
        }
      />
    );

  const state = eligibility.data?.data;
  if (!state) {
    if (eligibility.isError)
      return (
        <ErrorState
          title={t("qrRecovery.review.error.title")}
          description={t("qrRecovery.review.error.hint")}
          onRetry={() => void eligibility.refetch()}
        />
      );
    return <ReviewSkeleton />;
  }

  const header = (
    <header className="grid gap-1">
      <h1 className="text-2xl leading-8 font-semibold">
        {t("qrRecovery.review.title")}
      </h1>
      <p className="text-muted-foreground">{t("qrRecovery.review.hint")}</p>
    </header>
  );

  // A fresh result wins over the refreshed eligibility ("already submitted").
  if (submit.isSuccess)
    return (
      <div className="grid gap-4">
        {header}
        <ThankYou
          review={submit.data.data}
          googleUrl={safeHttpUrl(
            submit.data.data.googleReviewUrl ?? state.googleReviewUrl,
          )}
        />
      </div>
    );

  if (state.alreadySubmitted)
    return (
      <div className="grid gap-4">
        {header}
        <section className="grid gap-1 rounded-xl border-(length:--border-w) p-card">
          <h2 className="flex items-start gap-2 text-lg leading-7 font-semibold">
            <CircleCheck
              className="mt-1 size-icon shrink-0"
              aria-hidden="true"
            />
            {t("qrRecovery.review.already.title")}
          </h2>
          <p className="text-muted-foreground">
            {t("qrRecovery.review.already.hint")}
          </p>
        </section>
      </div>
    );

  if (!state.eligible)
    return (
      <div className="grid gap-4">
        {header}
        <EmptyState
          title={t("qrRecovery.review.notEligible.title")}
          description={t("qrRecovery.review.notEligible.hint")}
          action={
            <Button asChild>
              <Link to="/t/$token/bill" params={{ token: qrToken }}>
                {t("qrRecovery.review.notEligible.action")}
              </Link>
            </Button>
          }
        />
      </div>
    );

  const key = submit.isError ? errorKey(submit.error) : null;

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (rating === null) {
      setMissingRating(true);
      return;
    }
    const trimmed = comment.trim();
    submit.mutate({
      rating,
      ...(trimmed ? { comment: trimmed } : {}),
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5 pb-4">
      {header}

      {!online && (
        <p
          role="status"
          className="flex items-start gap-2 text-sm text-muted-foreground"
        >
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("qrRecovery.review.offline")}
        </p>
      )}

      <div className="grid gap-2">
        <p className="text-sm leading-5 font-semibold" id="review-rating-label">
          {t("qrRecovery.review.rating.label")}
        </p>
        <StarRating
          value={rating}
          describedBy={missingRating ? "review-rating-error" : undefined}
          disabled={submit.isPending}
          onValueChange={(next) => {
            setRating(next);
            setMissingRating(false);
          }}
        />
        <div id="review-rating-error" aria-live="polite">
          {missingRating && rating === null && (
            <p className="flex items-start gap-1.5 text-sm leading-5 font-medium text-danger">
              <CircleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {t("qrRecovery.review.rating.required")}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-1">
        <FormField
          label={t("qrRecovery.review.comment.label")}
          hint={t("qrRecovery.review.comment.hint")}
        >
          <Textarea
            value={comment}
            maxLength={COMMENT_MAX}
            rows={4}
            placeholder={t("qrRecovery.review.comment.placeholder")}
            disabled={submit.isPending}
            onChange={(event) => setComment(event.target.value)}
          />
        </FormField>
        <p className="text-right text-sm text-muted-foreground tabular">
          {t("qrRecovery.review.comment.counter", {
            count: comment.length,
            max: COMMENT_MAX,
          })}
        </p>
      </div>

      {key && (
        <div
          role="alert"
          className="flex flex-wrap items-start gap-2 rounded-xl border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm"
        >
          <CircleAlert
            className="mt-0.5 size-4 shrink-0 text-danger"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 font-medium">
            {t(`qrRecovery.review.errors.${key}`)}
          </p>
          {key === "conflict" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                submit.reset();
                void eligibility.refetch();
              }}
            >
              {t("qrRecovery.review.errors.reload")}
            </Button>
          )}
        </div>
      )}

      <Button
        type="submit"
        size="lg"
        loading={submit.isPending}
        disabled={!online}
      >
        {t("qrRecovery.review.submit")}
      </Button>
    </form>
  );
}
