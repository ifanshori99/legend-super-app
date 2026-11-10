# legend-shrlc: desain replikasi master HRIS ke edge + selfie offline

Peran: architect (baca `~/.agents/team/roles/architect.md` dan "Paralel dulu" di TEAM.md). Hanya desain dan rencana, tidak menulis kode produk.
Baca: `bd show legend-shrlc`, `bd show legend-j6cyb` (komentar pemetaan G11a1), cabang `ws/j6cyb-edge-attendance` dan `ws/storage-wire` (62ef1e11). Pola replikasi edge yang ada: bootstrap edge, `device-registry-puller`, jalur login edge, `edge_received_events`.

## Keputusan yang sudah ada
- Policy absensi default flag, bukan reject (founder Q81). Event offline ditandai `offline_unverified` untuk supervisor (legend-wh71).
- Selfie offline disimpan lokal di edge, diunggah saat tersambung; `requireSelfie` tidak dilonggarkan (CTO).

## Yang diputuskan desain
1. Data master mana yang direplikasi ke edge (employees, attendance_devices, attendance_policies, attendance_qr_secrets, shift_assignments, role assignment `self.attendance.clock`), kolom minimum (data pribadi seminimal mungkin), arah dan pemicu sinkron, penghapusan/nonaktif karyawan.
2. Secret QR di edge: disimpan bagaimana, rotasi, dampak bila edge dicuri.
3. Selfie lokal: penyimpanan edge, batas ukuran, retensi, unggah ulang idempoten, enkripsi.
4. Migrasi edge yang dibutuhkan, test acceptance, dan pemecahan jadi kartu implementasi (bd create, dep ke j6cyb).

Tulis desain di `docs/design/hris-edge-replication.md` di cabang `ws/hris-edge-design` (worktree `.worktrees/hris-edge-design` dari `ws/storage-wire`). Commit lokal, jangan push. Pertanyaan bisnis untuk founder: tulis di laporan dengan rekomendasi, jangan tanya langsung.

## Laporan
Sekali di akhir: ringkasan keputusan, kartu yang dibuat, pertanyaan founder (bila ada).
