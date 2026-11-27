import { useSyncExternalStore } from "react";
import {
  DEFAULT_TABLET_PRINTER,
  subscribeTabletPrinter,
  tabletPrinterSnapshot,
  type TabletPrinter,
} from "./printer-settings.ts";

/** This tablet's printer; the default on the server, the stored one after. */
export function useTabletPrinter(): TabletPrinter {
  return useSyncExternalStore(
    subscribeTabletPrinter,
    tabletPrinterSnapshot,
    () => DEFAULT_TABLET_PRINTER,
  );
}
