// Outlet picker for staff accounts assigned to 2+ outlets (legend-2aqp). The
// shell shows it only when there is a real choice; one outlet needs no control.
import type { MyOutlet } from "@starter/shared/access";
import { useT } from "@/components/i18n";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function OutletPicker({
  outlets,
  value,
  onChange,
}: {
  outlets: readonly MyOutlet[];
  value: string | null;
  onChange: (outletId: string) => void;
}) {
  const t = useT();
  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger
        aria-label={t("area.outletPicker")}
        className="w-auto min-w-40"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {outlets.map((outlet) => (
          <SelectItem key={outlet.id} value={outlet.id}>
            {outlet.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
