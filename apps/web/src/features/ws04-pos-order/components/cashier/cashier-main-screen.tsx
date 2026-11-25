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
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { ModifierDialog } from "@/features/ws04-pos-order/components/modifier-dialog";
import { Button } from "@/components/ui/button";
import {
  Notice,
  PosPageHeading,
} from "@/features/ws04-pos-kasir/components/shared";
import { cartTotals, needsChoice } from "@/features/ws04-pos-order/cart-logic";
import { useDraftCart } from "@/features/ws04-pos-order/draft-store";
import {
  isContractPending,
  useParkDraft,
  useSubmitOrder,
} from "@/features/ws04-pos-order/hooks";
import type {
  CartLine,
  MenuItem,
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
  const cart = useDraftCart("kasir");
  const access = (useRouteContext({ strict: false }) as { access?: AreaAccess })
    .access;
  const canAcceptPayment = access
    ? holdsAny(access, ["pos.payment.accept"])
    : false;
  const submit = useSubmitOrder({ draftKey: "kasir" });
  const park = useParkDraft();

  const [meta, setMeta] = useState<CartOrderMeta>({
    channel: "dine_in",
    tableLabel: null,
    tableSessionId: null,
    ojolPlatform: null,
    ojolRef: "",
  });
  // The phone view lives in the URL (`?v=keranjang`), so Back returns to the menu.
  const { v } = useSearch({ from: "/_ops/pos/kasir" });
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
  const [parkedOpen, setParkedOpen] = useState(false);
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
    if (item.soldOut) return;
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
    submit.mutate(
      {
        channel,
        tableSessionId: channel === "dine_in" ? tableSessionId : null,
        ojol:
          channel === "ojol_manual" && ojolPlatform
            ? { platform: ojolPlatform, externalRef: ojolRef.trim() }
            : null,
        lines: cart.lines,
      },
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
      },
    );
  };

  const parkOrder = () => {
    setStatus(null);
    setRemoved([]);
    park.mutate(
      {
        channel: meta.channel,
        tableSessionId: meta.channel === "dine_in" ? meta.tableSessionId : null,
        ojol:
          meta.channel === "ojol_manual" &&
          meta.ojolPlatform &&
          meta.ojolRef.trim() !== ""
            ? { platform: meta.ojolPlatform, externalRef: meta.ojolRef.trim() }
            : null,
        lines: cart.lines,
      },
      {
        onSuccess: () => {
          cart.clear();
          setStatus({ key: "parkedOk" });
        },
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

  const feedback: ReactNode = (
    <div aria-live="polite" className="grid gap-2 empty:hidden">
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
      {submit.isError && (
        <ActionError
          pending={isContractPending(submit.error)}
          title={t("posOrderCart.error.submitTitle")}
          body={t("posOrderCart.error.submitBody")}
          error={submit.error}
          onRetry={continueOrder}
        />
      )}
      {park.isError && (
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
          if (pickedItem) cart.add(pickedItem, selection);
          setPickedItem(null);
        }}
      />
      <ParkedDraftsSheet
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
