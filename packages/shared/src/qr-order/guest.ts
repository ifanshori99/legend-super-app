// Guest-facing read models and endpoints of the QR order journey (beads
// legend-2m4, legend-8sh, legend-woz, legend-tz1; PRD v1.7 §3 "QR Order
// Pelanggan"). The WS-03 contracts (legend-6li, legend-j85) define the write
// side and the staff views; the customer screens also need:
//   - the public menu read model (items with channel price, variants,
//     modifier groups with min/max, labels, allergens, sold-out state);
//   - menu suggestions (AI-01);
//   - a guest-safe view of failed-item issues (no cost, no staff names);
//   - the payment hand-off for a QR order / split share (WS-05 intent, trimmed
//     to what a guest may see);
//   - the per-person point claim (PRD "Klaim Poin per Orang", 24 hours).
// They live here, next to the QR order contract, until the backend beads
// (legend-4jm) ratify them; every price on the wire is computed by the server
// (ORD-03) and excludes tax and service charge (owner rule, menu prices are
// exclusive; the quote adds both at checkout).

import {
  z,
  uuidSchema,
  idrSchema,
  basisPointsSchema,
  isoDateTimeSchema,
  dataResponseSchema,
  clientInputSchema,
  idempotencyKeySchema,
  brandRefSchema,
  outletRefSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { paymentChannelSchema, paymentStatusSchema } from "../payment/index.ts";
import { themeTokensSchema } from "../platform/themes.ts";
import { BRAND_FONTS, CORNER_STYLES } from "../theme/types.ts";
import {
  apologyVoucherIdSchema,
  billSplitIdSchema,
  floorZoneIdSchema,
  orderIdSchema,
  orderIssueIdSchema,
  orderIssueResolutionSchema,
  orderIssueTypeSchema,
  orderItemIdSchema,
  paymentModeSchema,
  sessionBillChargeSchema,
  signedQrTokenSchema,
  tableIdSchema,
  tableSessionIdSchema,
  voucherCodeSchema,
} from "./schemas.ts";

const name = z.string().min(1).max(150);
const nonnegativeIdr = idrSchema.refine((value) => value >= 0);
const positiveIdr = idrSchema.refine((value) => value > 0);

// ---- Public menu read model ------------------------------------------------

/** Labels the menu content form offers (PRD "Konten Menu"). Free text is allowed. */
export const MENU_LABELS = ["baru", "terlaris", "pedas", "vegetarian"] as const;

export const qrMenuModifierSchema = z.strictObject({
  id: uuidSchema,
  name,
  /** Added to the unit price per unit (excludes tax and service charge). */
  priceIdr: nonnegativeIdr,
  soldOut: z.boolean(),
});

export const qrMenuModifierGroupSchema = z
  .strictObject({
    id: uuidSchema,
    name,
    minSelect: z.number().int().nonnegative(),
    maxSelect: z.number().int().positive(),
    modifiers: z.array(qrMenuModifierSchema).min(1),
  })
  .refine(
    (group) =>
      group.minSelect <= group.maxSelect &&
      group.maxSelect <= group.modifiers.length,
    { path: ["maxSelect"], message: "min/max must fit the modifier list" },
  );

export const qrMenuVariantSchema = z.strictObject({
  id: uuidSchema,
  name,
  /** Absolute channel price of this variant. */
  priceIdr: positiveIdr,
});

export const qrMenuItemSchema = z
  .strictObject({
    id: uuidSchema,
    categoryId: uuidSchema,
    name,
    description: z.string().max(500),
    type: z.enum(["single", "combo"]),
    /** Channel price (dine-in), excluding tax and service charge. */
    priceIdr: positiveIdr,
    labels: z.array(name).max(6),
    allergens: z.array(name).max(10),
    /** Media library URL; null until the outlet uploads a photo. */
    photoUrl: z.string().min(1).max(500).nullable(),
    variants: z.array(qrMenuVariantSchema).max(8),
    modifierGroups: z.array(qrMenuModifierGroupSchema).max(8),
    /**
     * `sold_out`: 86, daily limit reached or outside its schedule on another
     * day. `unavailable_until`: outside its schedule now but the next window
     * opens later the same day (`availableFrom`).
     */
    status: z.enum(["available", "sold_out", "unavailable_until"]),
    /** Start of the next sales window; only with `unavailable_until`. */
    availableFrom: isoDateTimeSchema.optional(),
    sortOrder: z.number().int(),
  })
  .superRefine((item, ctx) => {
    if (
      (item.status === "unavailable_until") !==
      (item.availableFrom !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        path: ["availableFrom"],
        message:
          "availableFrom is required with, and only with, unavailable_until",
      });
    if (
      item.variants.length > 0 &&
      Math.min(...item.variants.map((v) => v.priceIdr)) !== item.priceIdr
    )
      ctx.addIssue({
        code: "custom",
        path: ["priceIdr"],
        message: "priceIdr is the lowest variant price when variants exist",
      });
  });
export type QrMenuItem = z.infer<typeof qrMenuItemSchema>;
export type QrMenuModifierGroup = z.infer<typeof qrMenuModifierGroupSchema>;

/**
 * The brand's active Tenant Theme as the guest journey wears it (D43,
 * legend-8qri): token overrides per mode, font, corner style and the logo's
 * public URL (null when the brand has no logo or storage is not configured).
 */
export const qrMenuThemeSchema = z.strictObject({
  tokens: themeTokensSchema,
  fontFamily: z.enum(BRAND_FONTS),
  corners: z.enum(CORNER_STYLES),
  logoUrl: z.string().min(1).max(500).nullable(),
});
export type QrMenuTheme = z.infer<typeof qrMenuThemeSchema>;

export const qrMenuSchema = z
  .strictObject({
    brand: brandRefSchema,
    outlet: outletRefSchema,
    table: z.strictObject({
      id: tableIdSchema,
      code: z.string().min(1).max(20),
      capacity: z.number().int().min(1).max(50),
    }),
    zone: z.strictObject({
      id: floorZoneIdSchema,
      name,
      paymentMode: paymentModeSchema,
      serviceChargeBp: basisPointsSchema,
      minimumSpendIdr: nonnegativeIdr,
    }),
    /**
     * Active Tenant Theme of the brand; null or absent keeps the Base Theme.
     * The outlet time zone for every clock on screen is `outlet.timeZone`.
     */
    theme: qrMenuThemeSchema.nullable().optional(),
    /** False outside the zone's opening hours; the menu stays readable. */
    orderingOpen: z.boolean(),
    pricing: z.strictObject({
      /** Default (owner rule): menu prices exclude tax and service charge.
       * True when the outlet's tax rule for F&B dine-in is price-inclusive. */
      pricesIncludeTaxAndService: z.boolean(),
      /** How the F&B rules treat the price: `pricesIncludeTaxAndService` is
       * true only for `inclusive`; `mixed` (some items inclusive, some not)
       * gets a neutral note. Absent = `exclusive`. */
      taxPriceMode: z.enum(["inclusive", "exclusive", "mixed"]).optional(),
      serviceChargeBp: basisPointsSchema,
      taxes: z.array(z.strictObject({ name, rateBp: basisPointsSchema })),
    }),
    categories: z.array(
      z.strictObject({
        id: uuidSchema,
        name,
        sortOrder: z.number().int(),
      }),
    ),
    items: z.array(qrMenuItemSchema),
    menuUpdatedAt: isoDateTimeSchema,
  })
  .superRefine((menu, ctx) => {
    const categoryIds = new Set(menu.categories.map((category) => category.id));
    for (const item of menu.items)
      if (!categoryIds.has(item.categoryId))
        ctx.addIssue({
          code: "custom",
          path: ["items"],
          message: "Every item must belong to a listed category",
        });
  });
export type QrMenu = z.infer<typeof qrMenuSchema>;

/** Public, read-only: the signed table QR resolves tenant, outlet and zone. */
export const getQrMenu = defineEndpoint({
  method: "GET",
  path: "/api/qr/menu/:qrToken",
  params: z.strictObject({ qrToken: signedQrTokenSchema }),
  response: dataResponseSchema(qrMenuSchema),
});

// ---- Suggestions (AI-01) ----------------------------------------------------

export const menuSuggestionSchema = z.strictObject({
  menuItemId: uuidSchema,
  /** pairing: goes with what is in the cart; upgrade: a richer option. */
  kind: z.enum(["pairing", "upgrade"]),
  basedOnMenuItemId: uuidSchema.nullable(),
});
export type MenuSuggestion = z.infer<typeof menuSuggestionSchema>;

/**
 * Rules (margin, stock, hours) are applied by the server; the guest sees only
 * items that can be ordered now (PRD AI-01).
 */
export const getMenuSuggestions = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/suggestions",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  query: z.strictObject({ menuItemId: uuidSchema.optional() }),
  response: dataResponseSchema(z.array(menuSuggestionSchema).max(6)),
});

