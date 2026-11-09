import starter from "../../../starter.config.json" with { type: "json" };

// App identity, read from starter.config.json at the repository root. Change
// the name and description there; both apps pick them up.
export const siteConfig = {
  id: starter.id,
  name: starter.name,
  description: starter.description,
  // The public brand website. Not where a signed-in visitor lands.
  homePath: "/",
  // Where sign-up, sign-in and an already signed-in visitor on /sign-in go: the
  // app shell, which carries Sign out. A fixed internal path, never read from
  // the URL or a query parameter, so it cannot become an open redirect.
  appHomePath: "/notes",
} as const;
