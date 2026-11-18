-- gate: legend-176r3
-- before: 0456_mcp_flag_backfill
-- requires: public.tenants, public.platform_packages, public.mcp_clients, public.mcp_tokens
-- mode: block
-- resolve: Pindahkan tenant yang tercantum ke paket yang memuat mcp atau cabut klien dan token MCP-nya, lalu jalankan ulang gerbang; jangan menyalakan mcp di luar paket.
-- Tenant aktif yang sudah memakai MCP (klien approved atau token aktif) tetapi
-- paketnya tidak memuat mcp: migrasi 0456 tidak menyalakan flag mcp untuknya,
-- jadi MCP-nya terkunci setelah rilis. Paket yang barisnya tidak ada dihitung
-- tanpa mcp. Bentuk modules yang bukan array juga menahan rilis: data paket
-- yang rusak tidak membuktikan hak MCP. Keluaran hanya id tenant dan jumlah;
-- nol baris berarti lolos.
SELECT
  t.id AS tenant_id,
  (
    SELECT count(*) FROM mcp_clients c
    WHERE c.tenant_id = t.id AND c.status = 'approved'
  ) AS approved_client_count,
  (
    SELECT count(*) FROM mcp_tokens k
    WHERE k.tenant_id = t.id AND k.revoked_at IS NULL AND k.expires_at > now()
  ) AS active_token_count
FROM tenants t
LEFT JOIN platform_packages p ON p.key = t.plan
WHERE t.status = 'active'
  AND (
    p.key IS NULL
    OR jsonb_typeof(p.modules) IS DISTINCT FROM 'array'
    OR (p.modules ? 'mcp') IS NOT TRUE
  )
  AND (
    EXISTS (
      SELECT 1 FROM mcp_clients c
      WHERE c.tenant_id = t.id AND c.status = 'approved'
    )
    OR EXISTS (
      SELECT 1 FROM mcp_tokens k
      WHERE k.tenant_id = t.id AND k.revoked_at IS NULL AND k.expires_at > now()
    )
  )
ORDER BY t.id;
