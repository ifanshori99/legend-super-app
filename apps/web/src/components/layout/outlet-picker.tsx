// Outlet picker for staff accounts assigned to 2+ outlets (legend-2aqp). The
// shell shows it only when there is a real choice; one outlet needs no control.
import type { MyOutlet } from "@starter/shared/access";
import { cn } from "cn";
import { Check } from "lucide-react";
import { useT } from "@/components/i18n";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SheetClose } from "@/components/ui/sheet";

export function OutletPicker({
  outlets,
  value,
  onChange,
  className,
}: {
  outlets: readonly MyOutlet[];
  value: string | null;
  onChange: (outletId: string) => void;
  className?: string;
}) {
  const t = useT();
  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger
        aria-label={t("area.outletPicker")}
        className={cn(
          "w-full min-w-0 sm:w-auto sm:min-w-40 sm:max-w-full",
          className,
        )}
      >
        <SelectValue className="min-w-0 truncate" />
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

/**
 * Outlet choice as a list inside the status-bar sheet (phones). Picking a row
 * calls `onChange` and closes the sheet; it must render inside a `Sheet`.
 */
export function OutletList({
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
    <div
      role="group"
      aria-label={t("area.outletPicker")}
      className="grid gap-1"
    >
      {outlets.map((outlet) => {
        const active = outlet.id === value;
        return (
          <SheetClose key={outlet.id} asChild>
            <button
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() => {
                if (!active) onChange(outlet.id);
              }}
              className={cn(
                "flex min-h-12 w-full items-center justify-between gap-3 rounded-control px-3 text-left text-base hover:bg-accent",
                active && "font-semibold",
              )}
            >
              <span className="min-w-0 break-words">{outlet.name}</span>
              {active ? (
                <Check aria-hidden="true" className="size-icon shrink-0" />
              ) : null}
            </button>
          </SheetClose>
        );
      })}
    </div>
  );
}
