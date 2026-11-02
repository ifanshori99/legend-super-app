// Empty and error states for lists and data regions (PRD: setiap daftar
// memiliki state loading, empty, dan error). Every error says how to fix it
// (PRD: setiap pesan error disertai petunjuk perbaikan).
import * as React from "react";
import { cn } from "cn";
import { Inbox, RotateCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";

type StateProps = {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  /** The next useful action, e.g. a "Tambah menu" button. */
  action?: React.ReactNode;
  className?: string;
};

function StateLayout({
  icon: Icon,
  iconClass,
  title,
  description,
  action,
  className,
  ...props
}: StateProps & {
  icon: LucideIcon;
  iconClass: string;
  title: string;
} & Omit<React.ComponentProps<"div">, "title">) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 px-4 py-10 text-center",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "grid size-14 place-items-center rounded-full",
          iconClass,
        )}
      >
        <Icon className="size-7" aria-hidden="true" />
      </span>
      <div className="grid max-w-sm gap-1">
        <p className="text-base leading-6 font-semibold">{title}</p>
        {description && (
          <p className="text-sm leading-5 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

function EmptyState({ title, description, icon = Inbox, ...rest }: StateProps) {
  const t = useT();
  return (
    <StateLayout
      data-slot="empty-state"
      icon={icon}
      iconClass="bg-primary-tint text-primary"
      title={title ?? t("state.emptyTitle")}
      description={description ?? t("state.emptyHint")}
      {...rest}
    />
  );
}

function ErrorState({
  title,
  description,
  icon = TriangleAlert,
  onRetry,
  action,
  ...rest
}: StateProps & { onRetry?: () => void }) {
  const t = useT();
  return (
    <StateLayout
      data-slot="error-state"
      role="alert"
      icon={icon}
      iconClass="bg-danger-subtle text-danger"
      title={title ?? t("state.errorTitle")}
      description={description ?? t("state.errorHint")}
      action={
        action ??
        (onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw aria-hidden="true" />
            {t("common.retry")}
          </Button>
        ))
      }
      {...rest}
    />
  );
}

export { EmptyState, ErrorState };
