import { Link } from "@tanstack/react-router";
import type { ShellLinkComponent } from "@/components/shells/nav";

/**
 * Router link for the shells. Shell nav hrefs are data (features/<ws>-<name>/nav.ts),
 * so they cannot be checked against the generated route union.
 */
export const RouterShellLink: ShellLinkComponent = ({
  href,
  children,
  ...props
}) => (
  <Link to={href as "/"} {...props}>
    {children}
  </Link>
);
