import * as React from "react";
import { cn } from "cn";
import { Tabs as TabsPrimitive } from "radix-ui";

// Tabs for switching views of the same content (arrow keys move between
// tabs, per the WAI-ARIA tabs pattern Radix implements). v3 (Metoric tab
// group): a bordered track on surface-2; the active tab is a card chip with
// a hairline ring — selected in ink, never in accent (accent budget, Q21).
const Tabs = TabsPrimitive.Root;

/**
 * The tab-group look as classes, for link sub-navigation (a <nav> of router
 * Links between sibling pages): put `tabsListClass` on the list and
 * `tabsTriggerClass` on each link with `aria-current="page"` on the current
 * one. Same look as <Tabs>, so a section's page tabs and in-page tabs match.
 */
const tabsListClass =
  "inline-flex w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-control border-(length:--border-w) bg-surface-2 p-1 [scrollbar-width:none]";
const tabsTriggerClass =
  "inline-flex min-h-[calc(var(--control-h-sm)-0.5rem)] shrink-0 items-center gap-2 rounded-[max(calc(var(--control-radius)-0.25rem),0.25rem)] px-3.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-card data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_0_0_1px_var(--border),var(--elevation-hairline)] aria-[current=page]:bg-card aria-[current=page]:font-semibold aria-[current=page]:text-foreground aria-[current=page]:shadow-[inset_0_0_0_1px_var(--border),var(--elevation-hairline)] [&_svg]:size-4";

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(tabsListClass, className)}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(tabsTriggerClass, className)}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("pt-4 outline-none", className)}
      {...props}
    />
  );
}

export {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  tabsListClass,
  tabsTriggerClass,
};