// ---- Failed item recovery, guest view (ORD-08) ------------------------------

export const guestSwapOptionSchema = z.strictObject({
  menuItemId: uuidSchema,
  name,
  priceIdr: positiveIdr,
  /** Positive: the guest pays the difference; negative: credited (server). */
  differenceIdr: idrSchema,
});

export const guestOrderIssueSchema = z.strictObject({
  id: orderIssueIdSchema,
  orderId: orderIdSchema,
  orderItemId: orderItemIdSchema,
  itemName: name,
  quantity: z.number().int().min(1).max(99),
  lineTotalIdr: positiveIdr,
  type: orderIssueTypeSchema,
  status: z.enum(["open", "resolved", "cancelled"]),
  /** ORD-08: the guest only ever chooses swap or voucher credit. */
  options: z.strictObject({
    swap: z.strictObject({
      allowed: z.boolean(),
      items: z.array(guestSwapOptionSchema),
    }),
    voucher: z.strictObject({ allowed: z.boolean(), valueIdr: nonnegativeIdr }),
  }),
  resolution: orderIssueResolutionSchema.nullable(),
  replacementItemName: name.nullable(),
  priceDifferenceIdr: idrSchema.nullable(),
  voucher: z
    .strictObject({
      id: apologyVoucherIdSchema,
      code: voucherCodeSchema,
      valueIdr: positiveIdr,
      expiresAt: isoDateTimeSchema,
    })
    .nullable(),
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
});
export type GuestOrderIssue = z.infer<typeof guestOrderIssueSchema>;

