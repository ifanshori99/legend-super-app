# 1060 Architect: desain status edge ke cloud (legend-uvnll) + layar node edge back-office (legend-ph62j)
Peran: architect (baca ~/.agents/team/roles/architect.md). Opus 5.5, effort xhigh (akses lintas outlet + protokol edge-cloud).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran: Explore uvnll (cabang wip/1041-hard-stale ab67f9d31: edge/runtime.ts, device-registry-alarm-queue.ts, link-client/server, protocol.ts), Explore ph62j (origin/ui/tenant-config 84060e4ae + 8c596b8a8: apps/web/src/features/ws02-edge/*, CONTRACT-GAPS.md; mockup design/mockups/backoffice/receipt-run-s7szu.html disetujui founder Q35/Q96), Explore pola catalogStale + izin layar di packages/shared/src/permissions.ts.
Tugas (tanpa kode produk):
- uvnll: desain flag deviceRegistryHardStale di heartbeat link edge -> peringatan cloud ke pemilik (pola catalogStale), termasuk ACK heartbeat sesudah transaksi cloud sukses supaya alarm tidak hilang saat replay; idempoten; lintas tenant aman.
- ph62j: desain API cloud daftar node lintas outlet, izin layar (resource/aksi RBAC), persistensi status alert, nama node di kontrak (node lokal boleh "local"). Akses: hanya outlet/tenant milik pemanggil.
- Urutkan dengan legend-e3k4p (berbagi runtime.ts).
Hasil: docs/design/edge-status-cloud.md (keputusan, kontrak DTO, migrasi bila ada dengan rentang kerja 0678-0679, risiko, test wajib) dan kartu bd per slice (engineer Sonnet, berkas tidak bertumpuk, tingkat K/S, base). Commit dokumen di cabang worktree-mu, push tanpa force. Lapor sekali di akhir: ringkasan desain, id kartu, SHA, angka subagent.
