// Public brand website home (WS-08 F21, contract `getPublicSite`) and the staff
// editor behind it (`getBrandWebsiteContent` / `saveBrandWebsiteContent`).
//
// The tenant (and the brand pinned to it) come from the request host
// (TEN-08, D-CORE-3). The home payload is assembled from the brand and outlet
// rows plus the staff-written `brand_websites.content`, then parsed with
// `publicSiteSchema` so nothing outside the contract can leave. The brand name
// is the tenant's own `brands` row: no platform name appears here.
//
// Promotions: promo rules hold internal text (code-gated vouchers, budgets, up
// to 1000-character descriptions), so there is no public read of them yet. The
// home answers `promotions: []` until a public promo summary exists (WS-08
// follow-up); nothing is guessed from the rule table.

import { and, asc, eq } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  CoreError,
  brandIdSchema,
  createUlid,
  outletIdSchema,
  toIsoDateTime,
  userIdSchema,
} from "@starter/shared/core";
import {
  brandWebsiteContentSchema,
  brandWebsiteSchema,
  publicSiteSchema,
  type BrandWebsite,
  type PublicOpeningHours,
  type PublicSite,
  type SaveBrandWebsiteInput,
} from "@starter/shared/website";
import { AccessError } from "@starter/shared/access";
import { db } from "../db/index.ts";
import {
  brands,
  brandWebsites,
  outlets,
  reservationPolicies,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { getPublicMenuPage } from "./guest-menu.service.ts";

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

const FEATURED_ITEM_LIMIT = 6;

/** `Date#getDay` numbers (0 = Sunday) for the weekday keys of `outlets.opening_hours`. */
const WEEKDAY_NUMBER = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
} as const;

type OutletHours = Record<
  keyof typeof WEEKDAY_NUMBER,
  { opens: string; closes: string } | null
>;

/** Groups the weekdays that share the same hours into the public shape. */
export function toPublicOpeningHours(hours: OutletHours): PublicOpeningHours[] {
  const groups = new Map<string, PublicOpeningHours>();
  for (const [day, number] of Object.entries(WEEKDAY_NUMBER)) {
    const window = hours[day as keyof typeof WEEKDAY_NUMBER];
    if (!window) continue;
    const key = `${window.opens}-${window.closes}`;
    const group = groups.get(key);
    if (group) group.daysOfWeek.push(number);
    else
      groups.set(key, {
        daysOfWeek: [number],
        opens: window.opens,
        closes: window.closes,
      } as PublicOpeningHours);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    daysOfWeek: group.daysOfWeek.sort((left, right) => left - right),
  }));
}

const notPublished = () =>
  new HttpError(
    404,
    "PUBLIC_SITE_NOT_PUBLISHED",
    "Website brand ini belum dipublikasikan.",
  );

async function resolveBrand(tx: Tx, context: ScopedTenantContext) {
  const [brand] = await tx
    .select()
    .from(brands)
    .where(
      and(
        eq(brands.tenantId, context.tenant.tenantId),
        ...(context.tenant.brandId
          ? [eq(brands.id, context.tenant.brandId)]
          : []),
      ),
    )
    .orderBy(asc(brands.createdAt), asc(brands.id))
    .limit(1);
  if (!brand) throw new CoreError("NOT_FOUND", "Brand tidak ditemukan.");
  return brand;
}

/**
 * `GET /api/public/site`. `origin` is `https://<host>` of the tenant domain the
 * request resolved to, the base of the member entry point (the contract wants
 * an absolute https URL). `null` (no resolved domain) falls back to the origin
 * of the staff-set canonical URL, never to a host the client chose.
 * Throws 404 `PUBLIC_SITE_NOT_PUBLISHED` when the brand has no published row
 * or its outlet is not active.
 */
