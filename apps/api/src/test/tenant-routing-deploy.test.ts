// Deployment routing regressions: TEN-02 and AUTH-01.
import { describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader } from "./helpers";

const verifiedHost = cafeLegendPlatformFixtures.domains[0]!.hostname;
const challengePath = "/api/auth/login-challenges/whatsapp";

// An invalid strict body reaches schema validation only after the domain
// resolver and requireTenantContext have both run; it creates no challenge.
describe("deployment tenant routing", () => {
  it("legend-wu06 TEN-02 AUTH-01 resolves a verified login domain before Better Auth", async () => {
    const app = createApp();
    const verified = await agent(app)
      .post(challengePath)
      .set(originHeader)
      .set("Host", verifiedHost)
      .send({ unexpected: true });
    expect(verified.status).toBe(422);
    const unknown = await agent(app)
      .post(challengePath)
      .set(originHeader)
      .set("Host", "unregistered.example")
      .send({ unexpected: true });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("TENANT_NOT_FOUND");
  });

  it("legend-dno5 TEN-02 accepts SSR forwarded host only from a trusted proxy", async () => {
    const trusted = createApp();
    trusted.set("trust proxy", "loopback");
    const resolved = await agent(trusted)
      .post(challengePath)
      .set(originHeader)
      .set("Host", "api.internal")
      .set("X-Forwarded-Host", verifiedHost)
      .send({ unexpected: true });
    expect(resolved.status).toBe(422);

    const untrusted = createApp();
    untrusted.set("trust proxy", false);
    const denied = await agent(untrusted)
      .post(challengePath)
      .set(originHeader)
      .set("Host", "api.internal")
      .set("X-Forwarded-Host", verifiedHost)
      .send({ unexpected: true });
    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe("TENANT_NOT_FOUND");
  });
});
