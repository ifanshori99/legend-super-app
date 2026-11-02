// "Pengajuan berjalan" on the Beranda (PRD §3 Kelompok D 33 Beranda,
// F25 "Koreksi Absensi"): the corrections this employee is still waiting on.
import { Link } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { usePendingCorrections } from "../hooks.ts";
import {
  correctionStatusKey,
  correctionStatusTone,
  formatTime,
  typeLabelKey,
} from "../state.ts";
import {
  InlineEmpty,
  SectionError,
  SectionSkeleton,
} from "./section-states.tsx";

export function PendingCorrections({ timeZone }: { timeZone: string }) {
  const t = useT();
  const pending = usePendingCorrections();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-brand type-title">
          {t("hris.home.ongoingTitle")}
        </CardTitle>
        <CardDescription>{t("hris.home.ongoingHint")}</CardDescription>
      </CardHeader>
      {pending.isPending ? (
        <SectionSkeleton rows={1} />
      ) : pending.isError ? (
        <SectionError
          title={t("hris.state.correctionsError")}
          description={t("hris.state.retryHint")}
          onRetry={() => void pending.refetch()}
        />
      ) : pending.data.data.length === 0 ? (
        <InlineEmpty icon={Inbox} title={t("hris.home.ongoingEmpty")} />
      ) : (
        <ul className="divide-y divide-border">
          {pending.data.data.map((correction) => (
            <li
              key={correction.id}
              className="flex items-start justify-between gap-3 py-3"
            >
              <div className="grid min-w-0 gap-0.5">
                <p className="font-medium tabular">
                  {t("hris.history.requestedType", {
                    type: t(typeLabelKey(correction.requestedType)),
                    time: formatTime(correction.requestedOccurredAt, timeZone),
                  })}
                </p>
                <p className="line-clamp-2 text-sm leading-5 text-muted-foreground">
                  {correction.reason}
                </p>
              </div>
              <StatusPill status={correctionStatusTone(correction.status)}>
                {t(correctionStatusKey(correction.status))}
              </StatusPill>
            </li>
          ))}
        </ul>
      )}
      <Button asChild variant="ghost" className="w-full">
        <Link to="/karyawan/absensi/riwayat" search={{ tab: "corrections" }}>
          {t("hris.home.seeAll")}
        </Link>
      </Button>
    </Card>
  );
}