export const listSessionOrderIssues = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/order-issues",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  response: dataResponseSchema(z.array(guestOrderIssueSchema)),
});

// ---- Payment hand-off (WS-05) -----------------------------------------------

/**
 * Online methods of the QR guest: QRIS and VA, plus Duitku e-wallet and card
 * (legend-kt3t1). Which of them a tenant offers comes from its gateway's
 * `methods()`, read by `getGuestPaymentOptions`, never from this list alone.
 */
export const GUEST_PAYMENT_METHODS = ["qris", "va", "ewallet", "card"] as const;
export const guestPaymentMethodSchema = z.enum(GUEST_PAYMENT_METHODS);
export type GuestPaymentMethod = z.infer<typeof guestPaymentMethodSchema>;

export const guestPaymentIntentIdSchema = uuidSchema;

/** Provider channel code for VA or e-wallet, one of `getGuestPaymentOptions` banks. */
export const guestPaymentBankCodeSchema = z.string().min(1).max(40);

/** What the guest pays: one order (pay-first), a split share, or the open bill. */
export const guestPaymentTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("order"), orderId: orderIdSchema }),
  z.strictObject({ kind: z.literal("split"), billSplitId: billSplitIdSchema }),
  z.strictObject({ kind: z.literal("bill") }),
  /** The dearer-swap difference of a failed item (legend-i83ls). */
  z.strictObject({ kind: z.literal("issue_charge"), chargeId: uuidSchema }),
]);
export type GuestPaymentTarget = z.infer<typeof guestPaymentTargetSchema>;

/** A VA or e-wallet names a channel; QRIS and card take none. */
function requireBankForChannelMethods(
  input: { method: GuestPaymentMethod; bankCode?: string | null },
  ctx: z.RefinementCtx,
): void {
  const hasBank = input.bankCode !== undefined && input.bankCode !== null;
  const needsChannel = input.method === "va" || input.method === "ewallet";
  if (needsChannel !== hasBank)
    ctx.addIssue({
      code: "custom",
      path: ["bankCode"],
      message: needsChannel
        ? "Choose a bank or e-wallet for this method"
        : "QRIS and card do not take a channel",
    });
}

/**
 * legend-r77pq: the payer's own proof for one split part. The paying client
 * makes it (32 random bytes, `ps_` + base64url), keeps it, and sends it on
 * `createGuestPayment` and `getSplitClaim`; the server stores only its SHA-256.
 * The part ids and intent ids are visible to the whole table, this is not.
 */
export const payerSecretSchema = z.string().regex(/^ps_[A-Za-z0-9_-]{43}$/);

