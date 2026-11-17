# 1014 Runbook pensiun kunci reseal (legend-ony4b)

Peran: tech-writer (baca ~/.agents/team/roles/tech-writer.md). Sonnet 5.5, effort high.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore job reseal + registry, doc-writer).

Base: `ghostex/1002-reseal-chatgpt-push` (9b1010918). Cabangmu antre SESUDAH 1002.
Perbaiki: (1) SO 1011 P2 (`docs/qa/second-opinion-rotasi-kunci.md`, lihat di folder utama repo): checklist pensiun di `docs/DECISIONS.md` (~baris 12) hanya menyebut tiga kolom baru; harus mencakup seluruh registry `sealed-secret-reseal.job.ts`, termasuk baris frozen/busy, sesuai aturan bagian 4.4 desain (aborted=false, failed=0, failedTenants=0, remaining=0). (2) `docs/deployment.md` bagian 4.4: cara operator mendapat id baris `push_subscriptions` (dan kolom lain) yang tidak bisa dibuka, dari laporan job atau query read-only yang aman (tanpa mencetak ciphertext/token).
Dokumen saja; bila daftar kolom diturunkan dari kode, tulis daftar persis dari registry. Prettier pada berkas markdown yang diubah (bagian baru saja).
Commit, push tanpa force. Laporan sekali di akhir: apa yang diubah, SHA, angka subagent.
