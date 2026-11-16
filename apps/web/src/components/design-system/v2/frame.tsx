import { useT } from "@/components/i18n";
// Frames for the v2 before/after board. A frame is a labeled, clipped
// region that holds one real screen composition (no device chrome).
import * as React from "react";
import { cn } from "cn";

export type CompareView = "both" | "before" | "after";

export function Screen({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="grid min-w-0 content-start gap-2">
      <figcaption className="text-sm font-semibold text-muted-foreground">
        {label}
      </figcaption>
      <div
        className={cn(
          "relative overflow-hidden rounded-container border bg-background",
          className,
        )}
      >
        {children}
      </div>
    </figure>
  );
}

export function Stage({
  tag,
  title,
  note,
  children,
}: {
  tag: "before" | "after";
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <section data-stage={tag} aria-label={title} className="grid min-w-0 gap-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 type-eyebrow",
            tag === "after"
              ? "bg-primary text-primary-foreground"
              : "bg-surface-3 text-muted-foreground",
          )}
        >
          {tag === "after"
            ? t("designV2.frame.text001")
            : t("designV2.frame.text002")}
        </span>
        <h3 className="type-heading">{title}</h3>
        <p className="w-full text-sm text-muted-foreground">{note}</p>
      </header>
      {children}
    </section>
  );
}

export function Compare({
  view,
  before,
  after,
}: {
  view: CompareView;
  before: React.ReactNode;
  after: React.ReactNode;
}) {
  return (
    <div className="grid gap-12">
      {view !== "after" && before}
      {view !== "before" && after}
    </div>
  );
}
