// Staff panic alert screen (bead legend-alovk, Arah A). Renders the exported,
// presentational `PanicAlertScreen` from
// `apps/web/src/features/facility-staff/components/panic-alert-layer.tsx` with
// renderToStaticMarkup, from docs/briefs/sub-panic-alert-ui.md section C (not
// from the implementation). The state is built with the real queue reducer.
//
// Assumptions where the brief is silent:
//  - Props: { state, resolveLocation(item) => { code: string | null, area },
//    onAck, onDismiss, pinHref, formatTime(iso) => string }; a null code means
//    the unit is unknown and the screen shows "Lokasi belum diketahui".
//  - The layer's hooks (usePanicAlerts, useUnitBoard) and the router Link are
//    stubbed; they are not under test here.
//  - Text is checked against the Indonesian wording written in the brief.
//  - A fullscreen overlay is a <dialog>; the idle state renders no <dialog>.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const ts = rootRequire("typescript");
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
globalThis.__panicTestReact = React;

const webRoot = new URL("../apps/web/src/", import.meta.url);
const layerUrl = new URL(
  "features/facility-staff/components/panic-alert-layer.tsx",
  webRoot,
).href;
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

const PIN_HREF = "/pos/ganti-pengguna";
const OUTLET = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1b01";
const A = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1a01";
const B = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1a02";
const C = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1a03";
const UNIT_ID = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1c01";
const UNIT = {
  [A]: "Ruang 07",
  [B]: "Ruang 12",
  [C]: "Ruang 03",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === layerUrl) {
      if (specifier === "@tanstack/react-router") {
        return {
          url: stub(
            [
              "const R = globalThis.__panicTestReact;",
              "export const Link = ({ to, href, children, ...rest }) => R.createElement('a', { href: to ?? href, ...rest }, children);",
              "export const useNavigate = () => () => {};",
              "export const useRouter = () => ({});",
            ].join("\n"),
          ),
          shortCircuit: true,
        };
      }
      if (specifier === "@/lib/tenant-context") {
        return {
          url: stub(
            "export const useOutletClock = () => ({ timeZone: 'Asia/Jakarta' });",
          ),
          shortCircuit: true,
        };
      }
      if (/use-panic-alerts(\.ts)?$/.test(specifier)) {
        // PanicAlertScreen never calls the hook; PanicAlertLayer tests set
        // globalThis.__panicLayerHooks.usePanicAlerts().
        return {
          url: stub(
            "export const usePanicAlerts = () => { const h = globalThis.__panicLayerHooks?.usePanicAlerts; if (!h) throw new Error('hook not used by PanicAlertScreen'); return h(); };",
          ),
          shortCircuit: true,
        };
      }
      if (/(^|\/)hooks(\.ts)?$/.test(specifier)) {
        return {
          url: stub(
            [
              "export const useUnitBoard = () => globalThis.__panicLayerHooks?.useUnitBoard?.() ?? ({ data: undefined, isPending: true });",
              "export const useStaffFacility = () => globalThis.__panicLayerHooks?.useStaffFacility?.() ?? ({ facility: undefined, config: { data: undefined } });",
            ].join("\n"),
          ),
          shortCircuit: true,
        };
      }
    }
    if (specifier.startsWith("@/")) {
      const target = new URL(specifier.slice(2), webRoot);
      const extension = [".tsx", ".ts"].find((suffix) =>
        existsSync(`${fileURLToPath(target)}${suffix}`),
      );
      if (extension) return nextResolve(`${target.href}${extension}`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { PanicAlertScreen, PanicAlertLayer } = await import(layerUrl);
const queue = await import(
  new URL("features/facility-staff/panic-queue.ts", webRoot).href
);

function frame(alertId, extra = {}) {
  return {
    type: "panic",
    alertId,
    outletId: OUTLET,
    unitId: alertId,
    unitCode: null,
    areaName: null,
    receivedAt: "2026-11-14T03:00:00.000Z",
    kind: "press",
    ...extra,
  };
}

function build(actions) {
  return actions.reduce(
    (s, a) => queue.panicQueueReducer(s, a),
    queue.initialPanicQueue,
  );
}
const alert = (id, extra) => ({ type: "alert", frame: frame(id, extra) });
const status = (s) => ({ type: "status", status: s });

function render(state, overrides = {}) {
  return renderToStaticMarkup(
    React.createElement(PanicAlertScreen, {
      state,
      resolveLocation: (item) =>
        UNIT[item.alertId]
          ? { code: UNIT[item.alertId], area: "Lantai 1" }
          : { code: null, area: "" },
      onAck() {},
      onDismiss() {},
      pinHref: PIN_HREF,
      formatTime: () => "10.00",
      ...overrides,
    }),
  );
}

function text(markup) {
  return markup
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function buttons(markup) {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(
    (m) => ({
      attrs: m[1],
      label: text(m[2]),
      // Unavailable = native disabled or aria-disabled (the layer keeps the
      // button focusable while sending, so aria-disabled is what users get).
      disabled:
        /\sdisabled(?:=""|\s|$)/.test(m[1]) ||
        /aria-disabled="true"/.test(m[1]),
      busy: /aria-busy="true"/.test(m[1]),
    }),
  );
}

// Label of facilityStaff.panic.close.
const CLOSE = "Kembali ke pemantauan";

const BANNER =
  "Koneksi terputus, mencoba menyambung. Alert di bawah mungkin bukan yang terbaru.";

test("idle: no overlay is rendered", () => {
  const markup = render(build([status("open")]));
  assert.ok(!/<dialog/.test(markup));
  assert.ok(!text(markup).includes("Saya tangani"));
});

test("single alert: full-screen dialog with room name, Darurat label, time and the main button", () => {
  const markup = render(build([status("open"), alert(A)]));
  const t = text(markup);
  assert.match(markup, /<dialog\b/);
  assert.match(t, /darurat/i, "visible 'darurat' text, not colour alone");
  assert.ok(t.includes("Ruang 07"));
  assert.ok(!t.includes("UJI"), "a real press is not labelled as a test");
  assert.ok(t.includes("10.00"));
  // The project utility `tabular` is tabular-nums (globals.css); accept both.
  assert.match(
    markup,
    /<[^>]*class="[^"]*\btabular(?:-nums)?\b[^"]*"[^>]*>\s*(?:<!--[\s\S]*?-->)?[^<]*10\.00/,
    "received time uses tabular numerals",
  );
  assert.match(markup, /aria-live="assertive"/);
  const main = buttons(markup).filter((b) => b.label === "Saya tangani");
  assert.equal(main.length, 1);
  assert.equal(main[0].disabled, false);
  assert.ok(
    !t.includes(BANNER),
    "no connection banner while the connection is open",
  );
});

test("a test alert is marked UJI", () => {
  const markup = render(build([status("open"), alert(A, { kind: "test" })]));
  assert.ok(text(markup).includes("UJI"));
});

test("alert whose location cannot be resolved still shows a usable message", () => {
  const markup = render(build([status("open"), alert(A, { unitId: null })]), {
    resolveLocation: () => ({ code: null, area: "" }),
  });
  assert.ok(text(markup).includes("Lokasi belum diketahui"));
  assert.equal(
    buttons(markup).filter((b) => b.label === "Saya tangani").length,
    1,
  );
});

test("queue: numbered cards in arrival order, one main button on the first card only", () => {
  const markup = render(
    build([
      status("open"),
      alert(A),
      alert(B, { receivedAt: "2026-11-14T02:00:00.000Z" }),
      alert(C, { receivedAt: "2026-11-14T01:00:00.000Z" }),
    ]),
  );
  const t = text(markup);
  for (const n of ["01", "02", "03"]) assert.ok(t.includes(n), `card ${n}`);
  assert.ok(
    t.indexOf("01") < t.indexOf("02") && t.indexOf("02") < t.indexOf("03"),
  );
  const iA = t.indexOf("Ruang 07");
  const iB = t.indexOf("Ruang 12");
  const iC = t.indexOf("Ruang 03");
  assert.ok(iA >= 0 && iA < iB && iB < iC, "rooms listed in arrival order");
  const labels = buttons(markup).map((b) => b.label);
  assert.equal(labels.filter((l) => l === "Saya tangani").length, 1);
  assert.ok(labels.includes("Saya tangani Ruang 12"));
  assert.ok(labels.includes("Saya tangani Ruang 03"));
  assert.ok(
    !labels.includes("Saya tangani Ruang 07"),
    "the first card has the main button, not the outline one",
  );
  assert.ok(
    t.includes("Menangani satu alert tidak menyelesaikan alert lainnya."),
  );
});

test("a second alert does not replace the one being read", () => {
  const one = text(render(build([status("open"), alert(A)])));
  const two = text(render(build([status("open"), alert(A), alert(B)])));
  assert.ok(one.includes("Ruang 07"));
  assert.ok(two.includes("Ruang 07"));
  assert.ok(two.includes("Ruang 12"));
  assert.ok(two.indexOf("Ruang 07") < two.indexOf("Ruang 12"));
});

test("sending: the button is disabled and says Mengirim…", () => {
  const markup = render(
    build([status("open"), alert(A), { type: "ack-start", alertId: A }]),
  );
  const sending = buttons(markup).filter((b) => b.label.includes("Mengirim"));
  assert.equal(sending.length, 1);
  assert.equal(sending[0].disabled, true);
  assert.equal(sending[0].busy, true, "sending is announced as busy");
  assert.ok(text(markup).includes("Mengirim…"));
});

test("failed: the alert stays on screen with a retry button, never shown as handled", () => {
  const markup = render(
    build([
      status("open"),
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-failed", alertId: A },
    ]),
  );
  const t = text(markup);
  assert.ok(t.includes("Ruang 07"));
  const retry = buttons(markup).filter((b) => b.label.includes("Coba lagi"));
  assert.equal(retry.length, 1);
  assert.equal(retry[0].disabled, false, JSON.stringify(buttons(markup)));
  assert.ok(!t.includes("Anda menuju Ruang 07"));
});

test("session lost: the alert stays and points to the PIN screen", () => {
  const markup = render(
    build([
      status("open"),
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-session", alertId: A },
    ]),
  );
  assert.ok(text(markup).includes("Ruang 07"));
  assert.ok(markup.includes(`href="${PIN_HREF}"`), "link to the PIN screen");
  assert.ok(!text(markup).includes("Anda menuju Ruang 07"));
});

test("acknowledged by me: says I am heading to the room, not that it is done, with the close button", () => {
  const markup = render(
    build([
      status("open"),
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-ok", alertId: A },
    ]),
  );
  const t = text(markup);
  assert.ok(t.includes("Anda menuju Ruang 07"));
  assert.ok(
    t.includes("Belum dinyatakan selesai"),
    "settled shows the Kondisi row: responded, not declared finished",
  );
  assert.ok(t.includes("Sudah direspons"));
  assert.ok(
    !/\bselesai\b/i.test(t.replace(/Belum dinyatakan selesai/gi, "")),
    "must not claim the alert is finished",
  );
  assert.equal(buttons(markup).filter((b) => b.label === CLOSE).length, 1);
  assert.equal(
    buttons(markup).filter((b) => b.label === "Saya tangani").length,
    0,
  );
});

test("taken by a colleague (409): says so without a name, with the close button", () => {
  const markup = render(
    build([
      status("open"),
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-taken", alertId: A },
    ]),
  );
  const t = text(markup);
  assert.ok(t.includes("Sudah ditangani rekan lain"));
  assert.ok(!t.includes("Anda menuju Ruang 07"));
  assert.equal(buttons(markup).filter((b) => b.label === CLOSE).length, 1);
});

test("closed settled alert leaves no overlay", () => {
  const markup = render(
    build([
      status("open"),
      alert(A),
      { type: "ack-ok", alertId: A },
      { type: "dismiss", alertId: A },
    ]),
  );
  assert.ok(!/<dialog/.test(markup));
});

test("reconnecting with an alert: banner above the still-visible alert", () => {
  const markup = render(build([alert(A), status("reconnecting")]));
  const t = text(markup);
  assert.ok(t.includes(BANNER));
  assert.ok(t.includes("Ruang 07"));
  assert.ok(t.indexOf(BANNER) < t.indexOf("Ruang 07"), "banner is on top");
  assert.equal(
    buttons(markup).filter((b) => b.label === "Saya tangani").length,
    1,
  );
});

test("unreachable with an alert: same banner, alert still shown", () => {
  const markup = render(build([alert(A), status("unreachable")]));
  const t = text(markup);
  assert.ok(t.includes(BANNER));
  assert.ok(t.includes("Ruang 07"));
});

test("unreachable without an alert: a screen with a link button to the PIN screen", () => {
  const markup = render(build([status("unreachable")]));
  assert.match(markup, /<dialog\b/);
  assert.ok(markup.includes(`href="${PIN_HREF}"`));
  assert.ok(!text(markup).includes("Saya tangani"));
});

test("revoked: states the device stopped receiving alerts and points to another active device", () => {
  const markup = render(build([status("open"), status("revoked")]));
  const t = text(markup);
  assert.match(markup, /<dialog\b/);
  assert.ok(t.includes("Perangkat ini berhenti menerima alert darurat."));
  assert.match(t, /perangkat\b.*\blain\b.*\baktif/i);
  assert.equal(
    buttons(markup).filter((b) => b.label.includes("Saya tangani")).length,
    0,
  );
});

test("revoked: offers a link to the PIN screen and a close button", () => {
  const markup = render(build([status("open"), status("revoked")]));
  assert.match(
    markup,
    new RegExp(`<a\\b[^>]*data-slot="panic-revoked-pin"[^>]*>`),
  );
  const link = /<a\b[^>]*data-slot="panic-revoked-pin"[^>]*>/.exec(markup)[0];
  assert.ok(link.includes(`href="${PIN_HREF}"`), "PIN link target");
  assert.equal(buttons(markup).filter((b) => b.label === CLOSE).length, 1);
});

const UNKNOWN = () => ({ code: null, area: "" });

test("queue with unknown locations: ack buttons name the alert by arrival number, never the unknown-location text", () => {
  const markup = render(
    build([
      status("open"),
      alert(A, { unitId: null }),
      alert(B, { unitId: null }),
      alert(C, { unitId: null }),
    ]),
    { resolveLocation: UNKNOWN },
  );
  const labels = buttons(markup).map((b) => b.label);
  assert.equal(labels.filter((l) => l === "Saya tangani").length, 1);
  assert.ok(labels.includes("Saya tangani alert 02"), labels.join("|"));
  assert.ok(labels.includes("Saya tangani alert 03"), labels.join("|"));
  for (const label of labels)
    assert.ok(
      !label.includes("Lokasi belum diketahui"),
      `button label must not embed the unknown text: ${label}`,
    );
  const t = text(markup);
  for (const n of ["01", "02", "03"]) assert.ok(t.includes(n));
});

test("queue numbering follows item.order, not the position in the list", () => {
  const markup = render(
    build([
      status("open"),
      alert(A, { unitId: null }),
      alert(B, { unitId: null }),
      alert(C, { unitId: null }),
      { type: "ack-start", alertId: A },
      { type: "ack-ok", alertId: A },
      { type: "dismiss", alertId: A },
    ]),
    { resolveLocation: UNKNOWN },
  );
  const labels = buttons(markup).map((b) => b.label);
  assert.equal(labels.filter((l) => l === "Saya tangani").length, 1);
  assert.ok(
    labels.includes("Saya tangani alert 03"),
    `C keeps its arrival number 03: ${labels.join("|")}`,
  );
  assert.ok(!labels.includes("Saya tangani alert 02"));
  assert.ok(!labels.includes("Saya tangani alert 01"));
});

test("acknowledged alert with unknown location: heading uses the alert number, not the unknown-location text", () => {
  const markup = render(
    build([
      status("open"),
      alert(A, { unitId: null }),
      alert(B, { unitId: null }),
      { type: "ack-ok", alertId: A },
      { type: "dismiss", alertId: A },
      { type: "ack-start", alertId: B },
      { type: "ack-ok", alertId: B },
    ]),
    { resolveLocation: UNKNOWN },
  );
  const heading = /<h\d\b[^>]*>([\s\S]*?)<\/h\d>/g;
  const headings = [...markup.matchAll(heading)].map((m) => text(m[1]));
  const mine = headings.find((h) => h.startsWith("Anda menuju"));
  assert.equal(mine, "Anda menuju lokasi alert 02", headings.join("|"));
  assert.ok(!mine.includes("Lokasi belum diketahui"));
});

test("revoked stays on screen even if a later status says open or an alert arrives", () => {
  const markup = render(build([status("revoked"), status("open"), alert(A)]));
  assert.ok(
    text(markup).includes("Perangkat ini berhenti menerima alert darurat."),
  );
});

test("motion is only enabled behind motion-safe and nothing blinks", () => {
  const markups = [
    render(build([status("open"), alert(A)])),
    render(build([status("open"), alert(A), alert(B), alert(C)])),
    render(build([alert(A), status("reconnecting")])),
    render(build([status("revoked")])),
    render(build([status("unreachable")])),
  ];
  for (const markup of markups) {
    for (const [, classes] of markup.matchAll(/class="([^"]*)"/g)) {
      for (const token of classes.split(/\s+/)) {
        if (/(^|:)animate-/.test(token)) {
          assert.ok(
            token.startsWith("motion-safe:") || /(^|:)motion-safe:/.test(token),
            `animation class must be motion-safe: ${token}`,
          );
        }
        assert.ok(!/blink/.test(token), `no blinking: ${token}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// legend-jztb7: the alert frame now carries unitCode / areaName, and a colleague
// who took the alert is named. Written from docs/briefs/sub-panic-alert-wiring.md
// section F, not from the implementation.
//
// Assumptions: `resolveLocation` lives inside PanicAlertLayer (not exported), so
// the location rule is tested through PanicAlertLayer with its hooks stubbed
// (globalThis.__panicLayerHooks); the wording "{name} sudah menuju lokasi" is the
// brief's own text.

function renderLayer({ state, board } = {}) {
  globalThis.__panicLayerHooks = {
    usePanicAlerts: () => ({ state, ack: async () => {}, dismiss() {} }),
    useUnitBoard: () => ({
      data: board ? { rows: board.rows } : undefined,
      isPending: false,
    }),
    useStaffFacility: () => ({
      facility: board ? { id: "facility-1" } : undefined,
      config: { data: board ? { areas: board.areas } : undefined },
    }),
  };
  try {
    return renderToStaticMarkup(React.createElement(PanicAlertLayer, {}));
  } finally {
    delete globalThis.__panicLayerHooks;
  }
}

test("legend-mm029 layer recovery link requests the emergency PIN session flow", () => {
  const markup = renderLayer({ state: build([status("unreachable")]) });
  assert.ok(
    markup.includes('href="/pos/ganti-pengguna?emergency=true"'),
    markup,
  );
});

test("location: unitCode and areaName from the frame are shown without the unit board", () => {
  const markup = renderLayer({
    state: build([
      status("open"),
      alert(A, { unitId: UNIT_ID, unitCode: "P2", areaName: "Area Pria" }),
    ]),
  });
  const t = text(markup);
  assert.ok(t.includes("P2"), t);
  assert.ok(t.includes("Area Pria"), t);
  assert.ok(!t.includes("Lokasi belum diketahui"), t);
});

test("location: the frame wins over the unit board mapping", () => {
  const markup = renderLayer({
    state: build([
      status("open"),
      alert(A, { unitId: UNIT_ID, unitCode: "P2", areaName: "Area Pria" }),
    ]),
    board: {
      rows: [{ unit: { id: UNIT_ID, code: "W9", areaId: "area-w" } }],
      areas: [{ id: "area-w", name: "Area Wanita" }],
    },
  });
  const t = text(markup);
  assert.ok(t.includes("P2"), t);
  assert.ok(!t.includes("W9"), t);
  assert.ok(!t.includes("Area Wanita"), t);
});

test("location: without unitCode the unit board mapping is the fallback", () => {
  const markup = renderLayer({
    state: build([status("open"), alert(A, { unitId: UNIT_ID })]),
    board: {
      rows: [{ unit: { id: UNIT_ID, code: "W9", areaId: "area-w" } }],
      areas: [{ id: "area-w", name: "Area Wanita" }],
    },
  });
  const t = text(markup);
  assert.ok(t.includes("W9"), t);
  assert.ok(t.includes("Area Wanita"), t);
});

test("location: no unitCode and no board row still says the location is unknown", () => {
  const markup = renderLayer({
    state: build([status("open"), alert(A, { unitId: UNIT_ID })]),
  });
  assert.ok(text(markup).includes("Lokasi belum diketahui"));
});

test("taken by a named colleague (realtime frame): 'Rina sudah menuju lokasi' with the close button", () => {
  const markup = render(
    build([
      status("open"),
      alert(A),
      {
        type: "acknowledged",
        frame: {
          type: "acknowledged",
          alertId: A,
          acknowledgedAt: "2026-11-14T03:00:05.000Z",
          byName: "Rina",
        },
      },
    ]),
  );
  const t = text(markup);
  assert.ok(t.includes("Rina sudah menuju lokasi"), t);
  assert.ok(!t.includes("Sudah ditangani rekan lain"), t);
  assert.ok(!t.includes("Anda menuju Ruang 07"));
  assert.equal(buttons(markup).filter((b) => b.label === CLOSE).length, 1);
});

test("taken by a named colleague (409 with acknowledgedBy): the name is shown", () => {
  const markup = render(
    build([
      status("open"),
      alert(A),
      { type: "ack-start", alertId: A },
      {
        type: "ack-taken",
        alertId: A,
        byName: "Dewi",
        at: "2026-11-14T03:00:07.000Z",
      },
    ]),
  );
  const t = text(markup);
  assert.ok(t.includes("Dewi sudah menuju lokasi"), t);
  assert.ok(!t.includes("Sudah ditangani rekan lain"), t);
});

test("taken without a known name keeps the 'rekan lain' wording", () => {
  const markup = render(
    build([
      status("open"),
      alert(A),
      { type: "sync", alerts: [], knownBefore: [A] },
    ]),
  );
  const t = text(markup);
  assert.ok(t.includes("Sudah ditangani rekan lain"), t);
  assert.equal(buttons(markup).filter((b) => b.label === CLOSE).length, 1);
});
