// Browse, search and label filters of the QR menu (PRD §3 F10 "Menu &
// Keranjang": telusuri kategori, cari, filter label). Pure: loaded by Node
// tests, so relative imports only.
import type { QrMenu, QrMenuItem } from "@starter/shared/qr-order";

export type MenuFilter = {
  /** Free-text search over name and description. */
  q: string;
  /** Category id; null shows every category. */
  category: string | null;
  /** Item must carry every selected label. */
  labels: readonly string[];
};

export type MenuSection = {
  category: QrMenu["categories"][number];
  items: QrMenuItem[];
};

export const EMPTY_FILTER: MenuFilter = { q: "", category: null, labels: [] };

/** Lowercase, accent-free, single-spaced: "Café  Latté" matches "cafe latte". */
export function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function isFiltering(filter: MenuFilter): boolean {
  return (
    normalizeSearch(filter.q) !== "" ||
    filter.category !== null ||
    filter.labels.length > 0
  );
}

/** Labels present on the menu, most used first, for the filter chips. */
export function menuLabels(menu: QrMenu): string[] {
  const counts = new Map<string, number>();
  for (const item of menu.items)
    for (const label of item.labels)
      counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label);
}

function matches(item: QrMenuItem, filter: MenuFilter): boolean {
  const needle = normalizeSearch(filter.q);
  if (
    needle !== "" &&
    !normalizeSearch(`${item.name} ${item.description}`).includes(needle)
  )
    return false;
  return filter.labels.every((label) => item.labels.includes(label));
}

/**
 * Sections in category order; inside a section the orderable items come first
 * and sold-out ones sink to the end (ORD-05: shown, never addable).
 */
export function filterMenu(menu: QrMenu, filter: MenuFilter): MenuSection[] {
  const sections: MenuSection[] = [];
  const categories = [...menu.categories].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  for (const category of categories) {
    if (filter.category !== null && filter.category !== category.id) continue;
    const items = menu.items
      .filter(
        (item) => item.categoryId === category.id && matches(item, filter),
      )
      .sort(
        (a, b) =>
          Number(a.status === "sold_out") - Number(b.status === "sold_out") ||
          a.sortOrder - b.sortOrder,
      );
    if (items.length > 0) sections.push({ category, items });
  }
  return sections;
}

export function countItems(sections: readonly MenuSection[]): number {
  return sections.reduce((total, section) => total + section.items.length, 0);
}
