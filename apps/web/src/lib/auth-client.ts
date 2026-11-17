import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { ac, roles } from "@starter/shared/permissions";
import { API_URL } from "@/lib/env";
import { deviceTokenHeader } from "@/lib/device-token-store";

// Talks to Better Auth on the Express API (a different origin), so every call
// carries cookies with credentials: "include". The API's CORS and Better
// Auth's trustedOrigins accept exactly this web origin.
//
// Sign-in sends the registered device token (browser only), so a session created
// on a shared device is stamped at creation and asks for the cashier PIN at once
// (legend-sq1ux). The header name is allowed by the API CORS list.
//
// adminClient shares the access control, so authClient.admin.checkRolePermission
// can hide UI locally. It is a convenience only: the API checks every request.
export const authClient = createAuthClient({
  baseURL: API_URL,
  fetchOptions: {
    credentials: "include",
    // Read at call time, not at import; browser only (empty on the server).
    onRequest: (context: { headers: Headers }) => {
      for (const [name, value] of Object.entries(deviceTokenHeader()))
        context.headers.set(name, value);
    },
  },
  plugins: [adminClient({ ac, roles })],
});

export type Session = typeof authClient.$Infer.Session;
