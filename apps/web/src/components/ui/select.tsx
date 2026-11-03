import * as React from "react";
import { cn } from "cn";
import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { usePortalContainer } from "@/components/theme-scope";
import { fieldClass } from "@/components/ui/input";

const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

/**
 * Radix's Root renders no DOM node, so the id and ARIA props `FormField`
 * injects through its `Slot.Root` had nowhere to land: the label's `for`
 * pointed at nothing and a select was reachable only by position. Remember
 * them here and put them on the trigger, the element the user actually
 * focuses (WCAG 3.3.1 / 4.1.3).
 */
type SelectFieldProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
};
const SelectField = React.createContext<SelectFieldProps>({});

function Select({
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  "aria-required": required,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root> & SelectFieldProps) {
  const field = React.useMemo(
    () => ({
      id,
      "aria-describedby": describedBy,
      "aria-invalid": invalid,
      "aria-required": required,
    }),
    [id, describedBy, invalid, required],
  );
  return (
    <SelectField.Provider value={field}>
      <SelectPrimitive.Root {...props} />
    </SelectField.Provider>
  );
}

function SelectTrigger({
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  "aria-required": required,
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  const field = React.useContext(SelectField);
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      id={id ?? field.id}
      aria-describedby={describedBy ?? field["aria-describedby"]}
      aria-invalid={invalid ?? field["aria-invalid"]}
      aria-required={required ?? field["aria-required"]}
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
