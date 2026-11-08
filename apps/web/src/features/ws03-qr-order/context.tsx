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
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { QrMenu, TableSessionView } from "@starter/shared/qr-order";
import { ApiError } from "@/lib/api/errors";
import { useSessionView, useStoredGuestSession } from "./hooks";
import { menuQuery } from "./queries";
import { forgetGuestSession } from "./session-store";
import type { StoredGuestSession } from "./lib/guest-session.ts";
import type { Selection } from "./lib/item-options.ts";

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
  /**
   * An unjoined guest's item choices, kept while they fill in the guest count
   * so the item sheet reopens as they left it. Read with peek, drop with clear.
   */
  stashSelection: (itemId: string, selection: Selection) => void;
  peekSelection: (itemId: string) => Selection | null;
  clearSelection: () => void;
  /** Drops the stored credential so the next scan opens a fresh session. */
  startOver: () => void;
};

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

  // Founder Q5 (legend-2re1): no welcome dialog. The menu is browsable
  // straight away; the guest count is an inline control in the menu header,
  // required before the first item. openJoin() opens that control (and
  // brings the guest back to the menu from any other table page).
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const menuPath = `/t/${encodeURIComponent(qrToken)}`;
  const joinOpen = joinRequested && guest === null;

  const openJoin = useCallback(
    (afterItemId?: string) => {
      setPendingItemId(afterItemId ?? null);
      setJoinRequested(true);
      if (pathname !== menuPath && pathname !== `${menuPath}/`)
        void navigate({ to: "/t/$token", params: { token: qrToken } });
    },
    [navigate, pathname, menuPath, qrToken],
  );
  const closeJoin = useCallback(() => {
    setJoinRequested(false);
  }, []);
  const clearPendingItem = useCallback(() => setPendingItemId(null), []);
  // A ref, not state: the menu clears the pending item the moment it reopens
  // the sheet, and the sheet reads the choices after that.
  const stashed = useRef<{ itemId: string; selection: Selection } | null>(null);
  const stashSelection = useCallback((itemId: string, selection: Selection) => {
    stashed.current = { itemId, selection };
  }, []);
  const peekSelection = useCallback(
    (itemId: string) =>
      stashed.current?.itemId === itemId ? stashed.current.selection : null,
    [],
  );
  const clearSelection = useCallback(() => {
    stashed.current = null;
  }, []);
  const startOver = useCallback(() => {
    forgetGuestSession(qrToken);
    setJoinRequested(true);
    if (pathname !== menuPath && pathname !== `${menuPath}/`)
      void navigate({ to: "/t/$token", params: { token: qrToken } });
  }, [navigate, pathname, menuPath, qrToken]);

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
      stashSelection,
      peekSelection,
      clearSelection,
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
      stashSelection,
      peekSelection,
      clearSelection,
      startOver,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
