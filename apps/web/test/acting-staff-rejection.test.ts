// legend-f586w: a shared device that sent no cashier token gets REQUIRED. The
// PIN screen must open for it even on a GET (KDS boards are GETs), and it must
// be the screen of the active shell: /kds/ganti-pengguna for the kitchen,
// /pos/ganti-pengguna for the POS. Other codes keep their GET behaviour.
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { handleActingStaffRejection } from "@/lib/api/acting-staff";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

let assigned: string[];

function openAt(pathname: string) {
  assigned = [];
  vi.stubGlobal("window", {
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    location: { pathname, assign: (to: string) => assigned.push(to) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleActingStaffRejection", () => {
  it("sends a KDS GET answered REQUIRED to the KDS PIN screen", () => {
    openAt("/kds/papan");
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.REQUIRED, "GET");
    expect(assigned).toEqual(["/kds/ganti-pengguna"]);
  });

  it("sends a POS mutation answered REQUIRED to the POS PIN screen", () => {
    openAt("/pos/kasir");
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.REQUIRED, "POST");
    expect(assigned).toEqual(["/pos/ganti-pengguna"]);
  });

  it("does not redirect again from either PIN screen", () => {
    openAt("/kds/ganti-pengguna");
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.REQUIRED, "GET");
    openAt("/pos/ganti-pengguna");
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.REQUIRED, "POST");
    expect(assigned).toEqual([]);
  });

  it("keeps a refused GET of another code quiet (no PIN screen)", () => {
    openAt("/kds/papan");
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.EXPIRED, "GET");
    expect(assigned).toEqual([]);
  });
});
