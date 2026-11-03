// Query options for the HPP reports. Each report is a cursor list the screens
// read at once, so the options follow the cursor to its last page (queries.ts
// `allPagesQuery`); the key stays under the endpoint id, so invalidating
// `[endpoint.id]` refreshes every period.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  listFoodCostComparisons,
  listMenuCosts,
  listMenuEngineering,
  listRecipeCoverage,
} from "@starter/shared/inventory";
import { allPagesQuery } from "./queries.ts";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

export const menuCostsQuery = (query: Query<typeof listMenuCosts>) =>
  allPagesQuery(listMenuCosts, query);

export const foodCostQuery = (query: Query<typeof listFoodCostComparisons>) =>
  allPagesQuery(listFoodCostComparisons, query);

export const engineeringQuery = (query: Query<typeof listMenuEngineering>) =>
  allPagesQuery(listMenuEngineering, query);

export const coverageQuery = (query: Query<typeof listRecipeCoverage>) =>
  allPagesQuery(listRecipeCoverage, query);
