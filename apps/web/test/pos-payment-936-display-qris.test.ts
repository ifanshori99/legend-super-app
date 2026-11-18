// Brief 936 part D (legend-5w6): the customer display names the QRIS provider
// from the payload's `provider` field, not from fixed text ("DOIT").
//
// Assumption: wording is "QRIS diproses oleh <Provider>" where the provider
// is "Duitku" or "DOIT"; the test only needs the provider name to follow data.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QrisPanel } from "@/features/ws04-display/components/qris-panel";
import { visibleText } from "./pos-payment-936-helpers";

function render(provider: "doit" | "duitku") {
  return renderToString(
    createElement(QrisPanel, {
      qris: {
        provider,
        amountIdr: 139_860,
        payload: "00020101021226610014ID.CO.QRIS.WWW0215ID10200000000010303UME",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    }),
  );
}

describe("customer display QRIS provider label", () => {
  test("duitku: shows Duitku and never DOIT", () => {
    const text = visibleText(render("duitku"));
    expect(text).toContain("Duitku");
    expect(text).not.toContain("DOIT");
  });

  test("doit: shows DOIT and never Duitku", () => {
    const text = visibleText(render("doit"));
    expect(text).toContain("DOIT");
    expect(text).not.toContain("Duitku");
  });
});
