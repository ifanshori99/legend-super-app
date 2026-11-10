# Brief: engineer — perbaikan review K ws/pos-shift (580d0db)

Peran: `~/.agents/team/roles/engineer.md`. Worktree `.worktrees/pos-shift`, cabang `ws/pos-shift`. Jangan baca `.env*`, jangan `pkill`.

## Temuan reviewer Opus
1. Sedang — `services/pos-cash-guard.ts:69-82`: shift terbuka dicari per kasir+outlet, `caller.deviceId` diabaikan; `computeShiftAggregates` (`pos-shift-support.ts:259-274`) hitung tunai per kasir, bukan per laci. Kasir login di perangkat B / back-office tanpa token perangkat bisa terima tunai yang tercatat di shift A. Fix: tunai wajib `caller.deviceId`, guard filter `posShifts.deviceId = caller.deviceId`, simpan `shift_id` (atau device) di tender/refund/void, agregat per shift.
2. Sedang — `services/pos-order-corrections.ts:230-239`, `:446-451`: refund/void tunai tidak cek isi laci → kas seharusnya negatif → `submitPosShiftCount` 409 (`expectedCashOf` RangeError), shift dan Tutup Hari macet. Fix: dalam lock shift, hitung kas seharusnya sebelum insert; tolak 409 bila tunai > kas laci.
3. Rendah — `services/pos-shift.service.ts:886`, `:1172`: persetujuan PIN menyimpan `approvalRequestId` UUID dari klien tanpa cek. Fix: simpan `ulidToUuid(override.id)`.
4. Rendah — `services/pos-shift.service.ts:526-530`: penolakan kas keluar/setoran > kas laci bocorkan kas seharusnya (melanggar hitung buta POS-03), tanpa jejak. Fix: catat penolakan di audit + pesan umum.
5. Migration bentrok dengan main (0063–0067): merge `main`, renumber via drizzle-kit.

## Temuan architect
1. Tinggi — migration 0063–0067 bentrok dengan main; `git merge-tree main ws/pos-shift` konflik di snapshot, `_journal.json`, dan `pos-order-payment.ts` (main berubah 396 baris). Fix: merge main; hapus migration cabang + snapshot, `drizzle-kit generate` ulang (when baru, lihat "Catatan merge milestone" di PROGRESS); SQL custom (RLS, trigger) ke migration custom baru. Pastikan `addPosTender` versi main tetap memanggil `lockCashierShiftForCash`; cek tidak ada jalur terima tunai lain di main.
2. Sedang — sama dengan temuan 1 reviewer (guard per perangkat; beda perangkat → `SHIFT_NOT_OPEN`).
3. Sedang — `pos-shift.service.ts:1059-1075`, `pos-day.service.ts:650-663`: shift hanya bisa ditutup pemiliknya → kasir sakit/keluar/role dicabut = Tutup Hari macet selamanya (melanggar U9). Fix: tutup paksa oleh pemegang `approve_close`: hitung ulang dengan saksi kedua, catatan wajib, event + audit sendiri. Laporkan kontrak API baru untuk UI.
4. Rendah — hitung buta bocor: `pos-shift-support.ts:548` (`noteRequired`), submit hitungan tak dibatasi, pesan penolakan kas keluar, pesan "butuh persetujuan berjenjang" (`pos-shift.service.ts:517-530`, `:1004-1008`). Fix: batasi submit hitungan per shift (mis. 3, sesudahnya supervisor); kas keluar/setoran melebihi laci → minta persetujuan supervisor tanpa pesan pembeda.
5. Rendah — `0066_pos_shift_counts.sql:26,33`: `pos_shifts.count_id` tanpa FK ke `pos_shift_counts`; tidak dicek milik shift sama / `counted_idr` cocok; `pos_shifts_open_check` tak mewajibkan `count_id IS NULL`. Fix: FK `(tenant_id, count_id)` + trigger cek `shift_id` dan `counted_idr`.
6. Rendah — sama dengan temuan 3 reviewer (`:886,1172,1221`): simpan `override.approvalRequestId ?? ulidToUuid(override.id)`.

## Bukti selesai
Test regresi per temuan; gerbang penuh; reviewer subagent konteks segar; commit lokal. Laporan: SHA, test, migration lama→baru. Catatan: UI `ui/pos-kasir-shift` mengikuti kontrak cabang ini; laporkan bila kontrak berubah (mis. tunai wajib deviceId).
