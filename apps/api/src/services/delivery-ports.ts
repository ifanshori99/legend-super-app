// Adapter registry of the delivery channel framework (bead legend-5bn3; PRD
// v1.7 §3.23, §6.G DeliveryChannel adapter). Services never import a platform
// client: they ask for the `DeliveryChannel` of a platform here. Real
// GoFood/GrabFood/ShopeeFood adapters (legend-im8n) install themselves with
// `setDeliveryChannelAdapter`; until then every platform answers with the
// in-memory fake, so the framework runs end to end without a platform account.
import {
  FakeDeliveryChannel,
  type DeliveryChannel as DeliveryChannelAdapter,
  type DeliveryRequest,
} from "@starter/shared/adapters";
import type { DeliveryPlatform } from "@starter/shared/delivery";

const installed = new Map<DeliveryPlatform, DeliveryChannelAdapter>();
const inner = new FakeDeliveryChannel();
const recorded: DeliveryRequest[] = [];

/** The shared fake, recording every accepted request for tests. */
const fake: DeliveryChannelAdapter = {
  async execute(context, input) {
    const result = await inner.execute(context, input);
    recorded.push(input);
    return result;
  },
};

/** The adapter of one platform: the installed one, else the shared fake. */
export function deliveryChannelAdapterFor(
  platform: DeliveryPlatform,
): DeliveryChannelAdapter {
  return installed.get(platform) ?? fake;
}

/** Wiring point for real adapters and test doubles; null restores the fake. */
export function setDeliveryChannelAdapter(
  platform: DeliveryPlatform,
  adapter: DeliveryChannelAdapter | null,
): void {
  if (adapter === null) installed.delete(platform);
  else installed.set(platform, adapter);
}

/**
 * Test hook: requests the default fake accepted since the last clear, in call
 * order (an installed adapter records its own calls). A copy, never the store.
 */
export function recordedDeliveryCalls(): DeliveryRequest[] {
  return [...recorded];
}

export function clearRecordedDeliveryCalls(): void {
  recorded.length = 0;
}
