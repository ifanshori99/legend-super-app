// legend-ms2a: the personal-data scan on config templates (TEN-09).
// Part 1 is the pure detector; part 2 runs the real app and PostgreSQL.
import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cafeLegendPlatformFixtures,
  detectPii,
  scanConfigBundlePii,
} from "@starter/shared/platform";
import { createApp } from "../app";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const kindsOf = (text: string) => detectPii(text).map((hit) => hit.kind);

describe("legend-ms2a detector", () => {
  it("finds Indonesian phone numbers in common writings", () => {
    for (const text of [
      "Telepon 081234567890 sebelum buka",
      "WA: 0812-3456-7890",
      "hubungi +62 812 3456 7890",
      "hubungi 6281234567890",
      "hubungi (+62) 812 3456 7890",
      "hubungi +62 (812) 3456 7890",
      "hubungi (+62) 812-3456-7890",
    ])
      expect(kindsOf(text), text).toEqual(["phone"]);
  });

  it("finds e-mail addresses", () => {
    expect(kindsOf("kirim laporan ke budi.santoso@gmail.com ya")).toEqual([
      "email",
    ]);
  });

  it("finds a plausible NIK once, not also as a phone", () => {
    // Jakarta (31), birth day 15, month 08.
    expect(kindsOf("NIK 3171150808900001")).toEqual(["nik"]);
    // Woman: day + 40.
    expect(kindsOf("NIK 3171550808900001")).toEqual(["nik"]);
  });

  it("finds a NIK written with space, dot or dash separators", () => {
    for (const text of [
      "NIK 3171 1508 0890 0001",
      "NIK 3171.1508.0890.0001",
      "NIK 3171-1508-0890-0001",
      "NIK 317115-080890-0001",
    ])
      expect(kindsOf(text), text).toEqual(["nik"]);
    const [hit] = detectPii("NIK 3171 1508 0890 0001");
    expect(hit?.excerpt).toContain("*");
    expect(hit?.excerpt).not.toContain("1508");
  });

  it("does not read a longer digit run or a bad date as a separated NIK", () => {
    for (const text of [
      "Kode 1234 5678 9012 3456", // no valid province
      "Seri 3171 1508 0890 0001 0002", // 20 digits
      "Seri 99 3171 1508 0890 0001", // longer run before it
      "Kode 3171 1599 0890 0001", // day 99 is not a date
    ])
      expect(kindsOf(text), text).not.toContain("nik");
  });

  it("finds a person name after an honorific", () => {
    expect(kindsOf("Tanyakan ke Bapak Budi Santoso")).toEqual(["person_name"]);
    expect(kindsOf("serahkan kunci ke bu Rina")).toEqual(["person_name"]);
    expect(kindsOf("Dr. Hartono hadir")).toEqual(["person_name"]);
  });

  it("finds a person name after an honorific in any letter case", () => {
    for (const text of [
      "serahkan kunci ke pak joko",
      "Tanyakan ke PAK BUDI",
      "hubungi ibu rina sebelum buka",
      "Titip ke BAPAK BUDI SANTOSO",
      "titip ke pak Joko",
    ])
      expect(kindsOf(text), text).toEqual(["person_name"]);
    expect(detectPii("serahkan kunci ke pak joko")[0]?.excerpt).not.toMatch(
      /joko/i,
    );
  });

  it("keeps the role-word stoplist whatever the letter case", () => {
    for (const text of [
      "Pak Kasir menyerahkan kunci",
      "pak kasir menyerahkan kunci",
      "PAK KASIR MENYERAHKAN KUNCI",
      "ibu hamil didahulukan",
      "IBU KOTA JAKARTA",
      "mas barista menyiapkan bar",
      "bapak manajer menyetujui",
      "Bapak yang bertugas menutup toko",
    ])
      expect(detectPii(text), text).toEqual([]);
  });

  it("never returns the full value", () => {
    const text =
      "WA 081234567890, budi.santoso@gmail.com, NIK 3171150808900001, Pak Budi";
    const hits = detectPii(text);
    expect(hits.map((hit) => hit.kind).sort()).toEqual([
      "email",
      "nik",
      "person_name",
      "phone",
    ]);
    for (const hit of hits) {
      expect(hit.excerpt).toContain("*");
      for (const secret of [
        "081234567890",
        "budi.santoso@gmail.com",
        "3171150808900001",
        "Pak Budi",
      ])
        expect(hit.excerpt).not.toBe(secret);
    }
    const joined = hits.map((hit) => hit.excerpt).join(" ");
    expect(joined).not.toContain("081234567890");
    expect(joined).not.toContain("3171150808900001");
    expect(joined).not.toContain("Budi");
  });

  it("leaves ordinary operating text alone", () => {
    for (const text of [
      "Kasir dibuka dan dihitung",
      "Cek suhu chiller 4 derajat dan catat angkanya",
      "Harga paket Rp 25.000, diskon 10%",
      "Ibu Kota Jakarta",
      "Bapak Kasir menyerahkan kunci",
      "Pak Manajer menyetujui",
      "Mas Barista menyiapkan bar",
      "Nomor meja 12 sampai 40",
      "Kode 1234567890123456", // 16 digits, no valid province
      "Antrian 20260115 dan 081 saja",
      "Zona WFC lantai 2",
      "Buka pukul 08.00, tutup 22.00",
      "Masuk lewat pintu belakang",
    ])
      expect(detectPii(text), text).toEqual([]);
  });

  it("scans checklist, text override and generic item text with paths", () => {
    const findings = scanConfigBundlePii({
      checklists: {
        version: 1,
        items: [
          {
            key: "buka",
            name: "Buka Toko",
            items: [
              { label: "Hubungi 081234567890", instruction: null },
              { label: "Cek kasir", instruction: "Lapor ke Bu Rina" },
            ],
          },
        ],
      },
      text_overrides: {
        version: 1,
        sets: [
          {
            locale: "id",
            overrides: [{ key: "terms.zone", value: "a@b.co" }],
          },
        ],
      },
      facilities: {
        version: 1,
        items: [{ key: "f1", name: "Shower", description: "Pak Joko jaga" }],
      },
      zones: { version: 1, items: [{ key: "z1", name: "Indoor" }] },
    });
    expect(
      findings.map((finding) => [finding.section, finding.path, finding.kind]),
    ).toEqual([
      ["checklists", "items[0].items[0].label", "phone"],
      ["checklists", "items[0].items[1].instruction", "person_name"],
      ["text_overrides", "sets[0].overrides[0].value", "email"],
      ["facilities", "items[0].description", "person_name"],
    ]);
  });
});