export async function getPublicSite(
  context: ScopedTenantContext,
  origin: string | null,
): Promise<PublicSite> {
  const base = await withTenant(db, context, async (tx) => {
    const brand = await resolveBrand(tx, context);
    const [website] = await tx
      .select()
      .from(brandWebsites)
      .where(
        and(
          eq(brandWebsites.tenantId, context.tenant.tenantId),
          eq(brandWebsites.brandId, brand.id),
        ),
      )
      .limit(1);
    if (!website?.publishedAt) throw notPublished();
    const [outlet] = await tx
      .select()
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          eq(outlets.id, website.outletId),
        ),
      )
      .limit(1);
    if (!outlet || outlet.status !== "active") throw notPublished();
    const [policy] = await tx
      .select({ id: reservationPolicies.id })
      .from(reservationPolicies)
      .where(
        and(
          eq(reservationPolicies.tenantId, context.tenant.tenantId),
          eq(reservationPolicies.outletId, outletIdSchema.parse(outlet.id)),
          eq(reservationPolicies.isActive, true),
        ),
      )
      .limit(1);
    return { brand, website, outlet, acceptsReservations: Boolean(policy) };
  });

  const { brand, website, outlet } = base;
  const content = brandWebsiteContentSchema.parse(website.content);
  const openingHours = toPublicOpeningHours(outlet.openingHours);
  // A site without a pin or any opening day cannot fill the contract.
  if (!content.geo || openingHours.length === 0) throw notPublished();

  const featuredMenuItems = await readFeaturedItems(context, outlet.id);

  return publicSiteSchema.parse({
    brand: {
      id: brand.id,
      slug: brand.slug,
      name: brand.name,
      tagline: content.tagline,
      description: content.description,
    },
    outlet: {
      id: outlet.id,
      code: outlet.code,
      name: outlet.name,
      timeZone: outlet.timezone,
      address: content.address,
      geo: content.geo,
      mapUrl:
        content.googleBusinessUrl ??
        `https://www.google.com/maps/search/?api=1&query=${content.geo.latitude},${content.geo.longitude}`,
      openingHours,
    },
    heroImages: content.heroImages,
    gallery: content.gallery,
    highlights: content.highlights,
    featuredMenuItems,
    promotions: [],
    contact: content.contact,
    seo: content.seo,
    acceptsReservations: base.acceptsReservations,
    memberLoginUrl: `${origin ?? new URL(content.seo.canonicalUrl).origin}/member`,
    pricesExcludeTaxAndService: true,
    updatedAt: toIsoDateTime(website.updatedAt),
  });
}

/** Available items of the online menu (Q23 already hides items without a photo). */
async function readFeaturedItems(
  context: ScopedTenantContext,
  outletId: string,
) {
  try {
    const page = await getPublicMenuPage(
      context,
      undefined,
      undefined,
      outletId,
    );
    return page.sections
      .flatMap((section) => section.items)
      .filter((item) => item.isAvailable)
      .slice(0, FEATURED_ITEM_LIMIT)
      .map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        priceIdr: item.priceIdr,
        imageUrl: item.imageUrl,
      }));
  } catch (error) {
    // No publishable menu yet: the home still renders, without the menu cards.
    if (error instanceof CoreError && error.code === "NOT_FOUND") return [];
    throw error;
  }
}

// ---- Staff editor -----------------------------------------------------------

type WebsiteRow = typeof brandWebsites.$inferSelect;

function toBrandWebsite(row: WebsiteRow): BrandWebsite {
  return brandWebsiteSchema.parse({
    brandId: row.brandId,
    outletId: row.outletId,
    content: row.content,
    publishedAt: row.publishedAt ? toIsoDateTime(row.publishedAt) : null,
    updatedAt: toIsoDateTime(row.updatedAt),
  });
}

/** Site content is tenant configuration: only a tenant-wide scope may touch it. */
function assertTenantWide(context: ScopedTenantContext): void {
  if (context.outletScope.kind !== "tenant")
    throw new AccessError(
      "PERMISSION_DENIED",
      "Your account cannot perform this action in this tenant.",
    );
}

async function assertBrandInTenant(
  tx: Tx,
  context: ScopedTenantContext,
  brandId: string,
) {
  const [brand] = await tx
    .select({ id: brands.id })
    .from(brands)
    .where(
      and(eq(brands.tenantId, context.tenant.tenantId), eq(brands.id, brandId)),
    )
    .limit(1);
  if (!brand) throw new CoreError("NOT_FOUND", "Brand tidak ditemukan.");
}

