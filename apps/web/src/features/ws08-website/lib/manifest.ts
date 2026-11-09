// The installable web manifest for one brand (PRD §5, TEN-08): the name is the
// tenant's, never the platform's. Pure builder, so a unit test covers it with
// plain Node type stripping.

const SHORT_NAME_MAX = 12;

export function manifestFor(brandName: string) {
  return {
    name: brandName,
    short_name:
      brandName.length <= SHORT_NAME_MAX
        ? brandName
        : brandName.slice(0, SHORT_NAME_MAX).trimEnd(),
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
