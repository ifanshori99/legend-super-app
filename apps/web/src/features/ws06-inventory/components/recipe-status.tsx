// Status of a recipe and of a production batch, always icon + text
// (DESIGN.md §2 status; WCAG 1.4.1). The pill colors follow the fixed status
// tokens, so a tenant theme can never change the meaning.
import {
  Ban,
  CircleCheck,
  Clock,
  FilePen,
  type LucideIcon,
} from "lucide-react";
import type { ProductionOrderStatus } from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";

type Tone = "neutral" | "success" | "info";

export function RecipeActiveBadge({ isActive }: { isActive: boolean }) {
  const t = useT();
  return (
    <Badge tone={isActive ? "success" : "neutral"}>
      {isActive ? (
        <CircleCheck aria-hidden="true" />
      ) : (
        <Ban aria-hidden="true" />
      )}
      {t(
        isActive
          ? "inventoryRecipe.list.active"
          : "inventoryRecipe.list.inactive",
      )}
    </Badge>
  );
}

const PRODUCTION_STATUS: Record<
  ProductionOrderStatus,
  {
    tone: Tone;
    icon: LucideIcon;
    label:
      | "inventoryRecipe.production.status.draft"
      | "inventoryRecipe.production.status.in_progress"
      | "inventoryRecipe.production.status.completed"
      | "inventoryRecipe.production.status.cancelled";
  }
> = {
  draft: {
    tone: "neutral",
    icon: FilePen,
    label: "inventoryRecipe.production.status.draft",
  },
  in_progress: {
    tone: "info",
    icon: Clock,
    label: "inventoryRecipe.production.status.in_progress",
  },
  completed: {
    tone: "success",
    icon: CircleCheck,
    label: "inventoryRecipe.production.status.completed",
  },
  cancelled: {
    tone: "neutral",
    icon: Ban,
    label: "inventoryRecipe.production.status.cancelled",
  },
};

export function ProductionStatusBadge({
  status,
}: {
  status: ProductionOrderStatus;
}) {
  const t = useT();
  const { tone, icon: Icon, label } = PRODUCTION_STATUS[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(label)}
    </Badge>
  );
}
