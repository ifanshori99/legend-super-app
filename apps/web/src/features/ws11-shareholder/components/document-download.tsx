// Download button of one published shareholder document (PRD §3 F35, SH-01).
// Each click asks the server for a fresh signed URL (valid 300 s); the server
// only signs a published document the caller owns.
import { Download } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import type { ShareholderDocument } from "@starter/shared/accounting";
import { useShareholderDocumentDownload } from "../hooks";

// The tab must open inside the click, before the URL request: a tab opened
// after the await is taken for a popup and blocked. It starts blank, gets the
// signed URL when it arrives and is closed if the request fails.
function openBlankTab(): Window | null {
  const tab = window.open("", "_blank");
  // The document is not ours to trust with a handle back to this page.
  if (tab) tab.opener = null;
  return tab;
}

export function DocumentDownload({ doc }: { doc: ShareholderDocument }) {
  const t = useT();
  const download = useShareholderDocumentDownload();
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        loading={download.isPending}
        aria-label={t("shareholderHome.documents.downloadLabel", {
          title: doc.title,
        })}
        onClick={() => {
          const tab = openBlankTab();
          download.mutate(doc.id, {
            onSuccess: (signed) => {
              if (tab) tab.location.href = signed.url;
              else window.location.assign(signed.url);
            },
            onError: () => tab?.close(),
          });
        }}
      >
        <Download aria-hidden="true" />
        {t("shareholderHome.documents.download")}
      </Button>
      {download.isError && (
        <p role="alert" className="text-xs text-danger">
          {t("shareholderHome.documents.downloadFailed")}
        </p>
      )}
    </div>
  );
}
