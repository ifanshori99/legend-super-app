// legend-iq0jz (sub-1043): which web screens a shared tablet may open.
// Spec = docs/briefs/sub-1043-allowlist.md section B (founder Q29, 18 Nov).
//
// Open on a shared tablet: POS/kasir (incl. /pos/reservasi), KDS (incl.
// /kds/tanya-ai), the PIN/sign-in pages the tablet needs, public pages.
// Closed: operasional, fasilitas, backoffice, dashboards, platform, customer
// area and everything else (default closed). Presentation only; the API
// enforces the same list.
//
// Assumptions (the brief leaves these open):
//  - "/sign-in", "/", "/menu" and "/reservasi" stand for the "masuk/keluar" and
//    public pages that stay open. /expo, /pickup, query strings and letter case
//    are not asserted (the brief does not decide them).
//  - The guard decision is the pure `isScreenClosedOnSharedDevice(access,
//    pathname)` exported by `lib/areas/guard.ts`: the brief only says the guard
//    answers notFound/forbidden for a closed path when `access.sharedDevice`.
//  - `AreaAccess.sharedDevice` comes from the /api/me/access view and is false
//    when the field is absent (older API).
import type { LucideIcon } from "lucide-react";
import { isSharedDeviceScreenAllowed } from "@starter/shared/access/shared-device-screens";
import { myAccessViewSchema } from "@starter/shared/access";
import { resolveAreaAccess, type AreaAccess } from "@/lib/areas/access";
import { buildAreaNav, type AreaNavEntry } from "@/lib/areas/nav";
import * as guard from "@/lib/areas/guard";

const OPEN = [
  "/pos",
  "/pos/",
  "/pos/kasir",
  "/pos/reservasi",
  "/pos/ganti-pengguna",
  "/kds",
  "/kds/papan",
  "/kds/tanya-ai",
  "/kds/tanya-ai/panduan",
  "/kds/ganti-pengguna",
  "/sign-in",
  "/",
  "/menu",
  "/reservasi",
];

const CLOSED = [
  "/operasional",
  "/operasional/checklist",
  "/fasilitas",
  "/fasilitas/booth",
  "/kelola",
  "/kelola/inventori",
  "/reports",
  "/audit",
  "/owner",
  "/shareholder",
  "/karyawan",
  "/platform",
  "/member",
  "/t/abc",
  "/f/abc",
  "/wifi",
  "/foo",
  "/unknown/new-route",
  // Whole segments only: "/posx" is not "/pos".
  "/posx",
  "/posx/kasir",
  "/pos-lama",
  "/kdsx",
  "/kds-lama/tanya-ai",
  // Path tricks stay closed.
  "/pos/../operasional",
  "/pos/%2e%2e/operasional",
  "//pos",
  "",
];

describe("legend-iq0jz isSharedDeviceScreenAllowed", () => {
  it.each(OPEN)("opens %s", (path) => {
    expect(isSharedDeviceScreenAllowed(path)).toBe(true);
  });

  it.each(CLOSED)("closes %j", (path) => {
    expect(isSharedDeviceScreenAllowed(path)).toBe(false);
  });
});

// ---- navigation ----------------------------------------------------------------

const icon = (() => null) as unknown as LucideIcon;
const t = ((key: string) => key) as never;

function access(sharedDevice: boolean): AreaAccess {
  return {
    authenticated: true,
    permissions: [],
    mfaRequired: false,
    mfaVerified: true,
    stations: [],
    outlets: [],
    sharedDevice,
  } as AreaAccess;
}

const opsEntries: AreaNavEntry[] = [
  { area: "ops", labelKey: "area.ops.name", to: "/pos/reservasi", icon },
  { area: "ops", labelKey: "area.ops.name", to: "/operasional", icon },
  { area: "ops", labelKey: "area.ops.name", to: "/fasilitas", icon },
] as AreaNavEntry[];

const kitchenEntries: AreaNavEntry[] = [
  { area: "kitchen", labelKey: "area.kitchen.name", to: "/kds/tanya-ai", icon },
  { area: "kitchen", labelKey: "area.kitchen.name", to: "/kds/papan", icon },
] as AreaNavEntry[];

describe("legend-iq0jz navigation on a shared tablet", () => {
  const ops = (shared: boolean) =>
    buildAreaNav({
      area: "ops",
      entries: opsEntries,
      indexIcon: icon,
      access: access(shared),
      pathname: "/pos",
      t,
    }).map((item) => item.href);

  it("hides operasional and fasilitas, keeps POS and reservasi", () => {
    expect(ops(true)).toEqual(["/pos", "/pos/reservasi"]);
  });

  it("shows operasional and fasilitas on a personal device", () => {
    expect(ops(false)).toEqual([
      "/pos",
      "/pos/reservasi",
      "/operasional",
      "/fasilitas",
    ]);
  });

  it("keeps the KDS entries, including Tanya AI, on a shared tablet", () => {
    const items = buildAreaNav({
      area: "kitchen",
      entries: kitchenEntries,
      indexIcon: icon,
      access: access(true),
      pathname: "/kds",
      t,
    }).map((item) => item.href);
    expect(items).toEqual(expect.arrayContaining(["/kds", "/kds/tanya-ai"]));
  });
});

// ---- guard ---------------------------------------------------------------------

describe("legend-iq0jz guard on a shared tablet", () => {
  const closedFn = (guard as Record<string, unknown>)
    .isScreenClosedOnSharedDevice as
    ((a: AreaAccess, pathname: string) => boolean) | undefined;

  it("exports the guard decision", () => {
    expect(typeof closedFn).toBe("function");
  });

  it.each(["/operasional", "/operasional/checklist", "/fasilitas", "/kelola"])(
    "closes %s when sharedDevice is true",
    (path) => {
      expect(closedFn!(access(true), path)).toBe(true);
    },
  );

  it.each(["/pos", "/pos/reservasi", "/kds", "/kds/tanya-ai"])(
    "opens %s when sharedDevice is true",
    (path) => {
      expect(closedFn!(access(true), path)).toBe(false);
    },
  );

  it.each(["/operasional", "/fasilitas", "/kelola", "/pos"])(
    "accepts %s when sharedDevice is false",
    (path) => {
      expect(closedFn!(access(false), path)).toBe(false);
    },
  );
});

// ---- the flag from /api/me/access ---------------------------------------------

describe("legend-iq0jz AreaAccess.sharedDevice", () => {
  const view = (extra: Record<string, unknown> = {}) => ({
    permissions: [],
    mfaRequired: false,
    mfaVerified: true,
    stations: [],
    outlets: [],
    activeOutletId: null,
    supportSession: null,
    ...extra,
  });
  const session = { user: { id: "u1" } };

  it("is true when the API says sharedDevice: true", async () => {
    expect(
      myAccessViewSchema.safeParse(view({ sharedDevice: true })).success,
    ).toBe(true);
    const result = await resolveAreaAccess(session, async () =>
      view({ sharedDevice: true }),
    );
    expect(result.sharedDevice).toBe(true);
  });

  it("is false when the API says sharedDevice: false", async () => {
    const result = await resolveAreaAccess(session, async () =>
      view({ sharedDevice: false }),
    );
    expect(result.sharedDevice).toBe(false);
  });

  it("defaults to false when an older API sends no field", async () => {
    const result = await resolveAreaAccess(session, async () => view());
    expect(result.authenticated).toBe(true);
    expect(result.sharedDevice ?? false).toBe(false);
  });
});
