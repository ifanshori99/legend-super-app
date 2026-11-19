// legend-b2kq3: Layar AI follow-up of audit G8y7k (docs/briefs/1137-ai-layar-approval-waktu.md).
// Written fail-first from the brief and the card, not from the new code.
// Decisions under test (CTO, card legend-b2kq3):
//  M4  "Cabut koneksi" and "Batalkan koneksi" stay enabled while the platform
//      lock is on (cutting access must always be possible). Everything else on
//      the screen stays locked. A viewer who may not manage the connection
//      (admin, not owner) still cannot cut it.
//  M5  A pending login under the lock stops checking its status; the card must
//      say so, in words, instead of silently waiting.
//  M6  One primary button per screen state.
//  --  With `?ai=off` the ChatGPT badge and the lock agree (see assumptions).
//  --  PayrollConfigScreen (/kelola/payroll/pengaturan) hydrates without a
//      block element (div) inside a paragraph, on every tab.
//
// ASSUMPTIONS (the card is short, the spec is silent):
//  - Badge: when the platform lock is on and ChatGPT is NOT connected
//    (`?ai=off`, disconnected), the ChatGPT card badge reads "Dikunci platform"
//    and not "Belum terhubung" (a locked card cannot be "connected"; the banner
//    says why). Connected + lock (`?state=disabled`) keeps "Terhubung":
//    e2e/legend-nnufz.mock.spec.ts requires saved status to stay visible and
//    "Dikunci platform" to be absent there. Without the lock the badge stays
//    "Belum terhubung" and "Dikunci platform" never shows.
//  - M5 copy is not fixed. The note must sit in the ChatGPT card, mention the
//    platform, and say checking/updating has stopped (berhenti, dijeda, or
//    "tidak (lagi) diperiksa/diperbarui/dicek"), all in one element.
//  - "One primary button" = at most one visible button or link painted with the
//    primary colour (solid --primary background) in the page content, counted
//    per scenario state. Checkboxes, switches and tabs do not count. Dialogs are
//    their own screen and are not counted here.
//  - Payroll: paragraph nesting is checked on the server-rendered HTML (before
//    the browser can repair it) and through React hydration diagnostics.
//
// Runs against the FE mock runtime (VITE_API_MOCK=true):
//   pnpm test:e2e:mock e2e/legend-b2kq3.mock.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

const PAGE = "/kelola/pengaturan/ai";

const chatgptCard = (page: Page) =>
  page.getByRole("region", { name: "Login ChatGPT" });

