// Mock handlers for the example endpoints in @starter/shared/api. They show
// the pattern every feature copies into features/<name>/mock.ts:
//   registerMock(endpoint, ({ params, query, body, scenario }) => wireResponse)
import {
  addExampleOrderLine,
  getExampleOutlet,
  listExampleOutlets,
  removeExampleOrderLine,
} from "@starter/shared/api";
import { cafeLegendFixtures, createUlidFactory } from "@starter/shared/core";
import { ApiError } from "../../api/errors.ts";
import { paginateFixture } from "../paginate.ts";
import { registerMock } from "../registry.ts";
import { createMockStore } from "../store.ts";

type Line = (typeof cafeLegendFixtures.orderLinesPage.data)[number];
type Created = { line: Line; fingerprint: string };

const lines = createMockStore<Line[]>(() => [
  ...cafeLegendFixtures.orderLinesPage.data,
]);
const idempotency = createMockStore(() => new Map<string, Created>());
const nextUlid = createUlidFactory();

registerMock(listExampleOutlets, ({ query, scenario }) =>
  paginateFixture(cafeLegendFixtures.outlets, query, (o) => o.id, scenario),
);

registerMock(getExampleOutlet, ({ params }) => {
  const outlet = cafeLegendFixtures.outlets.find(
    (o) => o.id === params.outletId,
  );
  if (!outlet) throw new ApiError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
  return { data: outlet };
});

registerMock(addExampleOrderLine, ({ body }) => {
  const fingerprint = JSON.stringify([
    body.name,
    body.quantity,
    body.unitPriceIdr,
  ]);
  const seen = idempotency.get().get(body.idempotencyKey);
  if (seen) {
    if (seen.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi sudah dipakai dengan isi yang berbeda.",
      );
    return { data: seen.line };
  }
  const line: Line = {
    id: nextUlid() as Line["id"],
    name: body.name,
    quantity: body.quantity,
    unitPriceIdr: body.unitPriceIdr,
    lineTotalIdr: (body.quantity * body.unitPriceIdr) as Line["lineTotalIdr"],
    coffeeGrams: null,
  };
  lines.get().push(line);
  idempotency.get().set(body.idempotencyKey, { line, fingerprint });
  return { data: line };
});

registerMock(removeExampleOrderLine, ({ params }) => {
  const index = lines.get().findIndex((line) => line.id === params.lineId);
  if (index === -1)
    throw new ApiError(404, "NOT_FOUND", "Baris pesanan tidak ditemukan.");
  lines.get().splice(index, 1);
});
