// Bank names for the BI codes HR may record on an employee. The code list is
// the contract's (`HRIS_BANK_CODES`); this map only adds the proper-noun name
// the picker shows. `Record<HrisBankCode, …>` fails the typecheck when the
// contract adds a code without a name here.
import { HRIS_BANK_CODES } from "@starter/shared/hris";
import type { HrisBankCode } from "@starter/shared/hris";

export const BANK_NAME: Record<HrisBankCode, string> = {
  "002": "BRI",
  "008": "Mandiri",
  "009": "BNI",
  "011": "Danamon",
  "013": "Permata",
  "014": "BCA",
  "016": "Maybank",
  "019": "Panin",
  "022": "CIMB Niaga",
  "023": "UOB",
  "028": "OCBC NISP",
  "031": "Citibank",
  "037": "Artha Graha",
  "046": "DBS",
  "050": "Standard Chartered",
  "087": "HSBC",
  "110": "BJB",
  "111": "Bank DKI",
  "114": "Bank Jatim",
  "147": "Muamalat",
  "153": "Sinarmas",
  "200": "BTN",
  "213": "BTPN",
  "426": "Mega",
  "451": "BSI",
  "490": "Bank Neo Commerce",
  "501": "Blu by BCA Digital",
  "535": "SeaBank",
  "542": "Jago",
};

/** "BCA (014)": what both the picker and the profile row show. */
export function bankCodeLabel(code: HrisBankCode): string {
  return `${BANK_NAME[code]} (${code})`;
}

/** Alphabetical by name, so keyboard type-ahead lands on the bank name. */
export const BANK_OPTIONS: readonly HrisBankCode[] = [...HRIS_BANK_CODES].sort(
  (a, b) => BANK_NAME[a].localeCompare(BANK_NAME[b], "id"),
);