async function openAi(page: Page, query: string) {
  await page.goto(`${PAGE}${query}`);
  await waitForHydration(page);
  // The card leaves its skeleton once the login status has loaded.
  await expect(chatgptCard(page).getByRole("button").first()).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("legend-b2kq3 M4 Cabut and Batalkan stay available under the platform lock", () => {
  test("a connected ChatGPT can be cut while the platform lock is on, the rest stays locked", async ({
    page,
  }) => {
    await openAi(page, "?state=disabled");
    await expect(
      page.getByRole("alert").filter({ hasText: "AI dimatikan oleh platform" }),
    ).toBeVisible();

    const revoke = chatgptCard(page).getByRole("button", {
      name: "Cabut koneksi",
    });
    await expect(revoke).toBeEnabled();

    // Only the way out is open: the other settings stay locked.
    await expect(
      page.getByRole("button", { name: "Uji ulang koneksi" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Simpan anggaran" }),
    ).toBeDisabled();

    await revoke.click();
    const dialog = page.getByRole("dialog", {
      name: "Cabut koneksi ChatGPT?",
    });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Cabut koneksi" });
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(dialog).toBeHidden();
    await expect(
      chatgptCard(page).getByRole("button", { name: "Cabut koneksi" }),
    ).toHaveCount(0);
    // Connecting again stays locked: the platform switch is still on.
    await expect(
      chatgptCard(page).getByRole("button", { name: "Hubungkan ChatGPT" }),
    ).toBeDisabled();
  });

  test("a pending login can be cancelled while the platform lock is on", async ({
    page,
  }) => {
    await openAi(page, "?state=device&ai=off");
    await expect(chatgptCard(page).getByText("LGND-4826")).toBeVisible();

    const cancel = chatgptCard(page).getByRole("button", {
      name: "Batalkan koneksi",
    });
    await expect(cancel).toBeEnabled();
    // The rest of the pending card stays locked.
    await expect(
      chatgptCard(page).getByRole("button", { name: "Salin kode" }),
    ).toBeDisabled();

    await cancel.click();
    await expect(chatgptCard(page).getByText("LGND-4826")).toHaveCount(0);
    await expect(
      chatgptCard(page).getByRole("button", { name: "Batalkan koneksi" }),
    ).toHaveCount(0);
    await expect(
      chatgptCard(page).getByRole("button", { name: "Hubungkan ChatGPT" }),
    ).toBeDisabled();
  });

  test("an admin who is not the owner still cannot cut the connection under the lock", async ({
    page,
  }) => {
    await openAi(page, "?state=connected&role=admin&ai=off");
    await expect(
      chatgptCard(page).getByRole("button", { name: "Cabut koneksi" }),
    ).toBeDisabled();
    await expect(
      chatgptCard(page).getByText(/Hanya pemilik tenant/),
    ).toBeVisible();
  });
});

test.describe("legend-b2kq3 M5 pending login explains why checking stopped under the lock", () => {
  // One element that names the platform and says the status check has stopped.
  const STOPPED_BY_LOCK =
    /^(?=.*platform)(?=.*(berhenti|dijeda|tidak (lagi )?(diperiksa|diperbarui|dicek)))/is;

  test("the pending card says the status is not being checked because of the platform lock", async ({
    page,
  }) => {
    await openAi(page, "?state=device&ai=off");
    await expect(chatgptCard(page).getByText("LGND-4826")).toBeVisible();
    await expect(chatgptCard(page).getByText(STOPPED_BY_LOCK)).toBeVisible();
  });

  test("without the lock the pending card carries no such note", async ({
    page,
  }) => {
    await openAi(page, "?state=device");
    await expect(chatgptCard(page).getByText("LGND-4826")).toBeVisible();
    await expect(chatgptCard(page).getByText(STOPPED_BY_LOCK)).toHaveCount(0);
  });
});

test.describe("legend-b2kq3 badge agrees with the platform lock (?ai=off)", () => {
  test("locked and not connected: 'Dikunci platform', not 'Belum terhubung'", async ({
    page,
  }) => {
    await openAi(page, "?ai=off");
    await expect(
      page.getByRole("alert").filter({ hasText: "AI dimatikan oleh platform" }),
    ).toBeVisible();
    await expect(
      chatgptCard(page).getByText("Dikunci platform", { exact: true }),
    ).toBeVisible();
    await expect(
      chatgptCard(page).getByText("Belum terhubung", { exact: true }),
    ).toHaveCount(0);
  });

  test("not locked and not connected: 'Belum terhubung', never 'Dikunci platform'", async ({
    page,
  }) => {
    await openAi(page, "?state=empty");
    await expect(
      chatgptCard(page).getByText("Belum terhubung", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Dikunci platform")).toHaveCount(0);
  });

  test("locked but connected keeps the saved 'Terhubung' status visible", async ({
    page,
  }) => {
    await openAi(page, "?state=disabled");
    await expect(
      chatgptCard(page).getByText("Terhubung", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Dikunci platform")).toHaveCount(0);
  });
});

test.describe("legend-b2kq3 M6 one primary button per screen", () => {
  // Counts visible buttons and links painted with the solid primary colour.
  async function primaryButtons(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--primary)";
      document.body.append(probe);
      const primary = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const skipRoles = new Set(["checkbox", "switch", "radio", "tab"]);
      const root = document.querySelector("#main-content") ?? document.body;
      return Array.from(root.querySelectorAll("button, a[href], [role=button]"))
        .filter((el) => {
          if (skipRoles.has(el.getAttribute("role") ?? "")) return false;
          if (!(el as HTMLElement).checkVisibility()) return false;
          return getComputedStyle(el).backgroundColor === primary;
        })
        .map((el) => (el.textContent ?? "").trim());
    });
  }

  const SCREENS: Array<[string, string]> = [
    ["not connected", "?state=empty"],
    ["login code pending", "?state=device"],
    ["connected with a saved model", "?state=detected"],
    ["login failed", "?state=failed"],
    ["code expired", "?state=expired"],
    ["platform lock, connected", "?state=disabled"],
    ["platform lock, not connected", "?ai=off"],
  ];

  for (const [label, query] of SCREENS) {
    test(`${label} (${query}) shows at most one primary button`, async ({
      page,
    }) => {
      await openAi(page, query);
      await expect(
        page.getByRole("button", { name: "Simpan anggaran" }),
      ).toBeVisible({ timeout: 15_000 });
      const found = await primaryButtons(page);
      expect(
        found.length,
        `primary buttons: ${found.join(" | ")}`,
      ).toBeLessThanOrEqual(1);
    });
  }

  test("the main next step is the one primary button when nothing is locked", async ({
    page,
  }) => {
    // Not connected: the way forward is "Hubungkan ChatGPT". Primary only once
    // the owner has accepted the risk, so tick the consent first.
    await openAi(page, "?state=empty");
    await page.getByRole("checkbox").first().check();
    await expect(
      chatgptCard(page).getByRole("button", { name: "Hubungkan ChatGPT" }),
    ).toBeEnabled();
    // The button fades in from its disabled look (transition-colors), so poll
    // until the computed colour settles instead of reading it once.
    await expect
      .poll(() => primaryButtons(page), {
        message: "the connect button becomes the only primary button",
      })
      .toEqual(["Hubungkan ChatGPT"]);
  });
});

// PayrollConfigScreen (hydration warning: a div inside a p).
test.describe("legend-b2kq3 payroll settings hydrate without a block inside a paragraph", () => {
  test.describe.configure({ timeout: 90_000 });

  const BLOCKS = new Set([
    "div",
    "p",
    "ul",
    "ol",
    "li",
    "table",
    "section",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
  ]);
  const VOID = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "source",
    "track",
    "wbr",
  ]);

  /** Block tags that open while a <p> is still open in the raw server HTML. */
  function blocksInsideParagraph(html: string): string[] {
    const source = html
      .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    const stack: string[] = [];
    const found: string[] = [];
    for (const match of source.matchAll(
      /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g,
    )) {
      const name = match[2].toLowerCase();
      if (VOID.has(name) || match[3] === "/") continue;
      if (match[1] === "/") {
        const at = stack.lastIndexOf(name);
        if (at >= 0) stack.length = at;
        continue;
      }
      if (BLOCKS.has(name) && stack.includes("p")) found.push(`<${name}>`);
      stack.push(name);
    }
    return found;
  }

  for (const tab of ["policies", "components", "statutory", "thr"]) {
    for (const mode of ["", "&mock=slow"]) {
      test(`tab ${tab}${mode ? " (slow load)" : ""}: server HTML and hydration are clean`, async ({
        page,
      }) => {
        const url = `/kelola/payroll/pengaturan?tab=${tab}${mode}`;
        const diagnostics: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error" || message.type() === "warning")
            diagnostics.push(message.text());
        });
        page.on("pageerror", (error) => diagnostics.push(error.message));

        const served = await page.request.get(url);
        expect(served.ok()).toBe(true);
        expect(blocksInsideParagraph(await served.text())).toEqual([]);

        await page.goto(url, { waitUntil: "domcontentloaded" });
        await waitForHydration(page);
        expect(
          diagnostics.filter((message) =>
            /hydrat|cannot be a descendant|cannot contain a nested|validateDOMNesting/i.test(
              message,
            ),
          ),
        ).toEqual([]);
      });
    }
  }
});
