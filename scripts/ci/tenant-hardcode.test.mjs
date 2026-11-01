import test from "node:test";
import assert from "node:assert/strict";
import { findTenantBranches } from "./tenant-hardcode.mjs";

test("TEN-07 rejects literal tenant ID, name and domain comparisons in branches", () => {
  const source = `
    if (tenant.id === 'cafe-123') serve();
    const x = tenantName == 'Legend' ? a : b;
    switch (tenant.domain) { case 'legend.example': serve(); }
    if ('legend.example' === request.hostname) serve();
  `;
  assert.equal(findTenantBranches(source, "example.ts").length, 4);
});

test("TEN-07 rejects alias and membership branches for a specific tenant", () => {
  const source = `
    const id = tenant.id;
    if (id === '123') serve();
    if (['legend', 'other'].includes(tenant.name)) serve();
    const { domain } = tenant;
    if (domain !== 'legend.example') serve();
  `;
  assert.equal(findTenantBranches(source, "example.ts").length, 3);
});

test("TEN-07 allows configurable tenant decisions and unrelated literals", () => {
  const source = `
    if (tenant.id === config.tenantId) serve();
    if (tenant.settings.enabled) serve();
    if (status === 'pending') serve();
    const sample = "if (tenant.id === 'example')";
    // if (tenant.id === 'example') serve();
  `;
  assert.deepEqual(findTenantBranches(source, "example.ts"), []);
});