export const createGuestPaymentInputSchema = clientInputSchema({
  target: guestPaymentTargetSchema,
  method: guestPaymentMethodSchema,
  /** Required for `va` and `ewallet` (validated against the provider list); none for QRIS and card. */
  bankCode: guestPaymentBankCodeSchema.nullable().optional(),
  /** Required for a `split` target; ignored by `order`. */
  payerSecret: payerSecretSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
  /** The total (bill + fee) the guest saw; required for a method with a guest fee, else may be left out (409 FEE_CHANGED when the price is now different). */
  expectedChargedIdr: positiveIdr.optional(),
}).superRefine((input, ctx) => {
  if (input.target.kind === "split" && input.payerSecret === undefined)
    ctx.addIssue({
      code: "custom",
      path: ["payerSecret"],
      message: "A split part is paid with the payer's secret",
    });
  requireBankForChannelMethods(input, ctx);
});

/** ORD-02: `paid` arrives from the verified gateway webhook, never the client. */
export const guestPaymentSchema = z
  .strictObject({
    id: guestPaymentIntentIdSchema,
    target: guestPaymentTargetSchema,
    method: guestPaymentMethodSchema,
    /** The bill part (what the order is paid with). */
    amountIdr: positiveIdr,
    /** 1272 K1: guest service fee on top of the bill, never refunded. */
    guestFeeIdr: nonnegativeIdr,
    /** What the guest pays the gateway: amountIdr + guestFeeIdr. */
    chargedIdr: positiveIdr,
    status: paymentStatusSchema,
    /** QRIS payload to render as a QR code (method qris). */
    qrisPayload: z.string().min(1).max(2000).nullable(),
    /** Hosted payment page the guest is sent to (methods ewallet and card, only while the payment is pending). */
    redirectUrl: z.string().min(1).max(2000).nullable(),
    /** Virtual account number the guest transfers to (method va). */
    vaNumber: z
      .string()
      .regex(/^\d{8,20}$/)
      .nullable(),
    /** Bank of the virtual account or e-wallet channel (methods va, ewallet). */
    bankCode: guestPaymentBankCodeSchema.nullable(),
    bankName: z.string().min(1).max(60).nullable(),
    expiresAt: isoDateTimeSchema,
    paidAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((payment, ctx) => {
    if (payment.chargedIdr !== payment.amountIdr + payment.guestFeeIdr)
      ctx.addIssue({
        code: "custom",
        path: ["chargedIdr"],
        message: "The charged amount must be the bill plus the guest fee",
      });
    if ((payment.status === "paid") !== (payment.paidAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["paidAt"],
        message: "paidAt must be set exactly when paid",
      });
    const va = payment.method === "va";
    const channel = va || payment.method === "ewallet";
    const redirect = payment.method === "ewallet" || payment.method === "card";
    if (va !== (payment.vaNumber !== null))
      ctx.addIssue({
        code: "custom",
        path: ["vaNumber"],
        message: va
          ? "A virtual account payment carries its number"
          : "Only a virtual account payment carries a VA number",
      });
    for (const key of ["bankCode", "bankName"] as const)
      if (channel !== (payment[key] !== null))
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: channel
            ? "A virtual account or e-wallet payment carries its channel"
            : "Only a virtual account or e-wallet payment carries a channel",
        });
    // legend-kt3t1: a voided, expired or failed code must not expose its pay
    // link, so the page is carried only while the payment is pending.
    const carriesRedirect = redirect && payment.status === "pending";
    if (carriesRedirect !== (payment.redirectUrl !== null))
      ctx.addIssue({
        code: "custom",
        path: ["redirectUrl"],
        message: carriesRedirect
          ? "A pending e-wallet or card payment carries its payment page"
          : "Only a pending e-wallet or card payment carries a payment page",
      });
  });
export type GuestPayment = z.infer<typeof guestPaymentSchema>;

export const createGuestPayment = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/payments",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  body: createGuestPaymentInputSchema,
  response: dataResponseSchema(guestPaymentSchema),
});

/**
 * legend-i83ls: the guest pays the swap difference of one charge. The charge
 * is in the path, so the body has no target.
 */
export const createIssueChargePaymentInputSchema = clientInputSchema({
  // legend-kt3t1: a swap difference is paid with QRIS or a VA only; an
  // e-wallet or card is refused at validation.
  method: z.enum(["qris", "va"]),
  bankCode: guestPaymentBankCodeSchema.nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
  /** The total (bill + fee) the guest saw; required for a VA with a guest fee (409 FEE_CHANGED), QRIS carries none. */
  expectedChargedIdr: positiveIdr.optional(),
}).superRefine(requireBankForChannelMethods);