// --------------------------------------------------------------------- API

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const limits = cafeLegendPlatformFixtures.tenant.limits;
const suffix = () => randomBytes(4).toString("hex");
const adminUserIds: string[] = [];
let admin: { client: ReturnType<typeof agent>; userId: string };
let tenantId: string;

async function asTenant<T>(
  id: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [id],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const OVERRIDE_PHONE = "081234567890";

beforeAll(async () => {
  const client = agent(app);
  const email = await signUp(client, "Platform Admin PII");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
  adminUserIds.push(userId);
  await verifySessionMfa(email);
  admin = { client, userId };

  const created = await client
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      slug: `pii-${suffix()}`,
      name: "Uji PII",
      plan: "lengkap",
      deploymentMode: "shared",
      featureFlags: { modules: ["pos"], integrationProviders: [] },
      limits,
      firstAdmin: {
        name: "Admin Pertama",
        whatsapp: "6281234567890",
        email: null,
      },
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  tenantId = created.body.data.id as string;
  await asTenant(tenantId, (db) =>
    db.query(
      `INSERT INTO text_overrides (tenant_id, locale, key, value, updated_by)
       VALUES ($1, 'id', 'terms.zone', $2, $3)`,
      [tenantId, `Zona, hubungi ${OVERRIDE_PHONE}`, userId],
    ),
  );
});

afterAll(async () => {
  await owner.query("DELETE FROM platform_admins WHERE user_id = ANY($1)", [
    adminUserIds,
  ]);
  await owner.end();
});

const post = (body: object) =>
  admin.client
    .post(`/api/platform/tenants/${tenantId}/config-templates`)
    .set(originHeader)
    .send(body);

describe("legend-ms2a template creation", () => {
  it("refuses with TEMPLATE_PII_FINDINGS and masked details, storing nothing", async () => {
    const name = `PII ${suffix()}`;
    const response = await post({ name, sections: ["text_overrides"] });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("TEMPLATE_PII_FINDINGS");
    expect(response.body.error.details).toHaveLength(1);
    expect(response.body.error.details[0].field).toBe(
      "text_overrides.sets[0].overrides[0].value",
    );
    expect(response.body.error.details[0].message).toMatch(/^phone: /);
    expect(JSON.stringify(response.body)).not.toContain(OVERRIDE_PHONE);
    const stored = await owner.query(
      "SELECT 1 FROM config_templates WHERE name = $1",
      [name],
    );
    expect(stored.rowCount).toBe(0);
  });

  it("stores the template and audits the confirmation when confirmPiiFindings is true", async () => {
    const name = `PII ok ${suffix()}`;
    const response = await post({
      name,
      sections: ["text_overrides"],
      confirmPiiFindings: true,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const templateId = response.body.data.id as string;
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM audit_logs
       WHERE tenant_id = $1 AND event->>'objectId' = $2
         AND event->>'action' = 'platform.config_template.created'`,
      [tenantId, templateId],
    );
    expect(rows).toHaveLength(1);
    const audit = JSON.stringify(rows[0]?.event);
    expect(audit).toContain("piiFindingsConfirmed");
    // No excerpt, masked or not, and no raw value.
    expect(audit).not.toMatch(/excerpt/i);
    expect(audit).not.toContain(OVERRIDE_PHONE);
    expect(audit).not.toContain("08********90");
    // Only counts and kinds are recorded (the audit layer masks their values).
    expect(audit).toContain("piiFindingCount");
    expect(audit).toContain("piiFindingKinds");
  });

  it("stores a clean export without confirmation", async () => {
    await asTenant(tenantId, (db) =>
      db.query(
        "UPDATE text_overrides SET value = 'Zona kerja' WHERE tenant_id = $1",
        [tenantId],
      ),
    );
    const response = await post({
      name: `PII clean ${suffix()}`,
      sections: ["text_overrides"],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it("caps details at 50 and reports the total number of findings", async () => {
    await asTenant(tenantId, (db) =>
      db.query("UPDATE text_overrides SET value = $2 WHERE tenant_id = $1", [
        tenantId,
        Array.from({ length: 60 }, () => "a@b.co").join(" "),
      ]),
    );
    const response = await post({
      name: `PII many ${suffix()}`,
      sections: ["text_overrides"],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("TEMPLATE_PII_FINDINGS");
    expect(response.body.error.details).toHaveLength(50);
    expect(response.body.error.message).toContain("60");
  });
});
