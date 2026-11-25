// 1269 F0: only shower facilities are closed in the web app; coworking, lockers
// and meeting rooms keep every screen, and the emergency screen never goes dark.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) =>
  readFileSync(new URL(`../apps/web/src/${path}`, import.meta.url), "utf8");
const pick = await import(
  "../apps/web/src/features/facility-staff/staff-facility.ts"
).catch(() => ({}));

const shower = { id: "shower", type: "shower" };
const wfc = { id: "wfc", type: "coworking" };
const locker = { id: "locker", type: "locker" };

test("1269 F0 the emergency PIN lands on the emergency screen, not the board", () => {
  const source = read(
    "features/ws01-device-pin/components/switch-user-screen.tsx",
  );
  const branch = source.slice(source.indexOf("if (emergency) {"));
  const target = /to: "([^"]+)"/.exec(branch)?.[1];
  assert.equal(target, "/fasilitas/darurat");
  assert.match(branch, /returnFacilityId \? \{ facilityId/);
});

test("1269 F0 emergency links to the board and incidents follow the facility type", () => {
  const { boardFacility } = pick;
  // Mixed outlet: the links point at the open facility, never at the shower.
  assert.equal(boardFacility([shower, wfc], shower)?.id, "wfc");
  assert.equal(boardFacility([shower, wfc], wfc)?.id, "wfc");
  assert.equal(boardFacility([shower, locker], null)?.id, "locker");
  // Shower-only outlet: no board to open.
  assert.equal(boardFacility([shower], shower), null);

  const screen = read("features/facility-staff/components/emergency-screen.tsx");
  assert.doesNotMatch(screen, /search=\{\{ facilityId(: facility\.id)? \}\}/);
  assert.match(read("features/facility-staff/components/staff-chrome.tsx"), /boardsOpen/);
});

test("1269 F0 the board opens released facilities only; the emergency screen opens all", () => {
  const { pickStaffFacility } = pick;
  assert.equal(
    pickStaffFacility([shower, wfc], undefined, { releasedOnly: true })?.id,
    "wfc",
  );
  // A named shower is refused, never swapped for another facility.
  assert.equal(
    pickStaffFacility([shower, wfc], "shower", { releasedOnly: true }),
    null,
  );
  assert.equal(
    pickStaffFacility([wfc, locker], "locker", { releasedOnly: true })?.id,
    "locker",
  );
  assert.equal(
    pickStaffFacility([shower], undefined, { releasedOnly: true }),
    null,
  );
  assert.equal(pickStaffFacility([wfc, shower], "shower")?.id, "shower");
  assert.equal(pickStaffFacility([shower], undefined)?.id, "shower");
});

test("1269 F0 no staff or guest facility route is closed for every type", () => {
  for (const path of [
    "routes/_ops/fasilitas.index.tsx",
    "routes/_ops/fasilitas.kebersihan.tsx",
    "routes/_ops/fasilitas.insiden.tsx",
    "routes/_customer/f.$facility.tsx",
  ])
    assert.doesNotMatch(read(path), /showerGate/, path);
  assert.doesNotMatch(read("features/facility-staff/nav.ts"), /showerOnly/);
});
