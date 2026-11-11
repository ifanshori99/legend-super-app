// Each refund suite owns its tenant, policy matrix, integration and sweep queue.
// Sharing Cafe Legend let one worker delete another's policies or sweep its
// refunds through the wrong fake gateway (legend-xu9he). No global test lock.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { tenantIdSchema } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

export function paymentTestScope() {
  const tenantId = tenantIdSchema.parse(randomUUID());
  const brandId = randomUUID();
  const legalEntityId = randomUUID();
  const outletId = randomUUID();
  const otherOutletId = randomUUID();
  const hostname = `refund-${tenantId}.example.test`;

  async function seed(owner: Pool) {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    const sourceTenantId = cafeLegendPlatformFixtures.tenant.id;
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Refund test', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
      [tenantId, `refund-${tenantId}`, sourceTenantId],
    );
    await owner.query(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Refund test')",
      [brandId, tenantId, `refund-${tenantId}`],
    );
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Refund test', false)",
      [legalEntityId, tenantId],
    );
    for (const [id, code] of [
      [outletId, "REFUND-A"],
      [otherOutletId, "REFUND-B"],
    ])
      await owner.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
         VALUES ($1, $2, $3, $4, $5, 'Refund test', 'Test', '{}')`,
        [id, tenantId, brandId, legalEntityId, code],
      );
    await owner.query(
      `INSERT INTO tenant_domains (tenant_id, brand_id, hostname, kind, tls_status, verified_at)
       VALUES ($1, $2, $3, 'custom', 'active', now())`,
      [tenantId, brandId, hostname],
    );
    // Preserve the seeded permission and default approval behavior, but every
    // role and policy gets a new id owned by this suite's tenant.
    await owner.query(
      `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       SELECT $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $2 AND is_template`,
      [tenantId, sourceTenantId],
    );
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       SELECT $1, p.action_type, p.threshold_idr, target.id, p.levels, p.requires_distinct_actor
       FROM approval_policies p
       JOIN roles source ON source.id = p.approver_role_id
       JOIN roles target ON target.tenant_id = $1 AND target.template_key = source.template_key
       WHERE p.tenant_id = $2`,
      [tenantId, sourceTenantId],
    );
  }

  // The disposable database owns these small fixture rows until its teardown.
  // Keeping them avoids deleting append-only audit/event records or disabling
  // shared guards. Each suite still cleans up its payment rows as before.
  return { tenantId, outletId, otherOutletId, hostname, seed };
}
