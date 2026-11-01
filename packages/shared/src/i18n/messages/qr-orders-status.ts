// QR order texts: order status per item, call waiter, request bill.
// PRD §3 F10 "Status Pesanan", "Panggil Waiter & Minta Tagihan", "Estimasi
// Waktu Saji"; keys are reachable as qrOrders.status.*.
export const qrOrdersStatusMessages = {
  title: "Pesanan",
  contextPayFirst: "Meja {table} · bayar dulu, lalu pesanan dibuat dapur",
  contextOpenBill: "Meja {table} · bayar di akhir, tagihan satu meja",
  loadingOrders: "Memuat pesanan Anda",
  offlineNotice:
    "Tidak ada koneksi. Status terakhir ditampilkan; waiter tetap bisa dipanggil lewat meja.",
  empty: {
    title: "Belum ada pesanan",
    description:
      "Pesanan yang Anda kirim akan muncul di sini beserta statusnya.",
    action: "Lihat menu",
  },
  error: {
    title: "Status pesanan belum bisa dimuat",
    description:
      "Periksa koneksi internet Anda, lalu tekan Coba lagi. Pesanan Anda tidak hilang.",
  },
  notJoined: {
    title: "Gabung meja dulu",
    description:
      "Isi jumlah tamu agar kami bisa menampilkan pesanan untuk meja ini.",
    action: "Gabung meja",
  },
  order: {
    heading: "Pesanan {number}",
    placedAt: "Dipesan pukul {time}",
    itemsLabel: "Item pesanan {number}",
    quantity: "x{quantity}",
    summary: "{delivered} dari {total} item sudah diantar",
    allDelivered: "Semua item sudah diantar",
    eta: "Perkiraan siap dalam {min}-{max} menit",
    etaSingle: "Perkiraan siap dalam {min} menit",
    awaitingPaymentNote:
      "Dapur belum menerima pesanan ini. Selesaikan pembayaran agar pesanan mulai dibuat.",
    payNow: "Bayar sekarang",
    voidedNote: "Pesanan ini dibatalkan dan tidak akan dibuat.",
  },
  phase: {
    awaitingPayment: "Menunggu pembayaran",
    completed: "Selesai",
    voided: "Dibatalkan",
  },
  item: {
    voided: "Dibatalkan",
    note: "Catatan: {note}",
  },
  step: {
    received: "Diterima",
    preparing: "Diproses",
    ready: "Siap",
    delivered: "Diantar",
    aria: "Langkah {current} dari {total}: {label}",
  },
  waiter: {
    heading: "Butuh bantuan?",
    callButton: "Panggil waiter",
    billButton: "Minta tagihan",
    billRequestedButton: "Tagihan sudah diminta",
    viewBill: "Lihat tagihan",
    closedNote: "Sesi meja ini sudah selesai, pindai ulang QR meja.",
    requestsLabel: "Permintaan Anda ke waiter",
    pending: "Menunggu waiter",
    acknowledged: "Waiter menuju meja Anda",
    kind: {
      addOrder: "Tambah pesanan",
      utensils: "Minta alat makan",
      complaint: "Keluhan",
      other: "Permintaan lain",
      requestBill: "Minta tagihan",
    },
  },
  call: {
    title: "Panggil waiter",
    description:
      "Pilih keperluan Anda. Waiter di area meja Anda akan diberi tahu.",
    reasonLabel: "Keperluan",
    reasonAddOrder: "Tambah pesanan",
    reasonUtensils: "Minta alat makan",
    reasonComplaint: "Keluhan",
    reasonOther: "Lainnya",
    reasonRequired:
      "Pilih salah satu keperluan agar waiter tahu harus membantu apa.",
    messageLabel: "Ceritakan keluhan Anda",
    messageHint: "{count} dari 500 huruf",
    messageTooShort:
      "Tulis keluhan minimal 3 huruf agar waiter paham masalahnya.",
    messageTooLong:
      "Keluhan maksimal 500 huruf. Ringkas sedikit lalu kirim lagi.",
    submit: "Kirim",
    submitting: "Mengirim…",
    cancel: "Batal",
    sendError:
      "Permintaan belum terkirim. Periksa koneksi Anda lalu tekan Kirim lagi; isian Anda tetap tersimpan.",
    success: "Waiter sudah kami beri tahu",
  },
  bill: {
    title: "Minta tagihan ke waiter?",
    description:
      "Tagihan akan muncul di ponsel waiter. Anda tetap bisa menambah pesanan sebelum membayar.",
    confirm: "Minta tagihan",
    confirming: "Meminta…",
    cancel: "Batal",
    sendError:
      "Permintaan tagihan belum terkirim. Periksa koneksi Anda lalu coba lagi.",
    success: "Tagihan sudah diminta, waiter akan datang",
  },
} as const;
