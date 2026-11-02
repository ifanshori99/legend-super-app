import { useQuery } from "@tanstack/react-query";
import { customerDisplayQuery } from "./queries.ts";

// Hooks are the only way components touch this feature's data
// (docs/frontend.md, "Custom hooks"). The display is read-only: pairing is a
// terminal action, so this feature has no mutations.

export function useCustomerDisplay(terminalDeviceId?: string) {
  return useQuery(customerDisplayQuery(terminalDeviceId));
}
