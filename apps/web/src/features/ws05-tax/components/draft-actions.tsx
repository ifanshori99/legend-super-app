// Row actions of a draft version: Ubah, Terbitkan, Buang draf. Text buttons
// (mockup tax-woc1) whose names are the same on every row; the row gives the
// context. "Buang draf" is destructive-coloured. Table rows and phone cards
// share this, with 44px targets on phones.
import { Button } from "@/components/ui/button";
import { useT } from "@/components/i18n";

export function DraftActions({
  onEdit,
  onPublish,
  onDiscard,
}: {
  onEdit: () => void;
  onPublish: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-1 md:justify-end">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="max-md:min-h-11"
        onClick={onEdit}
      >
        {t("tax.rules.edit")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="max-md:min-h-11"
        onClick={onPublish}
      >
        {t("tax.rules.publish")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="text-danger max-md:min-h-11"
        onClick={onDiscard}
      >
        {t("tax.rules.discard")}
      </Button>
    </div>
  );
}
