import { Download, Printer } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";

// The PDF link exists only while the payslip carries a signed `fileUrl`. No PDF
// generator exists yet (bead legend-07eg), so `fileUrl` is null for now: show no
// download button then, only the page print (CTO decision 21 Nov: the PIN-gated
// payslip in the app is the proof of wages for release 1).
export function PayslipFileActions({ fileUrl }: { fileUrl: string | null }) {
  const t = useT();
  if (fileUrl !== null)
    return (
      <div className="grid gap-1">
        <Button asChild variant="outline" className="w-full">
          <a href={fileUrl} target="_blank" rel="noreferrer">
            <Download aria-hidden="true" />
            {t("payslip.detail.download")}
          </a>
        </Button>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("payslip.detail.downloadHint")}
        </p>
      </div>
    );
  return (
    <div className="grid gap-1">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => window.print()}
      >
        <Printer aria-hidden="true" />
        {t("payslip.detail.print")}
      </Button>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("payslip.detail.printHint")}
      </p>
    </div>
  );
}
