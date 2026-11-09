// Tenant Theme storage + activation gate (PRD v1.7 §3 F4 "Whitelabel", §6 A
// `tenant_themes`). TEN-10: a theme below WCAG 2.2 AA cannot be activated,
// checked again on the server for light AND dark mode.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { CreateThemeDraftInput } from "@starter/shared/platform";
import {
  activateTheme,
  checkTheme,
  createThemeDraft,
  listThemes,
  ThemeContrastError,
} from "../services/platform-theme.service";
import {
  createTestTenant,
  owner,
  removeTestTenant,
  storedMedia,
  type TestTenant,
} from "./platform-theme-helpers";

let a: TestTenant;
let b: TestTenant;

// Light-mode primary text on primary fails AA (white on near-white).
const badLight = {
  light: { primary: "#f2f2f2", "primary-foreground": "#ffffff" },
  dark: {},
};
// Dark mode only: a tenant cannot pass by fixing just one side.
const badDark = {
  light: {},
  dark: { primary: "#222222", "primary-foreground": "#2a2a2a" },
};
const goodTokens = {
  light: { primary: "#0b4f6c" },
  dark: {},
};

function draft(
  t: TestTenant,
  tokens: unknown,
  logoMediaId: string | null = null,
) {
  return createThemeDraft(
    t.context,
    {
      brandId: t.brandId,
      tokens,
      logoMediaId,
      fontFamily: "inter",
      corners: "lembut",
    } as unknown as CreateThemeDraftInput,
    t.actorId,
  );
}

beforeAll(async () => {
  a = await createTestTenant("tema-a");
  b = await createTestTenant("tema-b");
});

afterAll(async () => {
  await removeTestTenant(a);
  await removeTestTenant(b);
  await owner.end();
});

