-- gate: legend-oh2a5
-- before: 0378_ai_assistant_auto_enable
-- requires: public.tenants, public.platform_packages, public.ai_usage_events, public.ai_messages
-- mode: info
-- resolve: Informasi saja: catat jumlahnya sebagai perkiraan tenant yang dinyalakan otomatis ai_assistant oleh 0378, dan bandingkan dengan jumlah audit tenant.module_auto_enabled setelah migrasi.
-- Jumlah tenant yang akan dinyalakan modul ai_assistant oleh 0378. Predikatnya
-- sama dengan CTE eligible di migrasi: tenant aktif, paket aktif yang memuat
-- ai_assistant, modules berupa array tanpa ai_assistant, dan sudah memakai AI
-- (ai_usage_events ok di channel tanya_ai atau mcp, atau pesan user di
-- ai_messages). Keluaran satu baris per tenant (hanya id), jadi jumlah baris
-- sama dengan jumlah tenant yang akan dinyalakan.
SELECT t.id AS tenant_id
FROM tenants t
JOIN platform_packages p ON p.key = t.plan
WHERE t.status = 'active'
  AND p.status = 'active'
  AND p.modules ? 'ai_assistant'
  AND jsonb_typeof(t.feature_flags -> 'modules') = 'array'
  AND NOT (t.feature_flags -> 'modules') ? 'ai_assistant'
  AND (
    EXISTS (
      SELECT 1 FROM ai_usage_events e
      WHERE e.tenant_id = t.id
        AND e.status = 'ok'
        AND e.channel IN ('tanya_ai', 'mcp')
    )
    OR EXISTS (
      SELECT 1 FROM ai_messages m
      WHERE m.tenant_id = t.id AND m.role = 'user'
    )
  )
ORDER BY t.id;
