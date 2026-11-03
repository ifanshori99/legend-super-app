import * as React from "react";
import { cn } from "cn";
import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { usePortalContainer } from "@/components/theme-scope";
import { fieldClass } from "@/components/ui/input";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

/**
 * The wiring FormField cannot hand to a Radix Select: the root renders no DOM
 * node, so the id/aria props its Slot clones onto the child are dropped before
 * they reach the trigger (legend-n138). FormField provides this for a direct
 * Select child; SelectTrigger consumes it unless the caller passed its own
 * prop. Native controls keep using the Slot path.
 */
type FormFieldSelectContextValue = {
  controlId: string;
  labelId: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
};

const FormFieldSelectContext =
  React.createContext<FormFieldSelectContextValue | null>(null);

function SelectTrigger({
  className,
  children,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "aria-required": ariaRequired,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  const field = React.useContext(FormFieldSelectContext);
  // An explicit aria-label already names the trigger; aria-labelledby would
  // override it, so only fall back to the FormField label when there is none.
  const labelledBy =
    ariaLabelledBy ?? (ariaLabel === undefined ? field?.labelId : undefined);
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      id={id ?? field?.controlId}
      aria-labelledby={labelledBy}
      aria-describedby={ariaDescribedBy ?? field?.describedBy}
      aria-invalid={ariaInvalid ?? (field?.invalid ? true : undefined)}
      // Radix sets aria-required from the Root's `required` prop; keep that
      // when neither the caller nor FormField has an opinion.
      {...(ariaRequired === undefined && !field?.required
        ? {}
        : { "aria-required": ariaRequired ?? true })}
      className={cn(
        fieldClass,
        "flex h-control items-center justify-between gap-2 px-3 text-left data-placeholder:text-muted-foreground [&>span]:truncate",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown
          className="size-icon shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal container={usePortalContainer()}>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={4}
        className={cn(
          "relative z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden rounded-lg border bg-popover text-foreground shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn(
        "px-3 pt-2 pb-1 text-xs font-semibold text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex min-h-control-sm cursor-default items-center gap-2 rounded-md py-1.5 pr-9 pl-3 text-(length:--density-text) outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-3 inline-flex">
        <Check className="size-icon text-primary" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export {
  FormFieldSelectContext,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
export type { FormFieldSelectContextValue };