describe("TEN-10 theme contrast gate", () => {
  it("TEN-10 check endpoint reports failures for both modes", () => {
    expect(checkTheme({ light: {}, dark: {} }).ok).toBe(true);
    const light = checkTheme(badLight);
    expect(light.ok).toBe(false);
    expect(light.failures.length).toBeGreaterThan(0);
    expect(light.failures.every((f) => f.mode === "light")).toBe(true);
    const dark = checkTheme(badDark);
    expect(dark.ok).toBe(false);
    expect(dark.failures.some((f) => f.mode === "dark")).toBe(true);
  });

  it("TEN-10 stores a failing draft but refuses to activate it (light)", async () => {
    const theme = await draft(a, badLight);
    expect(theme.status).toBe("draft");
    expect(theme.contrastCheckPassed).toBe(false);
    await expect(
      activateTheme(a.context, theme.id, a.actorId),
    ).rejects.toBeInstanceOf(ThemeContrastError);
    const { data } = await listThemes(a.context, a.brandId);
    expect(data.find((t) => t.id === theme.id)?.status).toBe("draft");
  });

  it("TEN-10 refuses activation when only dark mode fails and lists the failures", async () => {
    const theme = await draft(a, badDark);
    const error = await activateTheme(a.context, theme.id, a.actorId).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ThemeContrastError);
    const details = (error as ThemeContrastError).details;
    expect(details.length).toBeGreaterThan(0);
    expect(details.some((d) => d.field.startsWith("dark."))).toBe(true);
  });

  it("TEN-10 does not trust a forged contrast_check_passed flag", async () => {
    const theme = await draft(a, badLight);
    // Owner role bypasses RLS: forge the cache column, not the status.
    await owner.query(
      "UPDATE tenant_themes SET contrast_check_passed = true WHERE id = $1",
      [theme.id],
    );
    await expect(
      activateTheme(a.context, theme.id, a.actorId),
    ).rejects.toBeInstanceOf(ThemeContrastError);
  });

  it("TEN-10 activates a passing theme, archives the previous one and pins the brand", async () => {
    const first = await draft(a, goodTokens);
    const second = await draft(a, { light: { primary: "#14532d" }, dark: {} });
    expect(second.version).toBe(first.version + 1);

    const active1 = await activateTheme(a.context, first.id, a.actorId);
    expect(active1.status).toBe("active");
    const active2 = await activateTheme(a.context, second.id, a.actorId);
    expect(active2.status).toBe("active");

    const { data } = await listThemes(a.context, a.brandId);
    const actives = data.filter((t) => t.status === "active");
    expect(actives.map((t) => t.id)).toEqual([second.id]);
    expect(data.find((t) => t.id === first.id)?.status).toBe("archived");

    const { rows } = await owner.query(
      "SELECT theme_id FROM brands WHERE id = $1",
      [a.brandId],
    );
    expect(rows[0].theme_id).toBe(second.id);

    // An archived version cannot be reactivated.
    await expect(
      activateTheme(a.context, first.id, a.actorId),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("TEN-10 concurrent activations leave exactly one active theme", async () => {
    const x = await draft(a, { light: { primary: "#1e3a8a" }, dark: {} });
    const y = await draft(a, { light: { primary: "#7c2d12" }, dark: {} });
    await Promise.allSettled([
      activateTheme(a.context, x.id, a.actorId),
      activateTheme(a.context, y.id, a.actorId),
    ]);
    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM tenant_themes WHERE tenant_id = $1 AND brand_id = $2 AND status = 'active'",
      [a.tenantId, a.brandId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("TEN-10 activation is audited", async () => {
    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = 'tenant_theme.activated'",
      [a.tenantId],
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it("TEN-01 TEN-10 a tenant cannot see, draft for or activate another tenant's themes", async () => {
    const own = await draft(b, goodTokens);
    // A cannot list B's brand themes, even by naming B's brand id.
    expect((await listThemes(a.context, b.brandId)).data).toEqual([]);
    // A cannot activate B's theme: it does not exist from A's side.
    await expect(
      activateTheme(a.context, own.id, a.actorId),
    ).rejects.toMatchObject({ status: 404 });
    // A cannot create a draft under B's brand.
    await expect(
      createThemeDraft(
        a.context,
        {
          brandId: b.brandId,
          tokens: goodTokens,
          logoMediaId: null,
          fontFamily: "inter",
          corners: "lembut",
        } as unknown as CreateThemeDraftInput,
        a.actorId,
      ),
    ).rejects.toMatchObject({ status: 404 });
    const { rows } = await owner.query(
      "SELECT status FROM tenant_themes WHERE id = $1",
      [own.id],
    );
    expect(rows[0].status).toBe("draft");
  });

  it("TEN-03 an outlet-scoped context cannot manage themes", async () => {
    const scoped = establishScopedTenantContext(
      establishTenantContext({
        tenantId: a.tenantId,
        brandId: null,
        source: "session",
      }),
      {
        kind: "outlets",
        outletIds: [outletIdSchema.parse(crypto.randomUUID())],
      },
    );
    await expect(listThemes(scoped, a.brandId)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });
});

describe("legend-iiqx / TEN-10 logoMediaId belongs to the tenant", () => {
  it("legend-iiqx a draft may use a logo from the tenant's own media library", async () => {
    const mediaId = await storedMedia(a);
    const created = await draft(a, goodTokens, mediaId);
    expect(created.logoMediaId).toBe(mediaId);
  });

  it("legend-iiqx a draft with no logo is still accepted", async () => {
    const created = await draft(a, goodTokens, null);
    expect(created.logoMediaId).toBeNull();
  });

  it("legend-iiqx a draft cannot point at another tenant's media (422, nothing stored)", async () => {
    const foreign = await storedMedia(b);
    const before = (await listThemes(a.context, a.brandId)).data.length;
    await expect(draft(a, goodTokens, foreign)).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
    });
    expect((await listThemes(a.context, a.brandId)).data).toHaveLength(before);
  });

  it("legend-iiqx a draft cannot point at a media id that does not exist (422)", async () => {
    await expect(draft(a, goodTokens, randomUUID())).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
    });
  });
});
