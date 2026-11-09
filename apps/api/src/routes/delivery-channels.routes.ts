// Delivery channel channel state and menu sync routes (bead legend-5bn3; contract
// @starter/shared/delivery endpoints.ts). Slice D2.
//
// Mount (routes/index.ts): `apiRouter.use("/outlets/:outletId/delivery-channels", deliveryChannelsRouter)`;
// the router merges params. requireAuth + requireTrustedOrigin +
// requireTenantContext like the POS routers; each handler adds
// requireOutletPermission on the path's outlet (`delivery.channel.manage`:
// store state and menu sync are the supervisor's job, so the list needs it too).
import { Router, type Request } from "express";
import {
  listDeliveryChannels,
  setDeliveryChannelState,
  syncDeliveryChannelMenu,
} from "@starter/shared/delivery";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as channels from "../services/delivery-channels.service.ts";

export const deliveryChannelsRouter = Router({ mergeParams: true });

deliveryChannelsRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
);

const outletOf = (req: Request) => String(req.params.outletId ?? "");
const manage = requireOutletPermission("delivery.channel.manage", outletOf);

deliveryChannelsRouter.get("/", manage, async (req, res) => {
  const { outletId } = listDeliveryChannels.params.parse(req.params);
  res.json({
    data: await channels.listDeliveryChannels(
      getScopedTenantContext(req),
      outletId,
    ),
  });
});

deliveryChannelsRouter.patch(
  "/:platform",
  manage,
  jsonBody,
  async (req, res) => {
    const { outletId, platform } = setDeliveryChannelState.params.parse(
      req.params,
    );
    const body = setDeliveryChannelState.body.parse(req.body);
    res.json({
      data: await channels.setDeliveryChannelState(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        outletId,
        platform,
        body,
      ),
    });
  },
);

// No request body (contract): the menu is read server-side.
deliveryChannelsRouter.post("/:platform/sync", manage, async (req, res) => {
  const { outletId, platform } = syncDeliveryChannelMenu.params.parse(
    req.params,
  );
  res.json({
    data: await channels.syncDeliveryChannelMenu(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      outletId,
      platform,
    ),
  });
});
