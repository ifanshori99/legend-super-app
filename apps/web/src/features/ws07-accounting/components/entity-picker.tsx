// Legal-entity context for every accounting screen. The entity is data (one
// or many per tenant); screens never hard-code an id. With a single entity the
// name is shown as plain context instead of a disabled select.
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useEntityPicker } from "../hooks";

export type EntityRef = { id: string; name: string };

export function EntityPicker({
  entities,
  value,
  onChange,
}: {
  entities: readonly EntityRef[];
  value: string | undefined;
  onChange: (entityId: string) => void;
}) {
  const t = useT();
  if (entities.length === 0) return null;
  if (entities.length === 1)
    return (
      <p className="text-sm leading-5 text-muted-foreground">
        {t("accounting.entity.label")}:{" "}
        <span className="font-medium text-foreground">{entities[0]?.name}</span>
      </p>
    );
  return (
    <div className="grid max-w-sm gap-1.5">
      <Label htmlFor="accounting-entity">{t("accounting.entity.label")}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="accounting-entity" className="h-control-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {entities.map((entity) => (
            <SelectItem key={entity.id} value={entity.id}>
              {entity.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("accounting.entity.hint")}
      </p>
    </div>
  );
}

/**
 * Loads the legal entities and renders the picker above `children`. Screens
 * that need an entity take it as an argument, so the whole screen re-reads
 * when the picker changes.
 */
export function EntityScope({
  children,
}: {
  children: (entity: EntityRef) => ReactNode;
}) {
  const t = useT();
  const picker = useEntityPicker();
  if (picker.entitiesQuery.isPending) {
    return (
      <div className="grid gap-2" aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-control-sm w-52" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (picker.entitiesQuery.isError)
    return (
      <ErrorState
        onRetry={() => {
          void picker.entitiesQuery.refetch();
        }}
      />
    );
  if (!picker.entity)
    return (
      <EmptyState
        title={t("accounting.entity.empty")}
        description={t("accounting.entity.hint")}
      />
    );
  return (
    <div className="grid min-w-0 gap-4">
      <EntityPicker
        entities={picker.entities}
        value={picker.entity.id}
        onChange={picker.selectEntity}
      />
      {children(picker.entity)}
    </div>
  );
}
