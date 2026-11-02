// The one WS-03 mock session/floor store. The QR order journey, the floor board
// and the floor editor all read and mutate this instance, so they can never
// disagree about a session, bill, split, waiter call or layout (bead
// legend-jzud). `resetMockStores()` reseeds it, and the QR engine snapshots it
// into sessionStorage so a reload keeps the guest's table session.
import { createMockStore } from "../store.ts";
import { createWs03Engine } from "./engine.ts";

export const ws03Store = createMockStore(() => createWs03Engine());
