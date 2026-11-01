import { expect, it, vi } from "vitest";
import { createRelayRuntime } from "../worker/relay";

it("sweeps trusted active tenants on initial start, schedule, and wakeup without overlapping", async () => {
  let scheduled: (() => Promise<void>) | undefined;
  let wake: (() => void) | undefined;
  const scheduler = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    schedule: vi.fn(async (fn: () => Promise<void>) => {
      scheduled = fn;
    }),
  };
  const listener = {
    start: vi.fn(async (fn: () => void) => {
      wake = fn;
    }),
    stop: vi.fn(async () => {}),
  };
  const relay = vi.fn(async (context: string) => {
    void context;
  });
  const service = createRelayRuntime({
    scheduler,
    listener,
    listActiveTenantIds: async () => ["a", "b"],
    resolveContext: async (id: string) => `trusted-${id}`,
    relay,
  });
  await service.start();
  expect(relay.mock.calls.map(([ctx]) => ctx)).toEqual([
    "trusted-a",
    "trusted-b",
  ]);
  await scheduled!();
  expect(relay).toHaveBeenCalledTimes(4);
  wake!();
  await vi.waitFor(() => expect(relay).toHaveBeenCalledTimes(6));
  await service.stop();
  expect(scheduler.stop).toHaveBeenCalledOnce();
  expect(listener.stop).toHaveBeenCalledOnce();
});
