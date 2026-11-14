# 782 Alert panik harus sampai ke petugas ( legend-mm029 legend-oi7ub legend-po3fe legend-ewmfd legend-aagpf)
Peran: engineer (Codex, high). Keselamatan orang: alarm yang tidak sampai = P0. Basis: worktree dari origin/ui/panic-copy-subnav (berisi panic-alert-wiring). Migrasi hanya bila perlu: nomor 0373.
Temuan dan usul test: docs/qa/second-opinion-panic.md (5 temuan) dan `bd show <id>`.
Paralel: satu implementer per temuan (berkas terpisah: web layer, route gate, worker adapter, relay service, receiver session), test-writer gagal-dulu untuk kelimanya, reviewer per area.
Aturan: OM/GM penerima alarm ikuti template izin bawaan (jangan buka ke peran lain). Push produksi: bila butuh kunci VAPID/penyedia yang belum ada, jangan buat kunci palsu; laporkan nama kunci (dari .env.example) yang dibutuhkan. Jangan kirim notifikasi ganda per alert.
Bukti: test gagal-dulu lalu lulus; test terarah lewat LEGEND_TEST_FILES=... heavy pnpm test; e2e mock legend-jztb7 tetap lulus; typecheck api+web sekali lewat heavy; prettier/eslint.
Commit+push ke cabang kerja, jangan merge. Lapor: berkas, test, kunci yang dibutuhkan, angka subagent.
