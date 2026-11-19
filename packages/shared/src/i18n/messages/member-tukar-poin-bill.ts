// Member "Tukar poin di kasir": bill context, bill list, and the screen after a
// redemption (bead legend-0ne0z, brief 1165 slice B). id.ts spreads it into
// `member.tukarPoin`, so keys read `member.tukarPoin.bill.*`,
// `member.tukarPoin.openBill.*`, and `member.tukarPoin.pointsAfter.*`.
export const memberTukarPoinBillMessages = {
  bill: {
    connected: "Terhubung",
    idLine: "Tagihan #{number} · Meja {table}",
    idLineNoTable: "Tagihan #{number}",
    total: "Total tagihan",
    paid: "Sudah dibayar",
    remaining: "Sisa tagihan",
  },
  openBill: {
    balanceLabel: "Poin tersedia",
    balanceUnit: "poin",
    balanceLoading: "Sedang dimuat",
    balancePlaceholder: "—",
    rateLine: "1 poin = {value}",
    memberRateLine: "{name} · 1 poin = {value}",
    // tanpa-tagihan
    emptyEyebrow: "Tagihan aktif",
    emptyTitle: "Belum ada tagihan terhubung",
    emptyBody:
      "Tunjukkan QR member Anda kepada kasir. Setelah dipindai dan dihubungkan ke tagihan, rinciannya muncul di sini.",
    emptyNote: "QR member hanya menghubungkan akun. Poin belum digunakan.",
    showMemberQr: "Tampilkan QR member",
    refresh: "Periksa tagihan lagi",
    // pilih tagihan (lebih dari satu)
    listEyebrow: "Terhubung ke kasir",
    listTitle: "Pilih tagihan",
    listBody:
      "Ada lebih dari satu tagihan yang terhubung. Pilih tagihan yang sedang Anda bayar.",
    listNote: "Poin belum digunakan. Cocokkan outlet dan nomor tagihan dulu.",
    select: "Pilih tagihan ini",
    selectLabel: "Pilih tagihan ini: #{number}, {outlet}",
    // tagihan-aktif
    activeEyebrow: "Terhubung ke kasir",
    activeTitle: "Tagihan aktif",
    activeBody: "Pakai sebagian poin, lalu bayar sisanya di kasir.",
    noteScanned:
      "QR member sudah dipindai. Cocokkan outlet dan tagihan sebelum memakai poin.",
    noteSession:
      "Tagihan ini terhubung dari pesanan Anda. Cocokkan outlet dan tagihan sebelum memakai poin.",
    summaryLabel: "Ringkasan poin untuk tagihan ini",
    remaining: "Sisa tagihan",
    usable: "Poin yang bisa dipakai",
    usableMax: "Maks. {points} poin",
    usableChecking: "Sedang diperiksa",
    usableNone: "Belum ada",
    usableHint: "Nilai maksimal {value}. Minimum penukaran {min} poin.",
    choosePoints: "Pilih jumlah poin",
    chooseHint: "Poin belum dipotong. Kamu memilih jumlahnya terlebih dahulu.",
    checking: "Memeriksa poin untuk tagihan ini.",
    refusalLabel: "Poin belum bisa dipakai.",
    refusal: {
      program_inactive: "Program poin sedang tidak aktif di outlet ini.",
      membership_inactive:
        "Keanggotaan Anda sedang tidak aktif, jadi poin belum bisa dipakai.",
      bill_settled: "Tagihan ini sudah lunas.",
      order_not_eligible: "Tagihan ini belum bisa memakai poin.",
      outlet_offline:
        "Kasir outlet sedang tidak terhubung. Coba lagi sebentar lagi.",
      noPoints: "Belum ada poin yang bisa dipakai untuk tagihan ini.",
      alreadyRedeemed: "Poin sudah ditukar di tagihan ini.",
    },
  },
  pointsAfter: {
    contextEyebrow: "Poin saya",
    contextTitle: "Poin setelah penukaran",
    contextBody: "Penukaran terakhir sudah dikonfirmasi.",
    balanceLabel: "Poin tersedia",
    balanceHint: "Saldo sesudah penggunaan {points} poin.",
    panelEyebrow: "Tagihan aktif · {outlet}",
    panelTitle: "Lanjutkan pembayaran di kasir",
    summaryLabel: "Ringkasan penukaran poin",
    used: "Poin sudah digunakan",
    usedValue: "{points} poin",
    discount: "Potongan tercatat",
    remaining: "Sisa tagihan",
    note: "Penukaran poin telah selesai. Pembayaran sisa tagihan masih menunggu kasir.",
    oldQr: "QR sebelumnya sudah tidak berlaku dan tidak perlu dipindai lagi.",
  },
};
