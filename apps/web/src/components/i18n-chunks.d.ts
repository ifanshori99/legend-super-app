// Virtual modules served by vite-i18n-chunks.ts: one per catalog chunk.
declare module "virtual:i18n/*" {
  export const messages: import("@starter/shared/i18n/runtime").CatalogNode;
}
