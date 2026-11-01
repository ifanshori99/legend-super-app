// Mutable in-memory state for mock handlers (a cart, a created order…). Each
// store re-seeds from its factory on reset, so tests and Playwright runs start
// clean. State lives per runtime: the SSR server and the browser each hold
// their own copy, so mutations (browser only) never reach server renders.

const resetters = new Set<() => void>();

export function createMockStore<T>(seed: () => T) {
  let value = seed();
  const reset = () => {
    value = seed();
  };
  resetters.add(reset);
  return {
    get: () => value,
    set: (next: T) => {
      value = next;
    },
    reset,
  };
}

export function resetMockStores() {
  for (const reset of resetters) reset();
}
