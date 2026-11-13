/**
 * Fixed list of Bank Indonesia bank codes (3 digits) that HR may record on an
 * employee (`employees.bank_code`). A code outside this list is rejected, so a
 * typo can never reach a payroll transfer file. The payroll manual channel
 * currently accepts only BCA (`014`); the rest are stored for later channels.
 */
export const HRIS_BANK_CODES = [
  "002", // BRI
  "008", // Mandiri
  "009", // BNI
  "011", // Danamon
  "013", // Permata
  "014", // BCA
  "016", // Maybank
  "019", // Panin
  "022", // CIMB Niaga
  "023", // UOB
  "028", // OCBC NISP
  "031", // Citibank
  "037", // Artha Graha
  "046", // DBS
  "050", // Standard Chartered
  "087", // HSBC
  "110", // BJB
  "111", // Bank DKI
  "114", // Bank Jatim
  "147", // Muamalat
  "153", // Sinarmas
  "200", // BTN
  "213", // BTPN
  "426", // Mega
  "451", // BSI
  "490", // Bank Neo Commerce
  "501", // Blu by BCA Digital
  "535", // SeaBank
  "542", // Jago
] as const;
export type HrisBankCode = (typeof HRIS_BANK_CODES)[number];
