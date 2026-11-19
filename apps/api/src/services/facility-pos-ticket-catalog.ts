// Cashier reads for the facility ticket sale (1096, legend-hpgyw card 1;
// contract @starter/shared/pos/ticket-cashier). The route has already checked
// `pos.sale.create` on the path's outlet; every read here runs under RLS
// (withTenant) and also filters the tenant and the outlet in SQL.
import {
  and,
  asc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
} from "drizzle-orm";
import {
  assertOutletInScope,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  facilityAreaIdSchema,
  facilityIdSchema,
  facilityProductIdSchema,
  facilityUnitIdSchema,
} from "@starter/shared/facility";
import {
  POS_TICKET_CUSTOMER_LIMIT,
  POS_TICKET_CUSTOMER_QUERY_MIN,
  type PosTicketCustomer,
  type PosTicketProduct,
  type PosTicketSlot,
} from "@starter/shared/pos/ticket-cashier";
import { db } from "../db/index.ts";
import { customerProfiles } from "../db/schema/crm-member.ts";
import {
  facilities,
  facilityAreas,
  facilityProducts,
  facilityUnits,
} from "../db/schema/facility.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { findFacilityOutletId } from "./facility-pos-ticket-sale.ts";
import { computeFacilityAvailability } from "./facility-slots.service.ts";
import { likePattern } from "./menu-internals.ts";

/**
 * Active customers of the tenant whose name contains `q` (wildcards match
 * literally). Id and name only: the cashier never sees phone or CRM fields.
 */
export async function searchPosTicketCustomers(
  context: ScopedTenantContext,
  outletId: OutletId,
  q: string,
): Promise<{ customers: PosTicketCustomer[] }> {
  assertOutletInScope(context.outletScope, outletId);
  const term = q.trim();
  if (term.length < POS_TICKET_CUSTOMER_QUERY_MIN)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Kata kunci minimal 3 karakter.",
    );
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select({ id: customerProfiles.id, name: customerProfiles.name })
      .from(customerProfiles)
      .where(
        and(
          eq(customerProfiles.tenantId, context.tenant.tenantId),
          isNull(customerProfiles.mergedIntoProfileId),
          ne(customerProfiles.membershipStatus, "closed"),
          ilike(customerProfiles.name, likePattern(term)),
        ),
      )
      .orderBy(asc(customerProfiles.name), asc(customerProfiles.id))
      .limit(POS_TICKET_CUSTOMER_LIMIT);
    return { customers: rows.map((row) => ({ id: row.id, name: row.name })) };
  });
}

/**
 * The single-ticket products this outlet's cashier can sell: active, type
 * `single`, with a POS menu item. The price is the product's own (the sale
 * refuses a POS price that differs).
 */
export async function listPosTicketProducts(
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<{ products: PosTicketProduct[] }> {
  assertOutletInScope(context.outletScope, outletId);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const products = await tx
      .select({
        id: facilityProducts.id,
        facilityId: facilityProducts.facilityId,
        facilityName: facilities.name,
        name: facilityProducts.name,
        priceIdr: facilityProducts.priceIdr,
        sessions: facilityProducts.sessions,
      })
      .from(facilityProducts)
      .innerJoin(
        facilities,
        and(
          eq(facilities.tenantId, facilityProducts.tenantId),
          eq(facilities.outletId, facilityProducts.outletId),
          eq(facilities.id, facilityProducts.facilityId),
        ),
      )
      .where(
        and(
          eq(facilityProducts.tenantId, tenantId),
          eq(facilityProducts.outletId, outletId),
          eq(facilityProducts.type, "single"),
          eq(facilityProducts.isActive, true),
          isNotNull(facilityProducts.menuItemId),
        ),
      )
      .orderBy(
        asc(facilities.name),
        asc(facilityProducts.name),
        asc(facilityProducts.id),
      );
    if (products.length === 0) return { products: [] };
    const facilityIds = [...new Set(products.map((row) => row.facilityId))];
    const areas = await tx
      .select({
        id: facilityAreas.id,
        facilityId: facilityAreas.facilityId,
        name: facilityAreas.name,
      })
      .from(facilityAreas)
      .where(
        and(
          eq(facilityAreas.tenantId, tenantId),
          eq(facilityAreas.outletId, outletId),
          inArray(facilityAreas.facilityId, facilityIds),
        ),
      )
      .orderBy(asc(facilityAreas.sortOrder), asc(facilityAreas.name));
    const units = await tx
      .select({
        id: facilityUnits.id,
        facilityId: facilityUnits.facilityId,
        areaId: facilityUnits.areaId,
        code: facilityUnits.code,
      })
      .from(facilityUnits)
      .where(
        and(
          eq(facilityUnits.tenantId, tenantId),
          eq(facilityUnits.outletId, outletId),
          inArray(facilityUnits.facilityId, facilityIds),
        ),
      )
      .orderBy(asc(facilityUnits.sortOrder), asc(facilityUnits.code));
    return {
      products: products.map((product) => ({
        id: facilityProductIdSchema.parse(product.id),
        facilityId: facilityIdSchema.parse(product.facilityId),
        facilityName: product.facilityName,
        name: product.name,
        priceIdr: Number(product.priceIdr),
        sessions: product.sessions,
        areas: areas
          .filter((area) => area.facilityId === product.facilityId)
          .map((area) => ({
            id: facilityAreaIdSchema.parse(area.id),
            name: area.name,
          })),
        units: units
          .filter((unit) => unit.facilityId === product.facilityId)
          .map((unit) => ({
            id: facilityUnitIdSchema.parse(unit.id),
            areaId: facilityAreaIdSchema.parse(unit.areaId),
            code: unit.code,
          })),
      })),
    };
  });
}

/**
 * Free start times of one area: the slot service's availability (unchanged),
 * reduced to the start times with at least one free, bookable unit. A facility
 * of another outlet or tenant is 404, like an unknown one.
 */
export async function listPosTicketSlots(
  context: ScopedTenantContext,
  _actorUserId: string,
  outletId: OutletId,
  query: { facilityId: string; areaId: string; date: string },
  now = new Date(),
): Promise<{
  facilityId: string;
  areaId: string;
  businessDate: string;
  slots: PosTicketSlot[];
}> {
  assertOutletInScope(context.outletScope, outletId);
  const facilityOutlet = await findFacilityOutletId(
    context.tenant.tenantId,
    query.facilityId,
  );
  if (
    !facilityOutlet ||
    facilityOutlet.toLowerCase() !== outletId.toLowerCase()
  )
    throw new HttpError(404, "NOT_FOUND", "Fasilitas tidak ditemukan.");
  const availability = await computeFacilityAvailability(context, query, now);
  const area = availability.areas.find((row) => row.areaId === query.areaId);
  const byStart = new Map<string, PosTicketSlot>();
  for (const unit of area?.units ?? [])
    if (unit.bookable)
      for (const slot of unit.slots)
        if (slot.available)
          byStart.set(slot.startsAt, {
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
          });
  return {
    facilityId: availability.facilityId,
    areaId: query.areaId,
    businessDate: availability.businessDate,
    slots: [...byStart.values()].sort(
      (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
    ),
  };
}
