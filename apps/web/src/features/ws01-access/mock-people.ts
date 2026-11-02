// Mock-mode people directory: the staff accounts in the access fixtures. This
// module is imported only from the `VITE_API_MOCK` branch of people.ts, so a
// normal build compiles it (and the fixtures) out.
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import type { AssignablePerson } from "./people.ts";

export function mockAssignablePeople(): AssignablePerson[] {
  return Object.values(cafeLegendAccessFixtures.users)
    .map((user) => ({
      id: user.id,
      name: user.displayName,
      kind: "staff" as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
}
