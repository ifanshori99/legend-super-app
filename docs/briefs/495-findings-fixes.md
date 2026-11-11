# 495 Temuan second-opinion approval/RBAC WS-01 + keputusan CTO

Sumber: Codex G1fid, review a575b1bc. Kerjakan di cabang `ws/approvals-rbac-bundle` (worktree `.worktrees/approvals-rbac-bundle`). Test gagal-dulu tiap temuan, architect high sekali di akhir (akses), commit, push, lapor dengan angka subagent.

1. P2 `device-pin.routes.ts:216`: token perangkat lama tetap diterima setelah rotasi. Keputusan: validasi generasi token terhadap registri perangkat di setiap request; token generasi lama 401. Test replay setelah rotasi.
2. P2 `access.service.ts:831`: grant role ke staf tanpa assignment aktif. Keputusan: dalam transaksi grant, wajib ada assignment aktif di tenant (sudah berlaku, belum kedaluwarsa); selain itu 422. Test kedaluwarsa dan belum berlaku.
3. P2 `override-request-modal.tsx:478`: `onApproved` dipanggil sebelum settlement. Keputusan: poll hasil override yang sudah di-settle; callback hanya bila override `approved`; settlement ditolak tampil sebagai ditolak.
4. P2 `api.ts:87`: idempotency key baru tiap retry. Keputusan: satu key per niat (disimpan di state modal), dipakai ulang saat retry.
5. P2 `override-request-modal.tsx:95`: dialog pending bisa ditutup tanpa cancel. Keputusan: X/Escape/klik luar saat pending = jalankan cancel dulu, tutup setelah cancel sukses; bila cancel gagal, dialog tetap terbuka dengan pesan.
