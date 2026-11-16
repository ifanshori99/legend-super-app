# 945 WS-05 FE Duitku (3 kartu, web saja)
Peran: ui-engineer (baca ~/.agents/team/roles/ui-engineer.md dan ~/.agents/team/ui-standard.md). Sonnet 5.5 high.
Cabang: worktree-mu dari `milestone/m1` (c17c60df7 atau tip terbaru); commit dan push tanpa force. Tidak merge, tidak deploy. Tanpa migrasi; backend sudah di m1 (302, ws/gateway-adapter-duitku).
Kartu (`bd show <id>` untuk AC):
- legend-mp44v: routing gateway pakai izin `org.settings.manage` + pilih cadangan (fallbackProvider) per metode. `apps/web/src/features/ws05-payment-admin/lib.ts`, `routes/_kelola/kelola.pembayaran.tsx`. Kontrak `docs/briefs/sub-302-design.md` D12-D14.
- legend-vntqt: form kredensial Duitku per brand/outlet + tombol tes koneksi (PUT `/api/org/integrations`, POST `/:id/test`). Komponen form sendiri (jangan menumpuk di `kelola.pembayaran.tsx` yang dipegang mp44v). Kredensial tidak pernah ditampilkan ulang (hanya status tersimpan/terakhir diuji).
- legend-6xf7x: layar tamu menawarkan e-wallet dan kartu dari Duitku (`features/ws03-qr-order/components/bill/pay-dialog.tsx`), ikut gaya mockup `design/mockups/final-a-*`.
Di luar cakupan: legend-0orff (panel Super Admin gateway platform) menunggu mockup; jangan dikerjakan.
Paralel: Explore per kartu + test-writer (test komponen/hook gagal-dulu) dalam satu giliran, satu implementer per kartu, lalu test-runner + reviewer + ui-auditor bersamaan.
Bukti: test terarah web hijau setelah commit terakhir, pra-gate AGENTS.md (prettier, eslint, text-contract, typecheck web lewat heavy sekali), screenshot tiap layar lebar dan sempit (loading, kosong, error, sukses) ke `docs/screenshots/945/`, ui-auditor tanpa temuan berat.
Laporan: SHA, kartu, test, temuan reviewer/ui-auditor, path screenshot, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu.