export async function getBrandWebsiteContent(
  context: ScopedTenantContext,
  brandId: string,
): Promise<BrandWebsite> {
  assertTenantWide(context);
  return withTenant(db, context, async (tx) => {
    await assertBrandInTenant(tx, context, brandId);
    const [row] = await tx
      .select()
      .from(brandWebsites)
      .where(
        and(
          eq(brandWebsites.tenantId, context.tenant.tenantId),
          eq(brandWebsites.brandId, brandId),
        ),
      )
      .limit(1);
    if (!row)
      throw new HttpError(
        404,
        "BRAND_WEBSITE_NOT_FOUND",
        "Konten website brand ini belum dibuat.",
      );
    return toBrandWebsite(row);
  });
}

export async function saveBrandWebsiteContent(
  context: ScopedTenantContext,
  actorUserId: string,
  brandId: string,
  input: SaveBrandWebsiteInput,
): Promise<BrandWebsite> {
  assertTenantWide(context);
  const tenantId = context.tenant.tenantId;
  const actorId = userIdSchema.parse(actorUserId);
  brandIdSchema.parse(brandId);
  if (input.publish && input.content.geo === null)
    throw new HttpError(
      422,
      "BRAND_WEBSITE_GEO_REQUIRED",
      "Titik lokasi wajib diisi sebelum website dipublikasikan.",
    );
  return withTenant(db, context, async (tx) => {
    await assertBrandInTenant(tx, context, brandId);
    const [previous] = await tx
      .select()
      .from(brandWebsites)
      .where(
        and(
          eq(brandWebsites.tenantId, tenantId),
          eq(brandWebsites.brandId, brandId),
        ),
      )
      .limit(1);
    const wantedOutletId = input.outletId ?? previous?.outletId;
    const [outlet] = await tx
      .select({
        id: outlets.id,
        status: outlets.status,
        openingHours: outlets.openingHours,
      })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, tenantId),
          eq(outlets.brandId, brandId),
          ...(wantedOutletId ? [eq(outlets.id, wantedOutletId)] : []),
        ),
      )
      .orderBy(asc(outlets.createdAt), asc(outlets.id))
      .limit(1);
    if (!outlet)
      throw new HttpError(
        422,
        "BRAND_WEBSITE_OUTLET_INVALID",
        "Outlet tidak termasuk brand ini.",
      );
    // A published site needs an open outlet with at least one opening day,
    // otherwise the public read could never fill the contract.
    if (
      input.publish &&
      (outlet.status !== "active" ||
        toPublicOpeningHours(outlet.openingHours).length === 0)
    )
      throw new HttpError(
        422,
        "BRAND_WEBSITE_OUTLET_NOT_PUBLISHABLE",
        "Outlet harus aktif dan memiliki jam buka sebelum website dipublikasikan.",
      );

    const now = new Date();
    const publishedAt = input.publish ? (previous?.publishedAt ?? now) : null;
    const [row] = await tx
      .insert(brandWebsites)
      .values({
        tenantId,
        brandId,
        outletId: outlet.id,
        content: input.content,
        publishedAt,
        updatedBy: actorId,
      })
      .onConflictDoUpdate({
        target: [brandWebsites.tenantId, brandWebsites.brandId],
        set: {
          outletId: outlet.id,
          content: input.content,
          publishedAt,
          updatedBy: actorId,
          updatedAt: now,
        },
      })
      .returning();
    if (!row) throw new Error("Brand website was not saved");

    const state = (published: Date | null | undefined) =>
      published ? "published" : "draft";
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(),
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "brand_website.saved",
        objectType: "brand_website",
        objectId: row.id,
        reason: null,
        // Content stays out of the log: it can be long and is public once live.
        maskedChanges: {
          before: previous
            ? {
                outletId: previous.outletId,
                state: state(previous.publishedAt),
              }
            : null,
          after: { outletId: row.outletId, state: state(row.publishedAt) },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      ["outletId", "state"],
    );
    return toBrandWebsite(row);
  });
}
