import type { ComponentType, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export type ShellNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Set from the router location by the route that renders the shell. */
  current?: boolean;
  /** Count the user acts on, e.g. open approvals. */
  count?: number;
  /** Sidebar group heading (management shell); consecutive items share one. */
  group?: string;
};

export type ShellLinkProps = {
  href: string;
  className?: string;
  "aria-current"?: "page";
  /** Hover label where the visible text is hidden (management icon rail). */
  title?: string;
  onClick?: () => void;
  children: ReactNode;
};

/**
 * Shells render links through this component so routes can pass a router
 * Link (client navigation) without the shell depending on route types:
 *   LinkComponent={({ href, ...p }) => <Link to={href} {...p} />}
 */
export type ShellLinkComponent = ComponentType<ShellLinkProps>;

export function PlainLink({ href, children, ...props }: ShellLinkProps) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
