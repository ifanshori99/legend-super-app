// Demo media overlay for screens that render a contract payload (the public
// website): the payload's own image URLs are https and stay untouched, but the
// sample fixtures carry none, so mock mode overlays the shared Unsplash samples
// by item name. The data source is compile-time: `virtual:demo-photo-map` is
// aliased to `src/lib/mock/demo-photos.ts` in mock/demo builds and to an empty
// stub in a normal build (vite.config.ts), so a production bundle contains no
// sample paths (legend-4pki / legend-6vki).
import {
  demoGalleryPhotos,
  demoHeroPhoto,
  demoPhotoRefs,
  demoPhotos,
} from "virtual:demo-photo-map";

/** Demo photo for a menu item name, or null when there is none. */
export function demoMenuPhoto(name: string): string | null {
  return demoPhotos[name] ?? null;
}

/** Demo photo for a sample reference (see `demoPhotoRefs`), or null. */
export function demoMenuPhotoRef(ref: string): string | null {
  const name = demoPhotoRefs[ref];
  return name ? demoMenuPhoto(name) : null;
}

export { demoGalleryPhotos, demoHeroPhoto };
