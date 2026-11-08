// "Dokumen" (PRD §3 F35, SH-02): documents management published for
// shareholders. The contract exposes storage keys, not download URLs, so each
// row's button asks for a short-lived signed URL instead (legend-135u).
import { FileText } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { formatInstantDate } from "../board.ts";
import { useShareholderDocuments } from "../hooks";
import { DocumentDownload } from "./document-download";
import { RegionFailure } from "./region";

export function DocumentsSection() {
  const t = useT();
  const docs = useShareholderDocuments();
  const state =
    docs.status === "loading"
      ? "loading"
      : docs.status === "empty"
        ? "empty"
        : "ready";
  // DataTableShell's error state cannot tell offline from a server error, so a
  // failure renders in the shell's ready slot through the shared frame.
  if (docs.status === "error" || docs.status === "offline")
    return (
      <DataTableShell
        title={t("shareholderHome.documents.title")}
        description={t("shareholderHome.documents.hint")}
        state="ready"
      >
        <RegionFailure status={docs.status} retry={docs.retry} />
      </DataTableShell>
    );
  return (
    <DataTableShell
      title={t("shareholderHome.documents.title")}
      description={t("shareholderHome.documents.hint")}
      state={state}
      onRetry={docs.retry}
      empty={{
        title: t("shareholderHome.documents.emptyTitle"),
        description: t("shareholderHome.documents.emptyHint"),
      }}
    >
      <ul>
        {docs.items.map((doc) => (
          <li
            key={doc.id}
            className="flex items-start gap-3 border-b-(length:--border-w) p-card last:border-0"
          >
            <FileText
              className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium break-words">{doc.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {doc.publishedAt !== null &&
                  t("shareholderHome.documents.published", {
                    date: formatInstantDate(doc.publishedAt),
                  })}
              </p>
            </div>
            <Badge tone="neutral">
              {t(`shareholderHome.documents.kinds.${doc.kind}`)}
            </Badge>
            <DocumentDownload doc={doc} />
          </li>
        ))}
      </ul>
      {docs.hasMore && (
        <div className="p-card">
          <Button
            variant="outline"
            size="sm"
            loading={docs.loadingMore}
            onClick={docs.loadMore}
          >
            {t("shareholderHome.documents.loadMore")}
          </Button>
        </div>
      )}
    </DataTableShell>
  );
}
