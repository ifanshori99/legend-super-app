// Download button of one published shareholder document (PRD §3 F35, SH-01).
// Each click asks the server for a fresh signed URL (valid 300 s); the server
// only signs a published document the caller owns.
import { useState } from "react";
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
  // Popup blocked: keep the user in the app and offer a real link, whose own
  // click opens the document.
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  return (
    <div className="flex max-w-48 shrink-0 flex-col items-end gap-1 text-right">
      <Button
        variant="outline"
        size="sm"
        loading={download.isPending}
        aria-label={t("shareholderHome.documents.downloadLabel", {
          title: doc.title,
        })}
        onClick={() => {
          setBlockedUrl(null);
          const tab = openBlankTab();
          download.mutate(doc.id, {
            onSuccess: (signed) => {
              if (tab && !tab.closed) tab.location.href = signed.url;
              else setBlockedUrl(signed.url);
            },
            onError: () => tab?.close(),
          });
        }}
      >
        <Download aria-hidden="true" />
        {t("shareholderHome.documents.download")}
      </Button>
      {download.isError && (
        <p role="alert" className="text-xs break-words text-danger">
          {t("shareholderHome.documents.downloadFailed")}
        </p>
      )}
      {blockedUrl !== null && (
        <a
          href={blockedUrl}
          target="_blank"
          rel="noopener noreferrer"
          role="status"
          className="text-xs break-words underline underline-offset-2"
        >
          {t("shareholderHome.documents.openBlocked")}
        </a>
      )}
    </div>
  );
}
