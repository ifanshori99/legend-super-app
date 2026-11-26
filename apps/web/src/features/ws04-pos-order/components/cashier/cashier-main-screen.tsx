import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  useNavigate,
  useRouter,
  useRouteContext,
  useSearch,
} from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import {
  needsCashierClose,
  ORDER_INTENT_PENDING,
  PARK_INTENT_PENDING,
} from "@/features/ws04-pos-order/order-flow";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { ModifierDialog } from "@/features/ws04-pos-order/components/modifier-dialog";
import { Button } from "@/components/ui/button";
import {
  Notice,
  PosPageHeading,
} from "@/features/ws04-pos-kasir/components/shared";
import { cartTotals, needsChoice } from "@/features/ws04-pos-order/cart-logic";
import { inputOfMeta, sameOrder } from "@/features/ws04-pos-order/order-wire";
import { readDraft, useDraftCart } from "@/features/ws04-pos-order/draft-store";
import {
  isContractPending,
  useCashierDraftKey,
  useCloseResume,
  useOtherCashierPending,
  usePendingOrder,
  useParkDraft,
  useReplayPendingResumes,
  useSubmitOrder,
} from "@/features/ws04-pos-order/hooks";
import type {
  CartLine,
  MenuItem,
  OrderMeta,
  ParkedDraft,
} from "@/features/ws04-pos-order/types";
import { CartPane, type CartOrderMeta } from "./cart-pane";
import { CatalogPane } from "./catalog-pane";
import type { ChannelDetailError } from "./channel-toggle";
import { MobileCartBar } from "./mobile-cart-bar";
import { ParkedDraftsSheet } from "./parked-drafts-sheet";

type StatusMessage =
  "parkedOk" | "resumedOk" | "resumedMissing" | "heldReleased" | "placed";

interface Status {
  key: StatusMessage;
  params?: Record<string, string | number>;
}

// Errors the cashier fixes in the cart (not by retrying the same cart).
const CART_FIX_CODES = new Set([
  "ITEM_SOLD_OUT",
  "ITEM_UNAVAILABLE",
  "INVALID_MODIFIER",
  "MODIFIER_REQUIRED",
]);

