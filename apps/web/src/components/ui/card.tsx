import * as React from "react";
import { cn } from "cn";

// One container per real group (DESIGN.md: no cards inside cards). v3
// (Metoric): a 12px card with a hairline border and a 1px resting shadow.
// Big cards (stat strip, chart, table) sit inside a CardShell: an 18px
// outer shell one tone darker with 8px padding — the only allowed nesting.
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-4 rounded-container border-(length:--border-w) bg-card p-card text-foreground shadow-hairline",
        className,
      )}
      {...props}
    />
  );
}

/**
 * v3 double-shell card (DESIGN.md §4): outer shell `rounded-shell bg-shell`
 * with 8px padding around one inner Card (or a CardShellBody). Put an
 * optional CardShellFooter after it for a source link or period line.
 */
function CardShell({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-shell"
      className={cn(
        "flex min-w-0 flex-col rounded-shell border-(length:--border-w) bg-shell p-2 text-foreground shadow-hairline",
        className,
      )}
      {...props}
    />
  );
}

/** The inner card of a CardShell when it is not a full Card (no padding). */
function CardShellBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-shell-body"
      className={cn(
        "flex min-w-0 flex-1 flex-col overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline",
        className,
      )}
      {...props}
    />
  );
}

/** Line under the inner card, on the shell (period, source link). */
function CardShellFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-shell-footer"
      className={cn(
        "flex items-center gap-2 px-2.5 pt-3 pb-1 text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "grid auto-rows-min items-start gap-1 has-data-[slot=card-action]:grid-cols-[1fr_auto]",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="card-title"
      className={cn("type-heading", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn("text-sm leading-5 text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn(className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  );
}

export {
  Card,
  CardShell,
  CardShellBody,
  CardShellFooter,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
};
