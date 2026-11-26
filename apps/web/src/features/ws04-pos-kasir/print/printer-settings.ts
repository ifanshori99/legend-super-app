// The printer of this tablet (P2, docs/design/cloud-only-release.md section 3):
// RawBT, the browser's own print dialog, or none. Kept in this browser only,
// because each tablet has its own printer and paper. Pure over an injected
// Storage: Node tests load it directly.
import type { PrintPaperWidth } from "@starter/shared/pos";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type PrinterMethod = "rawbt" | "browser" | "none";
export const PRINTER_METHODS: readonly PrinterMethod[] = [
  "rawbt",
  "browser",
  "none",
];
export const PAPER_WIDTHS: readonly PrintPaperWidth[] = [32, 48];

export type TabletPrinter = {
  method: PrinterMethod;
  /** Characters per line: 32 for 58 mm paper, 48 for 80 mm paper. */
  paperWidth: PrintPaperWidth;
};

/** Works on any tablet or laptop: the browser print dialog, 58 mm. */
export const DEFAULT_TABLET_PRINTER: TabletPrinter = Object.freeze({
  method: "browser",
  paperWidth: 32,
});

const KEY = "pos-kasir:printer:v1";

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let memory: string | null = null;
const listeners = new Set<() => void>();

function parse(raw: string | null): TabletPrinter {
  if (raw === null) return DEFAULT_TABLET_PRINTER;
  try {
    const value = JSON.parse(raw) as Partial<TabletPrinter>;
    if (
      PRINTER_METHODS.includes(value.method as PrinterMethod) &&
      PAPER_WIDTHS.includes(value.paperWidth as PrintPaperWidth)
    )
      return {
        method: value.method as PrinterMethod,
        paperWidth: value.paperWidth as PrintPaperWidth,
      };
  } catch {
    // A broken entry is the same as none.
  }
  return DEFAULT_TABLET_PRINTER;
}

function readRaw(storage: StorageLike | null): string | null {
  try {
    return storage?.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function readTabletPrinter(
  storage: StorageLike | null = browserStorage(),
): TabletPrinter {
  return parse(readRaw(storage));
}

export function writeTabletPrinter(
  printer: TabletPrinter,
  storage: StorageLike | null = browserStorage(),
): void {
  const raw = JSON.stringify(printer);
  memory = raw;
  try {
    storage?.setItem(KEY, raw);
  } catch {
    // Memory still holds it for this page.
  }
  for (const listener of listeners) listener();
}

/** The width to ask the cloud for; none means no bytes are wanted. */
export function paperWidthOf(
  printer: TabletPrinter,
): PrintPaperWidth | undefined {
  return printer.method === "none" ? undefined : printer.paperWidth;
}

// For useSyncExternalStore: one stable object per stored value.
let cachedRaw: string | null | undefined;
let cachedValue: TabletPrinter = DEFAULT_TABLET_PRINTER;

export function tabletPrinterSnapshot(): TabletPrinter {
  const raw = readRaw(browserStorage());
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedValue = parse(raw);
  }
  return cachedValue;
}

export function subscribeTabletPrinter(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener();
  };
  if (typeof window !== "undefined")
    window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
}
