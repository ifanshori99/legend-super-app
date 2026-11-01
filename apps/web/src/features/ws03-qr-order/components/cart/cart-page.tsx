// Shared cart (PRD §3 F10 "Menu & Keranjang": keranjang bersama yang terlihat
// oleh semua tamu). Server state: every change carries the cart version it
// read, a stale one conflicts and reloads (ORD-03 keeps prices on the server).
import { Link, useNavigate } from "@tanstack/react-router";
import { ShoppingBasket } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useTableJourney } from "../../context";
import { useChangeCartLine, useRemoveCartLine } from "../../hooks";
import { Notice } from "../notice";
import { SessionEnded } from "../session-states";
import { SuggestionsShelf } from "../suggestions-shelf";
import { CartLineRow } from "./cart-line-row";

export function CartPage() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const {
    qrToken,
    menu,
    sessionId,
    guest,
    view,
    viewError,
    participantId,
    ended,
    openJoin,
  } = useTableJourney();
  const change = useChangeCartLine(sessionId ?? "none");
  const remove = useRemoveCartLine(sessionId ?? "none");
  const busy = change.isPending || remove.isPending;
  const failure = change.error ?? remove.error;

  if (ended) return <SessionEnded />;
  if (!guest)
    return (
      <EmptyState
        icon={ShoppingBasket}
        title={t("qrCart.cart.noSessionTitle")}
        description={t("qrCart.cart.noSessionHint")}
        action={
          <Button type="button" onClick={() => openJoin()}>
            {t("qrCart.cart.noSessionAction")}
          </Button>
        }
      />
    );
  if (viewError)
    return (
      <ErrorState
        title={t("qrCart.cart.errorTitle")}
        description={t("qrCart.cart.errorHint")}
        onRetry={() => window.location.reload()}
      />
    );
  if (!view)
    return (
      <div aria-busy="true" className="grid gap-3">
        <span className="sr-only">{t("qrCart.cart.loading")}</span>
        <Skeleton className="h-9 w-1/2" />
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-28 w-full rounded-2xl" />
        ))}
      </div>
    );

  const lines = view.cart.lines;
  const soldOutIds = new Set(
    (menu?.items ?? [])
      .filter((item) => item.status === "sold_out")
      .map((item) => item.id),
  );
  const subtotal = lines
    .filter((line) => !soldOutIds.has(line.menuItemId))
    .reduce((sum, line) => sum + line.lineTotalIdr, 0);
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const version = view.cart.version;

  const onError = (error: unknown) =>
    toast({
      title:
        error instanceof ApiError && error.status === 409
          ? t("qrCart.cart.conflict")
          : t("qrCart.cart.updateError"),
      tone: "danger",
    });

  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-3xl leading-9 font-bold tracking-tight">
          {t("qrCart.cart.title")}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("qrCart.cart.sharedHint")}
        </p>
      </header>

      {failure && !busy && (
        <Notice
          tone="warning"
          title={
            failure instanceof ApiError && failure.status === 409
              ? t("qrCart.cart.conflict")
              : t("qrCart.cart.updateError")
          }
        />
      )}

      {lines.length === 0 ? (
        <EmptyState
          icon={ShoppingBasket}
          title={t("qrCart.cart.emptyTitle")}
          description={t("qrCart.cart.emptyHint")}
          action={
            <Button asChild>
              <Link to="/t/$token" params={{ token: qrToken }}>
                {t("qrCart.cart.toMenu")}
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          <ul className="grid gap-3">
            {lines.map((line) => (
              <CartLineRow
                key={line.id}
                line={line}
                soldOut={soldOutIds.has(line.menuItemId)}
                mine={
                  line.addedByParticipantId === null || participantId === null
                    ? null
                    : line.addedByParticipantId === participantId
                }
                busy={busy}
                onQuantity={(quantity) =>
                  change.mutate(
                    {
                      lineId: line.id,
                      cartVersion: version,
                      patch: { quantity },
                    },
                    { onError },
                  )
                }
                onRemove={() =>
                  remove.mutate(
                    { lineId: line.id, cartVersion: version },
                    {
                      onError,
                      onSuccess: () =>
                        toast({
                          title: t("qrCart.cart.removed", { name: line.name }),
                          tone: "info",
                        }),
                    },
                  )
                }
              />
            ))}
          </ul>

          {menu && sessionId && (
            <SuggestionsShelf
              sessionId={sessionId}
              menu={menu}
              title={t("qrCart.cart.suggestionsTitle")}
              onPick={(itemId) =>
                void navigate({
                  to: "/t/$token",
                  params: { token: qrToken },
                  search: { item: itemId },
                })
              }
            />
          )}

          <div className="sticky bottom-0 z-10 -mx-gutter grid gap-2 border-t bg-background px-gutter py-3">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <p className="font-semibold">{t("qrCart.cart.subtotal")}</p>
                <p className="text-sm text-muted-foreground">
                  {t("qrCart.cart.itemCount", { count })} ·{" "}
                  {t("qrCart.cart.subtotalHint")}
                </p>
              </div>
              <Money amount={subtotal} size="lg" />
            </div>
            <Button asChild size="lg" className="w-full">
              <Link to="/t/$token/checkout" params={{ token: qrToken }}>
                {t("qrCart.cart.checkout")}
              </Link>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
