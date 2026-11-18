-- gate: legend-ir8n8
-- before: none
-- requires: public.edge_nodes
-- mode: block
-- resolve: Tahan rilis sampai pemetaan versi minimum ke build/image edge terpercaya direview dan dicerminkan pada gerbang ini, lalu upgrade node dan ulangi gerbang; bukti manual tidak menimpa hasil BLOCK dan upgrade saja belum cukup tanpa pemetaan tersebut.
-- edge_nodes.version hanya string dari heartbeat, tanpa bukti image/digest.
-- Belum ada pemetaan minimum build terpercaya untuk sharedMode: versi 0.2.0
-- sudah dipakai sebelum perbaikannya. Unknown, dev, versi kosong, maupun
-- semver yang lebih besar belum membuktikan kompatibilitas, jadi seluruh
-- node aktif ditahan, termasuk standby dan node offline. Jangan menebak
-- ambang semver atau mengubah version/cabut node untuk melewati gerbang.
-- before:none sengaja mempertahankan pemeriksaan setelah migrasi diterapkan.
SELECT id, tenant_id, outlet_id, role, version, last_heartbeat_at
FROM edge_nodes
WHERE status = 'active'
ORDER BY tenant_id, outlet_id, role, id;
