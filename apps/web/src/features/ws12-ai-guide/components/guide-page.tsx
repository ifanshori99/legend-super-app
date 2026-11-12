// Pedoman Penggunaan AI (PRD v1.7 §3 F40 Transparansi). One page for every
// area: the route passes the area's Tanya AI chat href for the way back. The
// text comes from GET /api/ai/guidelines: the section `tentang` is the intro
// card, `hasil-ai` the closing card, every other section a numbered point.
import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { AiGuidelines } from "@starter/shared/ai";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardShell } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useAiGuidelines } from "../hooks.ts";

const INTRO_ID = "tentang";
const CLOSING_ID = "hasil-ai";

type Section = AiGuidelines["sections"][number];

function BackLink({ href }: { href: string }) {
  const t = useT();
  return (
    <Link
      to={href as "/"}
      className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-control px-2 text-sm leading-5 font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-4" aria-hidden="true" />
      {t("aiGuide.back")}
    </Link>
  );
}

function Paragraphs({ section }: { section: Section }) {
  return (
    <>
      {section.paragraphsId.map((paragraph, index) => (
        <p key={index} className="text-base leading-6 text-foreground">
          {paragraph}
        </p>
      ))}
    </>
  );
}

function GuideSkeleton() {
  return (
    <div className="grid gap-5" aria-hidden="true">
      <CardShell>
        <Card className="gap-3">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-6 w-64 max-w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </Card>
      </CardShell>
      <div className="grid gap-3 md:grid-cols-2 md:gap-5">
        {[0, 1, 2, 3].map((index) => (
          <CardShell key={index}>
            <Card className="gap-3">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-5 w-48 max-w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </Card>
          </CardShell>
        ))}
      </div>
    </div>
  );
}

export function AiGuidePage({ backHref }: { backHref: string }) {
  const t = useT();
  const guidelines = useAiGuidelines();

  const sections = guidelines.data?.data.sections ?? [];
  const intro = sections.find((section) => section.id === INTRO_ID);
  const closing = sections.find((section) => section.id === CLOSING_ID);
  const points = sections.filter(
    (section) => section.id !== INTRO_ID && section.id !== CLOSING_ID,
  );

  return (
    <div
      className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-5"
      aria-busy={guidelines.isPending}
    >
      <header className="grid gap-2">
        <BackLink href={backHref} />
        <h1 className="type-title">{t("aiGuide.title")}</h1>
        <p className="max-w-prose text-sm leading-5 text-muted-foreground">
          {t("aiGuide.subtitle")}
        </p>
      </header>

      {guidelines.isPending && (
        <>
          <p className="sr-only" role="status">
            {t("aiGuide.loading")}
          </p>
          <GuideSkeleton />
        </>
      )}

      {guidelines.isError && (
        <Card>
          <ErrorState
            title={t("aiGuide.errorTitle")}
            description={t("aiGuide.errorHint")}
            error={guidelines.error}
            onRetry={() => void guidelines.refetch()}
          />
        </Card>
      )}

      {guidelines.isSuccess && (
        <>
          {intro && (
            <CardShell>
              <Card className="gap-2">
                <p className="type-eyebrow text-muted-foreground">
                  {t("aiGuide.aboutEyebrow")}
                </p>
                <h2 className="type-heading">{intro.titleId}</h2>
                <Paragraphs section={intro} />
              </Card>
            </CardShell>
          )}

          {points.length > 0 && (
            <section className="grid gap-3 md:gap-5">
              <div className="grid gap-1">
                <h2 className="type-heading">
                  {points.length === 4
                    ? t("aiGuide.points.titleFour")
                    : t("aiGuide.points.titleOther")}
                </h2>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("aiGuide.points.subtitle")}
                </p>
              </div>
              <ol className="grid list-none gap-3 p-0 md:grid-cols-2 md:gap-5">
                {points.map((section, index) => (
                  <li key={section.id} className="flex">
                    <CardShell className="w-full">
                      <Card className="h-full gap-2">
                        <span
                          className="mb-2 grid size-8 place-items-center rounded-full bg-shell text-sm font-bold"
                          aria-hidden="true"
                        >
                          {index + 1}
                        </span>
                        <h3 className="text-base font-semibold">
                          {section.titleId}
                        </h3>
                        <Paragraphs section={section} />
                      </Card>
                    </CardShell>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <CardShell>
            <Card className="items-start gap-2">
              {closing && (
                <>
                  <h2 className="text-base font-semibold">{closing.titleId}</h2>
                  <Paragraphs section={closing} />
                </>
              )}
              <Button asChild className="mt-2 min-h-11">
                <Link to={backHref as "/"}>{t("aiGuide.back")}</Link>
              </Button>
            </Card>
          </CardShell>
        </>
      )}
    </div>
  );
}
