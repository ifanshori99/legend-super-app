// Bearer credentials for API calls that are not cookie-authenticated. A feature
// registers a provider that maps a request path to a token (or null). Today
// only the QR table session does: guest endpoints under /api/table-sessions
// take `Authorization: Bearer <sessionToken>` (PRD §3 "Keamanan Sesi", ORD-04).
// Providers run in the browser only; on the server they return null.
type Provider = (path: string) => string | null;

const providers = new Set<Provider>();

export function registerBearerProvider(provider: Provider): void {
  providers.add(provider);
}

export function bearerHeaderFor(path: string): Record<string, string> {
  for (const provider of providers) {
    const token = provider(path);
    if (token) return { authorization: `Bearer ${token}` };
  }
  return {};
}
