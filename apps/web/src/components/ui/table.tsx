import * as React from "react";
import { cn } from "cn";

// Semantic table. Row height and cell text follow density (h-row, text-(length:--density-text-data)).
// Wide tables scroll inside their own container, never the page.
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn(
          "w-full caption-bottom border-collapse text-(length:--density-text-data)",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn(
        "bg-surface-2 [&_tr]:border-b [&_tr]:hover:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-surface-2 font-semibold", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        // v2 (DESIGN.md §4 Tables): hover is one surface step; a selected row
        // takes the accent tint plus a 2px leading rule (owner Q29).
        "border-b transition-colors duration-(--duration-fast) hover:bg-surface-2 data-[state=selected]:bg-primary-tint data-[state=selected]:[&>*:first-child]:shadow-[inset_2px_0_0_var(--primary)]",
        className,
      )}
      {...props}
    />
  );
}

type CellProps = { numeric?: boolean };

function TableHead({
  className,
  numeric,
  ...props
}: React.ComponentProps<"th"> & CellProps) {
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn(
        "h-row px-3 text-left align-middle type-eyebrow whitespace-nowrap text-muted-foreground",
        numeric && "text-right",
        className,
      )}
      {...props}
    />
  );
}

/** `numeric` right-aligns and uses tabular figures so amounts line up. */
function TableCell({
  className,
  numeric,
  ...props
}: React.ComponentProps<"td"> & CellProps) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "h-row px-3 align-middle",
        numeric && "text-right whitespace-nowrap tabular",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-3 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
};
