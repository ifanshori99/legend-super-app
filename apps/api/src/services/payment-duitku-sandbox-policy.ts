// 1269 C0 (legend-osqou.1): where a Duitku sandbox account counts. A sandbox
// "paid" is not money, so the adapter and the integration store share this rule.
import { env } from "../config/env";

/**
 * True when a sandbox account is refused: always in production mode or with
 * real data, and in any production build without the staging switch.
 */
export function duitkuSandboxRefused(): boolean {
  return (
    env.DEPLOYMENT_MODE === "production" ||
    env.DATA_CLASSIFICATION === "real" ||
    (env.isProduction && !env.DUITKU_ALLOW_SANDBOX)
  );
}
