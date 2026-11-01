// Applies density / color mode / tenant to a subtree and makes overlays
// (Dialog, Sheet, Select, DropdownMenu, Toast) portal into that subtree, so
// a POS dialog keeps Kontras Tinggi sizes instead of the page default.
import { createContext, useContext, useState, type ReactNode } from "react";
import { cn } from "cn";
import type { ColorMode, Density } from "@starter/shared/theme";

const PortalContainerContext = createContext<HTMLElement | null>(null);

/** Container for Radix portals; undefined falls back to document.body. */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}

export function ThemeScope({
  density,
  mode,
  tenant,
  className,
  children,
  ...props
}: {
  density?: Density;
  /** Force a color mode for this subtree, e.g. "dark" for the kitchen. */
  mode?: ColorMode;
  /** Tenant id whose TenantThemeStyle is on the page. */
  tenant?: string;
  className?: string;
  children: ReactNode;
} & Omit<React.ComponentProps<"div">, "children">) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={setNode}
      data-density={density}
      data-theme={mode}
      data-tenant={tenant}
      className={cn("bg-background text-foreground", className)}
      {...props}
    >
      <PortalContainerContext.Provider value={node}>
        {children}
      </PortalContainerContext.Provider>
    </div>
  );
}
