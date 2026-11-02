// One QR renderer for the web app (bead legend-9fmm). Three beads had each
// brought their own library (qrcode, qrcode.react, uqr); this suite pins the
// consolidation: `uqr` encodes, `apps/web/src/lib/qr.ts` turns the module
// matrix into an SVG path, and no feature imports a second QR package.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { encodeQr, qrModulePath } from "../apps/web/src/lib/qr.ts";

const root = resolve(import.meta.dirname, "..");

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("legend-9fmm: the encoded matrix keeps a quiet zone on every side", () => {
  const qr = encodeQr("https://legend.test/t/v1.4f9c2a7b", { margin: 2 });
  // A QR matrix is 4v+17 modules; `margin` adds that many modules per side.
  assert.equal((qr.size - 2 * 2) % 4, 1);
  assert.equal(qr.data.length, qr.size);
  for (let y = 0; y < qr.size; y += 1)
    for (let x = 0; x < qr.size; x += 1) {
      const inQuietZone =
        x < 2 || y < 2 || x >= qr.size - 2 || y >= qr.size - 2;
      if (inQuietZone)
        assert.equal(qr.data[y][x], false, `dark module at ${x},${y}`);
    }
  assert.ok(qr.data.flat().filter(Boolean).length > 0, "payload is drawn");
});

test("legend-9fmm: the SVG path draws every dark module and is deterministic", () => {
  const payload = "00020101021226670016COM.LEGEND.WWW0118";
  const first = qrModulePath(payload, { level: "M", margin: 2 });
  const again = qrModulePath(payload, { level: "M", margin: 2 });
  assert.equal(first.path, again.path, "same payload, same path");
  assert.equal(first.size, again.size);

  const { data } = encodeQr(payload, { level: "M", margin: 2 });
  const drawn = [...first.path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)];
  assert.equal(drawn.length, data.flat().filter(Boolean).length);
  for (const [, x, y] of drawn)
    assert.equal(data[Number(y)][Number(x)], true, `path matches ${x},${y}`);
  // One path for the whole code: no per-module elements to hydrate.
  assert.equal(first.path.split("M").length - 1, drawn.length);
});

test("legend-9fmm: apps/web has one QR renderer and one dependency", () => {
  const pkg = JSON.parse(
    readFileSync(join(root, "apps/web/package.json"), "utf8"),
  );
  assert.equal(pkg.dependencies.uqr, "0.1.3");
  assert.equal(pkg.dependencies.qrcode, undefined);
  assert.equal(pkg.dependencies["qrcode.react"], undefined);
  assert.equal(pkg.devDependencies["@types/qrcode"], undefined);

  const imports = sourceFiles(join(root, "apps/web/src")).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return /from\s+["'](?:qrcode|qrcode\.react)["']/.test(source)
      ? [relative(root, file)]
      : [];
  });
  assert.deepEqual(imports, [], "features import components/ui/qr-code");

  const uqrUsers = sourceFiles(join(root, "apps/web/src")).flatMap((file) =>
    /from\s+["']uqr["']/.test(readFileSync(file, "utf8"))
      ? [relative(root, file)]
      : [],
  );
  assert.deepEqual(uqrUsers, ["apps/web/src/lib/qr.ts"]);

  for (const screen of [
    "apps/web/src/features/ws03-qr-order/components/cart/pay-page.tsx",
    "apps/web/src/features/ws03-floor-editor/components/qr-label.tsx",
    "apps/web/src/features/ws05-payment/components/payment-code.tsx",
    "apps/web/src/features/facility/components/access-ticket-qr.tsx",
  ])
    assert.match(
      readFileSync(join(root, screen), "utf8"),
      /@\/components\/ui\/qr-code/,
      `${screen} uses the shared renderer`,
    );
});
