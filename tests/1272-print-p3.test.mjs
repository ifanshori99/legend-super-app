// P3 cetak dapur dari tablet KDS + laporan shift (legend-wasr7.4): the tablet
// asks the cloud for the bytes, sends them to its own printer, and asks for the
// "CETAK ULANG" mark on every later print of the same ticket or shift.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { printFromCloud } from "../apps/web/src/features/ws04-pos-kasir/print/cloud-print.ts";

const web = "apps/web/src/features/";
const read = (file) => readFileSync(web + file, "utf8");
const rawbt = { method: "rawbt", paperWidth: 32 };
const io = { openUrl: () => {}, printHtml: () => {} };

test("first send is original, the second and third are reprints", async () => {
  const sent = new Set();
  const asks = [];
  const load = async (ask) => {
    asks.push(ask);
    return {
      paperWidth: ask.paperWidth,
      escposBase64: "G0A=",
      reprint: ask.reprint,
    };
  };
  const one = await printFromCloud("t1", load, rawbt, io, sent);
  const two = await printFromCloud("t1", load, rawbt, io, sent);
  const other = await printFromCloud("t2", load, rawbt, io, sent);
  assert.deepEqual(asks, [
    { paperWidth: 32, reprint: false },
    { paperWidth: 32, reprint: true },
    { paperWidth: 32, reprint: false },
  ]);
  assert.deepEqual(
    [one.reprint, two.reprint, other.reprint],
    [false, true, false],
  );
});

test("a printer that fails is not remembered as sent", async () => {
  const sent = new Set();
  const bad = {
    openUrl: () => {
      throw new Error("no rawbt");
    },
    printHtml: () => {},
  };
  const load = async (ask) => ({
    paperWidth: 32,
    escposBase64: "G0A=",
    reprint: ask.reprint,
  });
  assert.equal(
    (await printFromCloud("t1", load, rawbt, bad, sent)).outcome,
    "failed",
  );
  assert.equal(
    (await printFromCloud("t1", load, rawbt, io, sent)).reprint,
    false,
  );
});

test("no printer asks the cloud for nothing; a failed fetch throws", async () => {
  let calls = 0;
  const load = async () => {
    calls += 1;
    throw new Error("403");
  };
  const none = await printFromCloud(
    "t1",
    load,
    { method: "none", paperWidth: 32 },
    io,
    new Set(),
  );
  assert.equal(none.outcome, "none");
  assert.equal(calls, 0);
  await assert.rejects(printFromCloud("t1", load, rawbt, io, new Set()));
  assert.equal(calls, 1);
});

test("wiring: KDS ticket card and supervisor closed shift print; blind view does not", () => {
  const kds = read("ws04-kds/components/kds-page.tsx");
  assert.match(kds, /<CloudPrintButton[\s\S]*?kind="ticket"/);
  const shift = read(
    "ws04-pos-kasir/components/supervisor/shift-approval-screen.tsx",
  );
  assert.match(shift, /review\.expectedIdr !== null && \(\s*<CloudPrintButton/);
});