export const listSessionIssueCharges = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/issue-charges",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  response: dataResponseSchema(z.array(sessionBillChargeSchema)),
});

export const createIssueChargePayment = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/issue-charges/:chargeId/payments",
  params: z.strictObject({
    sessionId: tableSessionIdSchema,
    chargeId: uuidSchema,
  }),
  body: createIssueChargePaymentInputSchema,
  response: dataResponseSchema(guestPaymentSchema),
});

/** 1272 K1: a guest fee and its charged total are both set or both null. */
function requireFeePair(
  value: { guestFeeIdr: number | null; chargedIdr: number | null },
  ctx: z.RefinementCtx,
): void {
  if ((value.guestFeeIdr === null) !== (value.chargedIdr === null))
    ctx.addIssue({
      code: "custom",
      path: ["chargedIdr"],
      message: "A guest fee and its charged total go together",
    });
  else if (
    value.guestFeeIdr !== null &&
    value.chargedIdr !== null &&
    value.chargedIdr < value.guestFeeIdr
  )
    ctx.addIssue({
      code: "custom",
      path: ["chargedIdr"],
      message: "The charged total includes the guest fee",
    });
}

/**
 * 1272 K1: one bank or e-wallet of a method, priced for the bill the guest
 * named (`guestFeeIdr` on top, `chargedIdr` what the gateway charges). Both
 * null when the request names no target.
 */
export const guestPaymentOptionBankSchema = paymentChannelSchema
  .extend({
    guestFeeIdr: nonnegativeIdr.nullable(),
    chargedIdr: nonnegativeIdr.nullable(),
  })
  .superRefine(requireFeePair);
export type GuestPaymentOptionBank = z.infer<
  typeof guestPaymentOptionBankSchema
>;

/**
 * One online method on the guest pay screen. The bank list comes from the
 * provider's channel endpoint, never hard-coded (PRD §3.13 "Metode DOIT").
 */
export const guestPaymentOptionSchema = z
  .strictObject({
    method: guestPaymentMethodSchema,
    enabled: z.boolean(),
    /** `no_channels`: gateway up and routing on, but the gateway lists no channel or method. */
    unavailableReason: z
      .enum(["gateway_down", "routing_disabled", "no_channels"])
      .nullable(),
    /** Banks for `va`, e-wallets for `ewallet`; empty for `qris` and `card`.
     * 1272 K1: each priced when the request names a target. */
    banks: z.array(guestPaymentOptionBankSchema),
    /** 1272 K1: fee and charged total of a method without banks (`qris`,
     * `card`) for the named target; null without a target, for a method
     * with banks (priced per bank), and for a disabled method. */
    guestFeeIdr: nonnegativeIdr.nullable(),
    chargedIdr: nonnegativeIdr.nullable(),
  })
  .superRefine((option, ctx) => {
    if (option.enabled === (option.unavailableReason !== null))
      ctx.addIssue({
        code: "custom",
        path: ["unavailableReason"],
        message: "A disabled method must say why; an enabled one must not",
      });
    requireFeePair(option, ctx);
  });
export type GuestPaymentOption = z.infer<typeof guestPaymentOptionSchema>;
export const guestPaymentOptionsSchema = z.strictObject({
  methods: z.array(guestPaymentOptionSchema),
});
export type GuestPaymentOptions = z.infer<typeof guestPaymentOptionsSchema>;

/**
 * 1272 K1: the bill the options are priced for, the same order or split part
 * the create call names. Never an amount: the server reads the bill itself.
 * Neither key: the options carry no fees (null).
 */
export const guestPaymentOptionsQuerySchema = z
  .strictObject({
    orderId: orderIdSchema.optional(),
    billSplitId: billSplitIdSchema.optional(),
  })
  .refine(
    (query) => query.orderId === undefined || query.billSplitId === undefined,
    { message: "Name one order or one split part, not both" },
  );
export type GuestPaymentOptionsQuery = z.infer<
  typeof guestPaymentOptionsQuerySchema
>;

export const getGuestPaymentOptions = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/payment-options",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  query: guestPaymentOptionsQuerySchema,
  response: dataResponseSchema(guestPaymentOptionsSchema),
});

export const getGuestPayment = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/payments/:paymentId",
  params: z.strictObject({
    sessionId: tableSessionIdSchema,
    paymentId: guestPaymentIntentIdSchema,
  }),
  response: dataResponseSchema(guestPaymentSchema),
});

