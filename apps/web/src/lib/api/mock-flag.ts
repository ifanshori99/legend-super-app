// Mock mode: VITE_API_MOCK=true serves fixtures from packages/shared instead of
// calling the API (docs/frontend.md, "Typed endpoints and mock mode"). Vite
// inlines the value at build time, so a normal build compiles the whole mock
// runtime out. Never set it on a real deployment.
export const API_MOCK: boolean = import.meta.env.VITE_API_MOCK === "true";
