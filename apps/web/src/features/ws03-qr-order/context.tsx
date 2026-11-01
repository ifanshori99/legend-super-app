// Shared state of one table journey (PRD §3 F10): the menu read model, the
// guest's session credential and the live session view (shared cart, quote,
// orders, waiter calls). Every screen under /t/$token reads it through
// useTableJourney(), so the cart count in the nav, the cart page and the
// checkout can never disagree.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { QrMenu, TableSessionView } from "@starter/shared/qr-order";
import { ApiError } from "@/lib/api/errors";
import { useSessionView, useStoredGuestSession } from "./hooks";
import { menuQuery } from "./queries";
import { forgetGuestSession } from "./session-store";
import type { StoredGuestSession } from "./lib/guest-session.ts";

export type TableJourney = {
  qrToken: string;
  /** Undefined while the menu loads or when the QR is unknown. */
  menu: QrMenu | undefined;
  menuError: ApiError | null;
  guest: StoredGuestSession | null;
  sessionId: string | null;
  participantId: string | null;
  view: TableSessionView | undefined;
  viewError: ApiError | null;
  /** ORD-04: the session is closed or gone; ordering needs a new scan. */
  ended: boolean;
  /** Open-bill zone, waiting for a waiter to confirm the table. */
  awaitingConfirmation: boolean;
  cartCount: number;
  openJoin: (afterItemId?: string) => void;
  closeJoin: () => void;
  joinOpen: boolean;
  /** Item to open once the guest has joined (the one they tapped). */
  pendingItemId: string | null;
  clearPendingItem: () => void;
  /** Drops the stored credential so the next scan opens a fresh session. */
  startOver: () => void;
};

function subscribeNever() {
  return () => {};
}

const Context = createContext<TableJourney | null>(null);

export function useTableJourney(): TableJourney {
  const value = useContext(Context);
  if (!value)
    throw new Error(
      "useTableJourney must be used under <TableJourneyProvider>",
    );
  return value;
}

export function TableJourneyProvider({
  qrToken,
  children,
}: {
  qrToken: string;
  children: ReactNode;
}) {
  const menuResult = useQuery(menuQuery(qrToken));
  const guest = useStoredGuestSession(qrToken);
  const sessionId = guest?.sessionId ?? null;
  const viewResult = useSessionView(sessionId);
  const [joinRequested, setJoinRequested] = useState(false);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);

  const view = viewResult.data?.data;
  const viewError =
    viewResult.error instanceof ApiError ? viewResult.error : null;
  const ended =
    guest !== null &&
    ((view !== undefined &&
      (view.session.status === "closed" || view.session.status === "voided")) ||
      viewError?.status === 404);

  // The first scanner fills in the guest count: ask once per tab after the
  // page has hydrated, never blocking the server-rendered menu.
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  const [dismissed, setDismissed] = useState(false);
  const joinOpen =
    joinRequested ||
    (hydrated &&
      !dismissed &&
      guest === null &&
      menuResult.data?.data.orderingOpen === true);

  const openJoin = useCallback((afterItemId?: string) => {
    setPendingItemId(afterItemId ?? null);
    setJoinRequested(true);
  }, []);
  const closeJoin = useCallback(() => {
    setJoinRequested(false);
    setDismissed(true);
  }, []);
  const clearPendingItem = useCallback(() => setPendingItemId(null), []);
  const startOver = useCallback(() => {
    forgetGuestSession(qrToken);
    setJoinRequested(true);
  }, [qrToken]);

  const value = useMemo<TableJourney>(
    () => ({
      qrToken,
      menu: menuResult.data?.data,
      menuError: menuResult.error instanceof ApiError ? menuResult.error : null,
      guest,
      sessionId,
      participantId: guest?.participantId ?? null,
      view,
      viewError,
      ended,
      awaitingConfirmation: view?.session.status === "pending_confirmation",
      cartCount: (view?.cart.lines ?? []).reduce(
        (sum, line) => sum + line.quantity,
        0,
      ),
      openJoin,
      closeJoin,
      joinOpen,
      pendingItemId,
      clearPendingItem,
      startOver,
    }),
    [
      qrToken,
      menuResult.data,
      menuResult.error,
      guest,
      sessionId,
      view,
      viewError,
      ended,
      openJoin,
      closeJoin,
      joinOpen,
      pendingItemId,
      clearPendingItem,
      startOver,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
