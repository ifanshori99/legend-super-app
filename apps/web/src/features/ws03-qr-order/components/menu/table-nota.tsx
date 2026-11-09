// Desktop table nota (legend-2re1, mockup final-a-menu-desktop): the shared
// cart as a coffee glass panel over one of the outlet's own menu photos.
// Glass is only the panel's backdrop layer; line items, the companion card and
// the rust button sit on solid surfaces (rust never directly on coffee: a paper
// ring lands it). Hidden below lg, where the cart bar takes over.
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, ShoppingBag } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { MediaPlate } from "@/components/ui/media-plate";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useTableJourney } from "../../context";
import { useChangeCartLine, useRemoveCartLine } from "../../hooks";
import { CompanionOffer, useCompanion } from "../glass/companion-offer";
import { QrStepper, qrTextLink } from "../glass/qr-primitives";

export function TableNota({
  onOpenItem,
}: {
  onOpenItem: (itemId: string) => void;
}) {
  const t = useT();
  const toast = useToast();
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
  const lines = view?.cart.lines ?? [];
  const companion = useCompanion(lines[0]?.menuItemId);
  if (ended) return null;

  const soldOutIds = new Set(
    (menu?.items ?? [])
      .filter((item) => item.status !== "available")
      .map((item) => item.id),
  );
  const subtotal = lines
    .filter((line) => !soldOutIds.has(line.menuItemId))
    .reduce((sum, line) => sum + line.lineTotalIdr, 0);
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const contextItem = menu?.items.find(
    (item) => item.id === lines[0]?.menuItemId,
  );
  const category = menu?.categories
    .find((entry) => entry.id === contextItem?.categoryId)
    ?.name.toLowerCase();
  // One fixed photo (same as the frame band), so a dark item photo never
  // turns the glass into a black box as the cart changes.
  const backdrop = menu?.items.find((item) => item.photoUrl)?.photoUrl ?? null;

  const onError = (error: unknown) =>
    toast({
      title:
        error instanceof ApiError && error.status === 409
          ? t("qrCart.cart.conflict")
          : t("qrCart.cart.updateError"),
      tone: "danger",
    });

  const mode = menu?.zone.paymentMode ?? view?.session.paymentMode;
  const modeNote =
    mode === "pay_first"
      ? t("qrGlass.cart.nota.payFirstNote")
      : mode === "open_bill"
        ? t("qrGlass.cart.nota.openBillNote", {
            mode: t("qrMenu.mode.openBill"),
            hint: t("qrMenu.mode.openBillHint"),
          })
        : null;

  const state = (title: string, hint: string, action?: ReactNode) => (
    <div className="grid justify-items-start gap-2 rounded-qr-media bg-qr-coffee-panel p-4">
      <p className="font-semibold">{title}</p>
      <p className="text-sm leading-5 text-qr-on-dark-muted">{hint}</p>
      {action}
    </div>
  );

  let body: ReactNode;
  if (!guest) {
    body = state(
      t("qrGlass.cart.nota.noSessionTitle"),
      t("qrCart.cart.noSessionHint"),
      <div className="rounded-qr-cta bg-card p-1">
        <Button type="button" onClick={() => openJoin()}>
          {t("qrGlass.cart.nota.noSessionAction")}
        </Button>
      </div>,
    );
  } else if (viewError) {
    body = state(
      t("qrGlass.cart.nota.errorTitle"),
      t("qrGlass.cart.nota.errorHint"),
    );
  } else if (!view) {
    body = (
      <div aria-busy="true" className="grid gap-3">
        <span className="sr-only">{t("qrGlass.cart.nota.loading")}</span>
        <div className="flex gap-3 rounded-qr-media bg-qr-coffee-panel p-3">
          <Skeleton className="size-14 shrink-0 rounded-lg bg-qr-coffee-control" />
          <div className="grid flex-1 content-start gap-2">
            <Skeleton className="h-5 w-2/3 bg-qr-coffee-control" />
            <Skeleton className="h-4 w-1/2 bg-qr-coffee-control" />
          </div>
        </div>
        <Skeleton className="h-8 w-1/2 bg-qr-coffee-panel" />
        <Skeleton className="h-14 w-full rounded-qr-cta bg-qr-coffee-panel" />
      </div>
    );
  } else if (lines.length === 0) {
    body = state(
      t("qrGlass.cart.nota.emptyTitle"),
      t("qrGlass.cart.nota.emptyHint"),
    );
  } else {
    const version = view.cart.version;
    const removeLine = (lineId: string, name: string) =>
      remove.mutate(
        { lineId, cartVersion: version },
        {
          onError,
          onSuccess: () =>
            toast({
              title: t("qrCart.cart.removed", { name }),
              tone: "info",
            }),
        },
      );
    body = (
      <>
        <ul className="grid max-h-[40vh] gap-2 overflow-y-auto">
          {lines.map((line) => {
            const soldOut = soldOutIds.has(line.menuItemId);
            const mine =
              line.addedByParticipantId === null || participantId === null
                ? null
                : line.addedByParticipantId === participantId;
            const summary = [
              line.modifiers.map((modifier) => modifier.name).join(", "),
              mine === null
                ? ""
                : mine
                  ? t("qrCart.cart.addedBy.you")
                  : t("qrCart.cart.addedBy.other"),
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <li
                key={line.id}
                className="grid gap-2 rounded-qr-media bg-qr-coffee-panel p-3"
              >
                <div className="flex gap-3">
                  <MediaPlate
                    src={
                      menu?.items.find((item) => item.id === line.menuItemId)
                        ?.photoUrl ?? null
                    }
                    alt=""
                    muted={soldOut}
                    className="size-14 shrink-0"
                  />
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <p className="leading-5 font-semibold">{line.name}</p>
                    {summary && (
                      <p className="line-clamp-2 text-xs leading-4 text-qr-on-dark-muted">
                        {summary}
                      </p>
                    )}
                    {soldOut ? (
                      <p className="text-sm leading-5 font-semibold">
                        {t("qrGlass.cart.nota.soldOut")}
                      </p>
                    ) : (
                      <Money
                        amount={line.lineTotalIdr}
                        className="leading-5 font-semibold"
                      />
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Link
                    to="/t/$token/cart"
                    params={{ token: qrToken }}
                    className={qrTextLink}
                  >
                    {t("qrGlass.cart.nota.openCart")}
                    <span className="sr-only">
                      {t("qrGlass.cart.nota.openCartAria", {
                        name: line.name,
                      })}
                    </span>
                  </Link>
                  {soldOut ? (
                    <button
                      type="button"
                      disabled={busy}
                      className={qrTextLink}
                      onClick={() => removeLine(line.id, line.name)}
                    >
                      {t("qrCart.cart.remove")}
                      <span className="sr-only">
                        {t("qrCart.cart.removeAria", { name: line.name })}
                      </span>
                    </button>
                  ) : (
                    <QrStepper
                      tone="dark"
                      value={line.quantity}
                      min={0}
                      max={99}
                      busy={busy}
                      onChange={(quantity) =>
                        quantity === 0
                          ? removeLine(line.id, line.name)
                          : change.mutate(
                              {
                                lineId: line.id,
                                cartVersion: version,
                                patch: { quantity },
                              },
                              { onError },
                            )
                      }
                      decreaseLabel={t("qrCart.cart.decrease", {
                        name: line.name,
                      })}
                      increaseLabel={t("qrCart.cart.increase", {
                        name: line.name,
                      })}
                      valueLabel={`${line.name} ${line.quantity}`}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {companion && category ? (
          <CompanionOffer
            item={companion}
            onOpenItem={onOpenItem}
            tone="nota"
            eyebrow={t("qrGlass.cart.nota.companionEyebrow", { category })}
          />
        ) : null}

        <div className="grid gap-3 border-t border-qr-on-dark-muted/30 pt-3">
          <div className="flex items-end justify-between gap-3">
            <div className="grid">
              <p className="leading-5">{t("qrGlass.cart.nota.subtotal")}</p>
              <p className="leading-5">
                {t("qrGlass.cart.nota.itemCount", { count })}
              </p>
            </div>
            <Money
              amount={subtotal}
              size="xl"
              className="text-3xl leading-9 font-bold"
            />
          </div>
          <p className="text-sm leading-5 text-qr-on-dark-muted">
            {t(
              menu?.pricing.taxPriceMode === "mixed"
                ? "qrGlass.cart.nota.taxNoteMixed"
                : menu?.pricing.pricesIncludeTaxAndService
                  ? "qrGlass.cart.nota.taxNoteInclusive"
                  : "qrGlass.cart.nota.taxNote",
            )}
          </p>
          <div className="rounded-qr-cta bg-card p-1">
            <Button asChild size="lg" className="w-full justify-between">
              <Link to="/t/$token/cart" params={{ token: qrToken }}>
                {t("qrGlass.cart.nota.open")}
                <ChevronRight aria-hidden="true" />
              </Link>
            </Button>
          </div>
          {modeNote ? (
            <p className="text-sm leading-5 text-qr-on-dark-muted">
              {modeNote}
            </p>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <aside
      aria-label={t("qrGlass.cart.nota.title")}
      className="relative hidden overflow-hidden rounded-qr-float bg-surface-2 p-5 lg:block"
    >
      {backdrop ? (
        <img
          src={backdrop}
          alt=""
          aria-hidden="true"
          decoding="async"
          loading="lazy"
          className="pointer-events-none absolute inset-0 size-full object-cover"
        />
      ) : null}
      <div className="relative overflow-hidden rounded-qr-float">
        <div
          aria-hidden="true"
          className="qr-glass-dark absolute inset-0 rounded-qr-float"
        />
        <div className="relative grid gap-4 p-5 text-qr-on-dark">
          <header className="flex items-start justify-between gap-3">
            <div className="grid gap-0.5">
              <h2 className="text-2xl leading-8 font-bold tracking-tight">
                {t("qrGlass.cart.nota.title")}
              </h2>
              <p className="text-qr-on-dark-muted">
                {t("qrGlass.cart.nota.subtitle", {
                  table: menu?.table.code ?? "",
                })}
              </p>
            </div>
            <ShoppingBag aria-hidden="true" className="mt-1 size-6 shrink-0" />
          </header>
          {body}
        </div>
      </div>
    </aside>
  );
}