// /pos/kasir: the cashier's main sale screen. The menu (C1) sits on the left,
// the cart on the right; below 701 px they are two views and a bottom bar opens
// the cart. "Lanjutkan pesanan" submits the order and goes to payment.
export function CashierMainScreen() {
  const t = useT();
  const navigate = useNavigate();
  const router = useRouter();
  const draftKey = useCashierDraftKey();
  const cart = useDraftCart(draftKey);
  const access = (useRouteContext({ strict: false }) as { access?: AreaAccess })
    .access;
  const canAcceptPayment = access
    ? holdsAny(access, ["pos.payment.accept"])
    : false;
  const submit = useSubmitOrder({ draftKey });
  const park = useParkDraft({ draftKey });
  // A send whose answer was lost (or a refresh, or a copied tab): the cashier
  // brings it back exactly and sends it again with the same key.
  const pendingOrder = usePendingOrder(draftKey);
  const pendingPark = usePendingOrder(draftKey, "park");
  const otherCashierPending = useOtherCashierPending();
  const closeResume = useCloseResume();
  // A resume that was sent but not answered is replayed when the screen opens.
  const replay = useReplayPendingResumes({ draftKey });

  const [meta, setMeta] = useState<CartOrderMeta>({
    channel: "dine_in",
    tableLabel: null,
    tableSessionId: null,
    ojolPlatform: null,
    ojolRef: "",
  });
  // The phone view lives in the URL (`?v=keranjang`), so Back returns to the menu.
  const { v, ditahan } = useSearch({ from: "/_ops/pos/kasir" });
  const view = v === "keranjang" ? "cart" : "menu";
  // Whether the cart view was opened by a push from this screen: then "back to
  // menu" is a real history Back; a cart opened directly (deep link) is replaced.
  const cartOpenedByPush = useRef(false);
  useEffect(() => {
    if (view === "menu") cartOpenedByPush.current = false;
  }, [view]);
  const setView = (next: "menu" | "cart") => {
    if (next === "menu" && cartOpenedByPush.current) {
      cartOpenedByPush.current = false;
      router.history.back();
      return;
    }
    if (next === "cart") cartOpenedByPush.current = true;
    void navigate({
      to: "/pos/kasir",
      search: (prev) => ({
        ...prev,
        v: next === "cart" ? ("keranjang" as const) : undefined,
      }),
      replace: next === "menu",
    });
  };
  const [pickedItem, setPickedItem] = useState<MenuItem | null>(null);
  // "Lanjutkan" on the open orders list (`?ditahan=1`) opens the parked sheet
  // once; the flag leaves the URL so a refresh does not open it again.
  const [parkedOpen, setParkedOpen] = useState(ditahan === "1");
  useEffect(() => {
    if (ditahan !== "1") return;
    void navigate({
      to: "/pos/kasir",
      search: (prev) => ({ ...prev, ditahan: undefined }),
      replace: true,
    });
  }, [ditahan, navigate]);
  const [fieldError, setFieldError] = useState<ChannelDetailError>(null);
  const [fieldErrorToken, setFieldErrorToken] = useState(0);
  // The lines the cashier just removed (newest last), kept briefly so "Urungkan"
  // can restore them one by one, the last removed first.
  const [removed, setRemoved] = useState<{ line: CartLine; index: number }[]>(
    [],
  );
  const [status, setStatus] = useState<Status | null>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  // Where focus goes after a removal or an undo: a row's first control, or the
  // "Urungkan" button when there is no row to go to.
  const focusAfter = useRef<{ lineId: string | null } | null>(null);

  const totals = cartTotals(cart.lines);

  useEffect(() => {
    if (removed.length === 0) return;
    const timer = setTimeout(() => setRemoved([]), 8000);
    return () => clearTimeout(timer);
  }, [removed]);

  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    const row = target.lineId
      ? document.querySelector<HTMLElement>(
          `[data-slot="cart-pane"] [data-line-focus="${CSS.escape(target.lineId)}"]`,
        )
      : null;
    (row ?? undoRef.current)?.focus();
  }, [removed]);

  const fail = (field: Exclude<ChannelDetailError, null>) => {
    setFieldError(field);
    setFieldErrorToken((token) => token + 1);
  };

  const setQuantity = (lineId: string, quantity: number) => {
    if (quantity <= 0) {
      const index = cart.lines.findIndex((line) => line.lineId === lineId);
      const line = cart.lines[index];
      if (line) {
        setRemoved((current) => [...current, { line, index }]);
        focusAfter.current = {
          lineId: cart.lines[index + 1]?.lineId ?? null,
        };
      }
    }
    cart.setQuantity(lineId, quantity);
  };

  const undoRemove = () => {
    const last = removed[removed.length - 1];
    if (!last) return;
    const next = [...cart.lines];
    next.splice(Math.min(last.index, next.length), 0, last.line);
    cart.replace(next);
    setRemoved(removed.slice(0, -1));
    focusAfter.current = { lineId: last.line.lineId };
  };

  const changeMeta = (patch: Partial<CartOrderMeta>) => {
    setMeta((current) => ({ ...current, ...patch }));
    setFieldError(null);
    setStatus(null);
    submit.reset();
    park.reset();
  };

  const pick = (item: MenuItem) => {
    // A success empties the cart: an item added meanwhile would be lost.
    if (item.soldOut || park.isPending || submit.isPending) return;
    setStatus(null);
    if (!needsChoice(item)) {
      cart.add(item, { modifiers: [], note: "", quantity: 1 });
      return;
    }
    setPickedItem(item);
  };

  const continueOrder = () => {
    const { channel, tableSessionId, ojolPlatform, ojolRef } = meta;
    if (channel === "dine_in" && !tableSessionId) {
      fail("table");
      return;
    }
    if (channel === "ojol_manual" && !ojolPlatform) {
      fail("ojolPlatform");
      return;
    }
    if (channel === "ojol_manual" && ojolRef.trim() === "") {
      fail("ojolRef");
      return;
    }
    setFieldError(null);
    setStatus(null);
    setRemoved([]);
    send(meta, cart.lines);
  };

  const send = (sent: OrderMeta, lines: CartLine[]) => {
    submit.mutate(
      { ...inputOfMeta(sent, lines), meta: sent },
      {
        // The hook empties the draft; here the screen only moves on. Only a
        // cashier who may take payment goes to the payment screen.
        onSuccess: (order) => {
          if (canAcceptPayment) {
            void navigate({
              to: "/pos/bayar/$orderId",
              params: { orderId: order.orderId },
            });
            return;
          }
          setStatus({ key: "placed", params: { number: order.number } });
        },
        onSettled: pendingOrder.refresh,
      },
    );
  };

  // Bringing the unclear order back replaces the cart on screen. When that
  // cart is a different order, it is parked first (and only replaced once the
  // park is done), after the cashier agrees.
  const [confirmRestore, setConfirmRestore] = useState(false);

  const restoreNow = () => {
    const snapshot = pendingOrder.pending;
    if (!snapshot) return;
    setConfirmRestore(false);
    setStatus(null);
    setRemoved([]);
    setFieldError(null);
    cart.replace(snapshot.lines);
    setMeta(snapshot.meta);
    send(snapshot.meta, snapshot.lines);
  };

  const restorePending = () => {
    const snapshot = pendingOrder.pending;
    if (!snapshot) return;
    if (cart.lines.length > 0 && !sameOrder(cart.lines, meta, snapshot)) {
      setConfirmRestore(true);
      return;
    }
    restoreNow();
  };

  const parkThenRestore = () => {
    park.mutate(
      { ...inputOfMeta(meta, cart.lines), meta },
      {
        onSuccess: () => {
          cart.clear();
          restoreNow();
        },
        onSettled: pendingPark.refresh,
      },
    );
  };

  const parkOrder = () => {
    setStatus(null);
    setRemoved([]);
    park.mutate(
      { ...inputOfMeta(meta, cart.lines), meta },
      {
        onSuccess: () => {
          cart.clear();
          setStatus({ key: "parkedOk" });
        },
        onSettled: pendingPark.refresh,
      },
    );
  };

  // A park whose answer was lost: sent again with the same key and bytes (the
  // cart on screen is not touched), or closed after the cashier checked.
  const resendPark = () => {
    const snapshot = pendingPark.pending;
    if (!snapshot) return;
    setStatus(null);
    park.mutate(
      { ...inputOfMeta(snapshot.meta, snapshot.lines), meta: snapshot.meta },
      {
        onSuccess: () => {
          // Same cart as the one parked: it is on the held list now, so it
          // leaves the screen. A different cart stays: it is a new order.
          // Read again now: an item added while this was sending must stay.
          if (sameOrder(readDraft(draftKey), meta, snapshot)) cart.clear();
          setStatus({ key: "parkedOk" });
        },
        onSettled: pendingPark.refresh,
      },
    );
  };

  // The order does not exist on the server yet, so "send held items" releases
  // every held line: they go to the kitchen together with the order.
  const releaseHeld = () => {
    setRemoved([]);
    setStatus({ key: "heldReleased", params: { count: totals.heldCount } });
    cart.replace(cart.lines.map((line) => ({ ...line, hold: false })));
  };

  const resumed = (draft: ParkedDraft & { missing?: number }) => {
    // useResumeDraft already added the draft's lines to the cart. The table
    // session may have closed since, so the table is chosen again.
    setMeta((current) => ({
      ...current,
      channel: draft.channel,
      ojolPlatform: draft.ojol?.platform ?? current.ojolPlatform,
      ojolRef: draft.ojol?.externalRef ?? current.ojolRef,
    }));
    setFieldError(null);
    setParkedOpen(false);
    setRemoved([]);
    setStatus(
      draft.missing
        ? { key: "resumedMissing", params: { count: draft.missing } }
        : { key: "resumedOk" },
    );
  };

  const submitCode =
    submit.error instanceof ApiError ? submit.error.code : null;
  // Another cart than the unresolved one: the pending notice explains it.
  const pendingCode = submitCode === ORDER_INTENT_PENDING;
  // The server refused the key for a different body: only the cashier closes it.
  const keyRefused = needsCashierClose(submit.error);
  // A park refused because another cart is unclear: the notice above says it.
  const parkConflict =
    park.error instanceof ApiError && park.error.code === PARK_INTENT_PENDING;
  const forbidden =
    submit.error instanceof ApiError && submit.error.status === 403;

  const describePending = (sent: OrderMeta): string => {
    const channel = t(
      sent.channel === "dine_in"
        ? "posOrderCart.channel.dineIn"
        : sent.channel === "takeaway"
          ? "posOrderCart.channel.takeaway"
          : "posOrderCart.channel.ojol",
    );
    return sent.channel === "dine_in" && sent.tableLabel
      ? `${channel} · ${t("posOrderCart.table.value", { label: sent.tableLabel })}`
      : channel;
  };

  const feedback: ReactNode = (
    <div aria-live="polite" className="grid gap-2 empty:hidden">
      {replay.data && !status && (
        <Notice tone="info" title={t("posOrderCart.status.resumedOk")} />
      )}
      {status && (
        <Notice
          tone="info"
          title={t(`posOrderCart.status.${status.key}`, status.params)}
        />
      )}
      {removed.length > 0 && (
        <Notice tone="info" title={t("posOrderCart.status.lineRemoved")}>
          <Button
            ref={undoRef}
            type="button"
            variant="outline"
            onClick={undoRemove}
          >
            {t("posOrderCart.status.undo")}
          </Button>
        </Notice>
      )}
      {pendingOrder.pending && !submit.isPending && !keyRefused && (
        <Notice tone="warning" title={t("posOrderCart.pending.title")}>
          <div className="grid gap-2">
            <p>
              {t("posOrderCart.pending.body", {
                where: describePending(pendingOrder.pending.meta),
                count: pendingOrder.pending.lines.reduce(
                  (sum, line) => sum + line.quantity,
                  0,
                ),
              })}
            </p>
            {confirmRestore ? (
              <>
                <p className="font-semibold">
                  {t("posOrderCart.pending.replaceBody", {
                    count: totals.itemCount,
                  })}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    loading={park.isPending}
                    onClick={parkThenRestore}
                  >
                    {t("posOrderCart.pending.replaceConfirm")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setConfirmRestore(false)}
                  >
                    {t("posOrderCart.pending.replaceCancel")}
                  </Button>
                </div>
              </>
            ) : (
              <Button type="button" variant="outline" onClick={restorePending}>
                {t("posOrderCart.pending.restore")}
              </Button>
            )}
          </div>
        </Notice>
      )}
      {keyRefused && (
        <Notice
          tone="danger"
          title={t(
            forbidden
              ? "posOrderCart.forbidden.title"
              : "posOrderCart.reused.title",
          )}
        >
          <div className="grid gap-2">
            <p>
              {t(
                forbidden
                  ? "posOrderCart.forbidden.body"
                  : "posOrderCart.reused.body",
              )}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                pendingOrder.close();
                submit.reset();
              }}
            >
              {t("posOrderCart.reused.confirm")}
            </Button>
          </div>
        </Notice>
      )}
      {submit.isError && !pendingCode && !keyRefused && (
        <ActionError
          pending={isContractPending(submit.error)}
          title={t("posOrderCart.error.submitTitle")}
          body={t("posOrderCart.error.submitBody")}
          error={submit.error}
          onRetry={continueOrder}
        />
      )}
      {otherCashierPending && (
        <Notice tone="info" title={t("posOrderCart.otherCashier.title")}>
          {t("posOrderCart.otherCashier.body")}
        </Notice>
      )}
      {pendingPark.pending && !park.isPending && (
        <Notice tone="warning" title={t("posOrderCart.parkPending.title")}>
          <div className="grid gap-2">
            <p>
              {t("posOrderCart.parkPending.body", {
                where: describePending(pendingPark.pending.meta),
                count: pendingPark.pending.lines.reduce(
                  (sum, line) => sum + line.quantity,
                  0,
                ),
              })}
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={resendPark}>
                {t("posOrderCart.parkPending.resend")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={pendingPark.close}
              >
                {t("posOrderCart.parkPending.close")}
              </Button>
            </div>
          </div>
        </Notice>
      )}
      {replay.failures
        .filter((failure) => needsCashierClose(failure.error))
        .map((failure) => (
          <Notice
            key={failure.id}
            tone="danger"
            title={t("posOrderCart.resumeClose.title")}
          >
            <div className="grid gap-2">
              <p>{t("posOrderCart.resumeClose.body")}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  closeResume(failure.id);
                  replay.dismiss(failure.id);
                }}
              >
                {t("posOrderCart.resumeClose.confirm")}
              </Button>
            </div>
          </Notice>
        ))}
      {park.isError && !parkConflict && (
        <ActionError
          pending={isContractPending(park.error)}
          title={t("posOrderCart.error.parkTitle")}
          body={t("posOrderCart.error.parkBody")}
          error={park.error}
          onRetry={parkOrder}
        />
      )}
    </div>
  );

  return (
    <div
      data-density="kontras"
      data-slot="cashier-main-screen"
      className={cn(
        "grid gap-4 min-[701px]:grid-cols-[minmax(0,1fr)_24.375rem] min-[701px]:items-start",
        view === "menu" && "max-[700px]:pb-24",
      )}
    >
      <div
        className={cn(
          "grid min-w-0 content-start gap-4",
          view === "cart" && "max-[700px]:hidden",
        )}
      >
        <PosPageHeading
          title={t("posOrderCart.title")}
          subtitle={t("posOrderCart.subtitle")}
          className="[&_h1]:font-extrabold"
        />
        <CatalogPane onPick={pick} />
      </div>

      <CartPane
        lines={cart.lines}
        meta={meta}
        onMetaChange={changeMeta}
        fieldError={fieldError}
        fieldErrorToken={fieldErrorToken}
        onSetQuantity={setQuantity}
        onToggleHold={cart.toggleHold}
        onPark={parkOrder}
        onFireHeld={releaseHeld}
        onContinue={continueOrder}
        onOpenParked={() => setParkedOpen(true)}
        onBackToMenu={view === "cart" ? () => setView("menu") : undefined}
        feedback={feedback}
        parking={park.isPending}
        submitting={submit.isPending}
        className={cn(
          "min-[701px]:sticky min-[701px]:top-4 min-[701px]:h-[calc(100dvh-10.25rem)] min-[701px]:min-h-128",
          view === "menu" && "max-[700px]:hidden",
        )}
      />

      {view === "menu" && (
        <MobileCartBar
          itemCount={totals.itemCount}
          subtotalIdr={totals.subtotalIdr}
          onOpen={() => setView("cart")}
        />
      )}

      <ModifierDialog
        item={pickedItem}
        open={pickedItem !== null}
        onOpenChange={(open) => {
          if (!open) setPickedItem(null);
        }}
        onConfirm={(selection) => {
          if (park.isPending || submit.isPending) return;
          if (pickedItem) cart.add(pickedItem, selection);
          setPickedItem(null);
        }}
      />
      <ParkedDraftsSheet
        draftKey={draftKey}
        open={parkedOpen}
        onOpenChange={setParkedOpen}
        onResumed={resumed}
      />
    </div>
  );
}

