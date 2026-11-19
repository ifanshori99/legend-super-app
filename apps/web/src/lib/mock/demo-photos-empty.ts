// Production stub for `virtual:demo-photo-map` (see vite.config.ts).
//
// The demo photo map is mock/demo only (owner Q17/Q24, legend-4pki). A normal
// build aliases that specifier to this module instead of the real map, so no
// `/sample/menu` path can enter the production client or server bundle, and
// the website overlay helpers all return empty. Mock/demo builds alias to
// `src/lib/mock/demo-photos.ts`, the single source of truth.
export const demoPhotos: Record<string, string> = {};

export const demoPhotoRefs: Record<string, string> = {};

export function demoHeroPhoto(): string | null {
  return null;
}

export function demoGalleryPhotos(): string[] {
  return [];
}
