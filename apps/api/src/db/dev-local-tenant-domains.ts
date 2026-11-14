// Reserved synthetic seed ids, kept outside shared public-DNS fixtures. These
// rows are inserted only by the guarded development/test seed.
import { tenantDomainIdSchema } from "@starter/shared/platform";

export const DEV_LOCAL_TENANT_DOMAINS = [
  {
    id: tenantDomainIdSchema.parse("d0a10000-0000-4000-8000-000000000005"),
    hostname: "localhost",
  },
  {
    id: tenantDomainIdSchema.parse("d0a10000-0000-4000-8000-000000000006"),
    hostname: "127.0.0.1",
  },
] as const;