// A failed submit or park: the cart is kept, so the cashier can try again. A
// missing contract is not retryable, so it only explains.
function ActionError({
  pending,
  title,
  body,
  error,
  onRetry,
}: {
  pending: boolean;
  title: string;
  body: string;
  error: unknown;
  onRetry: () => void;
}) {
  const t = useT();
  // The server's own message says what went wrong; the generic body is the
  // fallback when the failure has none (network, unknown).
  const apiError = error instanceof ApiError ? error : null;
  const causes = apiError?.details?.map((detail) => detail.message) ?? [];
  const needsCartFix = apiError ? CART_FIX_CODES.has(apiError.code) : false;
  return (
    <Notice
      tone="danger"
      title={pending ? t("posOrderCart.error.pendingTitle") : title}
    >
      {!pending && (
        <div className="grid gap-2">
          <p>{apiError?.message || body}</p>
          {causes.length > 0 && (
            <ul className="list-disc pl-5">
              {causes.map((cause, index) => (
                <li key={index}>{cause}</li>
              ))}
            </ul>
          )}
          {needsCartFix && <p>{t("posOrderCart.error.submitFixCart")}</p>}
          <Button type="button" variant="outline" onClick={onRetry}>
            {t("posOrderCart.error.retry")}
          </Button>
        </div>
      )}
    </Notice>
  );
}
