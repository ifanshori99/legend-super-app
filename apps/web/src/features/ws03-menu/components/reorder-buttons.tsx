// Keyboard-accessible display order control. Rows can also be dragged with a
// mouse; these buttons are the accessible path and the only one on touch.
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ReorderButtons({
  index,
  count,
  labelUp,
  labelDown,
  onMove,
  disabled = false,
}: {
  index: number;
  count: number;
  /** Already translated, e.g. t("menu.list.moveUp", { name }). */
  labelUp: string;
  labelDown: string;
  onMove: (direction: -1 | 1) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={labelUp}
        disabled={disabled || index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUp aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={labelDown}
        disabled={disabled || index === count - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDown aria-hidden="true" />
      </Button>
    </div>
  );
}
