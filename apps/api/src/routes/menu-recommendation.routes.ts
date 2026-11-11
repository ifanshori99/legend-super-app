// AI-01 menu recommendation API (legend-ptd). Mount (routes/index.ts):
// `apiRouter.use("/menu", menuRecommendationRouter)`. The outlet comes from the
// query string (`?outletId=`), never from the body.
//
//   GET /api/menu/recommendations?outletId=&anchorItemIds[]=&memberId=&at=
//                                                         menu.item.view
//       memberId needs crm.customer.view, marginBps needs recipe.cost.view
//       (each ignored/null without it, never a 403)
//   GET /api/menu/recommendation-rules?outletId=          menu.item.view
//   PUT /api/menu/recommendation-rules?outletId=          menu.item.manage
//       body: partial rules + itemRules[]
//
// Answers `{ data }`. A recommendation is a suggestion only: nothing here
// changes a price, a discount or an order total. The permission must reach the
// query's outlet (403 otherwise); other tenants' data is never visible.
import { Router, type Request } from "express";
import { outletIdSchema, z } from "@starter/shared/core";
import {
  menuRecommendationQuerySchema,
  menuRecommendationRulesUpdateSchema,
} from "@starter/shared/menu";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getAccessSnapshot,
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  getMenuRecommendations,
  getRecommendationRules,
  upsertRecommendationRules,
} from "../services/menu-recommendation.service.ts";

export const menuRecommendationRouter = Router();

menuRecommendationRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
);

const rulesQuery = z.strictObject({ outletId: outletIdSchema });

const outletOf = (req: Request) => String(req.query.outletId ?? "");
const view = requireOutletPermission("menu.item.view", outletOf);
const manage = requireOutletPermission("menu.item.manage", outletOf);

// Express parses `a[]=1&a[]=2` as the literal key `a[]` (simple query parser),
// and a single value as a string. Fold both spellings into one array.
function recommendationQuery(query: Request["query"]) {
  const { "anchorItemIds[]": bracketed, anchorItemIds, ...rest } = query;
  const anchors = [bracketed, anchorItemIds].flatMap((value) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value],
  );
  return menuRecommendationQuerySchema.parse(
    anchors.length > 0 ? { ...rest, anchorItemIds: anchors } : rest,
  );
}

menuRecommendationRouter.get("/recommendations", view, async (req, res) => {
  const input = recommendationQuery(req.query);
  // Member history and the margin are separate data permissions in the
  // query's outlet; without them both are left out, not refused.
  const snapshot = getAccessSnapshot(req);
  const target = {
    type: "outlet",
    id: outletIdSchema.parse(input.outletId),
  } as const;
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    data: await getMenuRecommendations(getScopedTenantContext(req), input, {
      canViewMemberHistory: snapshot.allows("crm.customer.view", target),
      canViewMargin: snapshot.allows("recipe.cost.view", target),
    }),
  });
});

menuRecommendationRouter.get(
  "/recommendation-rules",
  view,
  async (req, res) => {
    const { outletId } = rulesQuery.parse(req.query);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      data: await getRecommendationRules(getScopedTenantContext(req), outletId),
    });
  },
);

menuRecommendationRouter.put(
  "/recommendation-rules",
  manage,
  jsonBody,
  async (req, res) => {
    const { outletId } = rulesQuery.parse(req.query);
    const input = menuRecommendationRulesUpdateSchema.parse(req.body);
    res.json({
      data: await upsertRecommendationRules(
        getScopedTenantContext(req),
        outletId,
        input,
      ),
    });
  },
);