// ---- Split part claim (legend-ms3) -------------------------------------------

/**
 * The claim token of a paid split part: whoever holds it can attach the part to
 * their account later (redeem route waits on legend-111j). 24 hours after the
 * part is paid.
 */
export const splitClaimSchema = z
  .strictObject({
    billSplitId: billSplitIdSchema,
    status: z.enum(["unavailable", "available", "claimed", "expired"]),
    claimToken: z.string().min(1).nullable(),
    claimableUntil: isoDateTimeSchema.nullable(),
  })
  .superRefine((claim, ctx) => {
    if (claim.status === "available" && claim.claimToken === null)
      ctx.addIssue({
        code: "custom",
        path: ["claimToken"],
        message: "An available claim carries its token",
      });
    if (claim.status === "available" && claim.claimableUntil === null)
      ctx.addIssue({
        code: "custom",
        path: ["claimableUntil"],
        message: "An available claim has a deadline",
      });
  });
export type SplitClaim = z.infer<typeof splitClaimSchema>;

export const getSplitClaim = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/splits/:splitId/claim",
  params: z.strictObject({
    sessionId: tableSessionIdSchema,
    splitId: billSplitIdSchema,
  }),
  // Proof that the part is the guest's: the payer secret given when paying it
  // (legend-r77pq). A body, not a query, so it never lands in a URL log. Wrong,
  // unknown or not-the-payer's: the same 404.
  body: z.strictObject({ payerSecret: payerSecretSchema }),
  response: dataResponseSchema(splitClaimSchema),
});

/**
 * legend-ia54l: open the claim code with the claim token alone (header
 * `Authorization: Bearer <claimToken>`), up to `claimableUntil`, also after the
 * table session is closed. Unknown, used, expired or voided: 404.
 */
export const getSplitClaimByToken = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/split-claims/current",
  response: dataResponseSchema(splitClaimSchema),
});

// ---- Order ETA (PRD "Status Pesanan ... dengan estimasi waktu") -----------------

export const orderEtaSchema = z
  .strictObject({
    orderId: orderIdSchema,
    minMinutes: z.number().int().nonnegative(),
    maxMinutes: z.number().int().nonnegative(),
    estimatedReadyAt: isoDateTimeSchema,
  })
  .refine((eta) => eta.minMinutes <= eta.maxMinutes, {
    path: ["maxMinutes"],
    message: "minMinutes must not exceed maxMinutes",
  });
export type OrderEta = z.infer<typeof orderEtaSchema>;

/** From WS-04 order pacing; only orders that are not fully served appear. */
export const getOrderEtas = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/order-etas",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  response: dataResponseSchema(z.array(orderEtaSchema)),
});

// ---- Point claim (PRD "Klaim Poin per Orang") --------------------------------

export const pointClaimSchema = z
  .strictObject({
    sessionId: tableSessionIdSchema,
    status: z.enum(["unavailable", "available", "claimed", "expired"]),
    /** What this guest paid in the session. */
    paidIdr: nonnegativeIdr,
    /** Computed by the loyalty program rules on the server. */
    points: z.number().int().nonnegative(),
    /** 24 hours after the bill is settled (PRD). */
    claimableUntil: isoDateTimeSchema.nullable(),
    /** True for an anonymous guest: sign in to claim. */
    requiresLogin: z.boolean(),
  })
  .superRefine((claim, ctx) => {
    if (claim.status === "available" && claim.claimableUntil === null)
      ctx.addIssue({
        code: "custom",
        path: ["claimableUntil"],
        message: "An available claim has a deadline",
      });
  });
export type PointClaim = z.infer<typeof pointClaimSchema>;

/**
 * Optional proof of one split part (`sc_...`, the token shown by
 * `getSplitClaim`). Without it the claim covers the session's whole-bill
 * (unsplit) paid orders; a split part is only claimed with its own token.
 */
export const pointClaimTokenSchema = z.string().regex(/^sc_[A-Za-z0-9_-]{43}$/);

export const getPointClaim = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/points-claim",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  query: z.strictObject({ claimToken: pointClaimTokenSchema.optional() }),
  response: dataResponseSchema(pointClaimSchema),
});

export const claimSessionPoints = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/points-claim",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  body: clientInputSchema({
    idempotencyKey: idempotencyKeySchema,
    claimToken: pointClaimTokenSchema.optional(),
  }),
  response: dataResponseSchema(pointClaimSchema),
});
