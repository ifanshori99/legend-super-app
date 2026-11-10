# Hasil Codex 122: provisioning default (G6dzs, 9 Nov 16:22)

`ws/provisioning-default@d82041ee`, 18/18 test terarah lulus; 58 akun, 39 mapping lengkap. Tidak ada P0/P1. Belum: race CoA dan backfill/rollback runtime.

- **P2, `apps/api/src/services/accounting-provisioning.service.ts:162`**: lock cek chart kosong tidak diikuti `createAccount`. Backfill membaca chart kosong; tenant membuat akun custom 9999 dan commit; backfill memasukkan template + mapping. Chart custom tercampur template. Fix: advisory lock entitas yang sama di `createAccount` sebelum membaca chart.
- **P2, `apps/api/src/services/inventory-provisioning.service.ts:133`**: benturan nama custom membuat tipe wajib dilewati permanen. Outlet punya `warehouse` bernama `Dapur`; backfill melewatkan `kitchen`; production order tanpa `locationId` gagal 422 `PRODUCTION_LOCATION_UNRESOLVED`. Fix: tambah tipe yang hilang dengan nama alternatif unik deterministik tanpa mengubah baris lama. Test preservasi saat ini mengharapkan tipe yang berbenturan tetap hilang: perbaiki test.
