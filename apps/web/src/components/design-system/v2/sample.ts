// SAMPLE DATA for /design-system/v2 only (DESIGN.md v2 mockups). Realistic
// F&B content so layouts render at true length (RYUX RX-AS-03). Prices,
// counts, badges, and order codes are illustrative, not Cafe Legend data;
// every frame carries the "Contoh data" label. Photos: Unsplash License
// sample images in apps/web/public/sample/menu (see DESIGN.md §4 Media).
import type { LucideIcon } from "lucide-react";
import { Coffee, CupSoda, Soup, UtensilsCrossed } from "lucide-react";

export type SampleItem = {
  id: string;
  name: string;
  description: string;
  price: number;
  photo: string | null;
  icon: LucideIcon;
  badge?: "Terlaris" | "Baru" | "Pedas";
  soldOut?: boolean;
};

const photo = (name: string) => `/sample/menu/${name}.jpg`;

export const v2Coffee: SampleItem[] = [
  {
    id: "es-kopi-susu",
    name: "Es Kopi Susu Gula Aren",
    description: "Espresso, susu segar, dan gula aren cair.",
    price: 28000,
    photo: photo("es-kopi-susu"),
    icon: Coffee,
    badge: "Terlaris",
  },
  {
    id: "es-latte-aren",
    name: "Es Latte Aren",
    description: "Double shot, susu segar, sirup aren.",
    price: 32000,
    photo: photo("es-latte-aren"),
    icon: Coffee,
  },
  {
    id: "cappuccino",
    name: "Cappuccino",
    description: "Double shot dengan foam susu lembut.",
    price: 30000,
    photo: photo("cappuccino"),
    icon: Coffee,
  },
  {
    id: "kopi-tubruk",
    name: "Kopi Tubruk",
    description: "Robusta Temanggung diseduh langsung di gelas.",
    price: 20000,
    photo: null,
    icon: Coffee,
  },
];

export const v2Food: SampleItem[] = [
  {
    id: "nasi-goreng",
    name: "Nasi Goreng Kampung",
    description: "Telur mata sapi, kerupuk, dan acar.",
    price: 38000,
    photo: photo("nasi-goreng"),
    icon: UtensilsCrossed,
    badge: "Pedas",
  },
  {
    id: "roti-telur",
    name: "Roti Telur Alpukat",
    description: "Sourdough panggang, alpukat, telur mata sapi.",
    price: 34000,
    photo: photo("roti-telur"),
    icon: UtensilsCrossed,
    badge: "Baru",
  },
  {
    id: "mie-kuah",
    name: "Mie Kuah Ayam",
    description: "Kaldu ayam, telur rebus, sawi.",
    price: 35000,
    photo: photo("mie-kuah"),
    icon: Soup,
    soldOut: true,
  },
  {
    id: "pancake",
    name: "Pancake Madu",
    description: "Tiga lapis, madu hutan, mentega.",
    price: 33000,
    photo: photo("pancake"),
    icon: UtensilsCrossed,
  },
];

export const v2Featured = [v2Coffee[0]!, v2Food[0]!, v2Food[1]!, v2Coffee[2]!];
export const v2Tea: SampleItem = {
  id: "teh-melati",
  name: "Teh Melati Panas",
  description: "Teh melati tubruk dengan gula batu.",
  price: 18000,
  photo: photo("teh-melati"),
  icon: CupSoda,
};

export const v2Categories = ["Semua", "Kopi", "Nonkopi", "Makanan", "Camilan"];

export const v2Cart = [
  {
    item: v2Coffee[0]!,
    qty: 2,
    options: "Dingin · Gula normal · Extra shot",
    unit: 34000,
    mine: true,
  },
  {
    item: v2Food[0]!,
    qty: 1,
    options: "Tidak pedas",
    unit: 38000,
    mine: false,
  },
  {
    item: v2Coffee[3]!,
    qty: 1,
    options: "Panas · Tanpa gula",
    unit: 20000,
    mine: true,
  },
];

export type TableState =
  | "empty"
  | "occupied"
  | "waiter"
  | "bill"
  | "cleaning"
  | "reserved"
  | "inactive";

export const v2Tables: {
  code: string;
  seats: number;
  state: TableState;
  minutes?: number;
  guests?: number;
  due?: number;
  note?: string;
}[] = [
  { code: "A01", seats: 2, state: "empty" },
  {
    code: "A02",
    seats: 2,
    state: "occupied",
    minutes: 18,
    guests: 2,
    due: 86000,
  },
  {
    code: "A03",
    seats: 4,
    state: "waiter",
    minutes: 39,
    guests: 4,
    due: 214000,
    note: "2 mnt lalu",
  },
  { code: "A04", seats: 4, state: "cleaning" },
  { code: "A05", seats: 2, state: "empty" },
  { code: "A06", seats: 2, state: "cleaning" },
  {
    code: "B01",
    seats: 6,
    state: "occupied",
    minutes: 52,
    guests: 5,
    due: 412500,
  },
  { code: "B02", seats: 6, state: "reserved", note: "19.00 · 6 tamu" },
  {
    code: "P1",
    seats: 10,
    state: "bill",
    minutes: 129,
    guests: 6,
    due: 1143500,
  },
  {
    code: "W01",
    seats: 1,
    state: "occupied",
    minutes: 14,
    guests: 1,
    due: 28000,
  },
  { code: "W02", seats: 1, state: "bill", minutes: 29, guests: 1, due: 62000 },
  { code: "W03", seats: 1, state: "inactive" },
];

export const v2Zones = [
  { label: "Semua", count: 12 },
  { label: "Indoor", count: 6 },
  { label: "Outdoor", count: 2 },
  { label: "Private", count: 1 },
  { label: "WFC", count: 3 },
];

export const v2Tickets: {
  table: string;
  code: string;
  channel: string;
  timer: "onTrack" | "near" | "late";
  elapsed: string;
  items: { qty: number; name: string; mods?: string; flag?: string }[];
  note?: string;
}[] = [
  {
    table: "12",
    code: "A-0142",
    channel: "Dine-in",
    timer: "late",
    elapsed: "16:40",
    items: [
      {
        qty: 2,
        name: "Es Kopi Susu Gula Aren",
        mods: "Extra shot",
        flag: "Kurang gula",
      },
      { qty: 1, name: "Cappuccino", mods: "Panas" },
    ],
    note: "Tamu minta diantar bersamaan.",
  },
  {
    table: "7",
    code: "A-0145",
    channel: "QR",
    timer: "near",
    elapsed: "07:12",
    items: [
      { qty: 1, name: "Es Latte Aren", mods: "Oat milk" },
      { qty: 2, name: "Kopi Tubruk", flag: "Tanpa gula" },
    ],
  },
  {
    table: "3",
    code: "A-0147",
    channel: "Take away",
    timer: "onTrack",
    elapsed: "02:05",
    items: [{ qty: 1, name: "Teh Melati Panas" }],
  },
];

export const v2Attention = [
  {
    tone: "danger" as const,
    text: "2 refund menunggu persetujuan",
    action: "Tinjau",
  },
  {
    tone: "warning" as const,
    text: "Stok susu segar di bawah batas minimum",
    action: "Lihat stok",
  },
  {
    tone: "info" as const,
    text: "Shift kasir pagi belum ditutup",
    action: "Buka shift",
  },
];

export const v2Stats = [
  {
    label: "Penjualan bersih",
    value: 18450000,
    money: true,
    context: "Hari ini · s.d. 14.00",
    link: "Lihat transaksi",
  },
  {
    label: "Transaksi",
    value: 214,
    money: false,
    context: "Hari ini · semua kanal",
    link: "Lihat transaksi",
  },
  {
    label: "Rata-rata per transaksi",
    value: 86215,
    money: true,
    context: "Hari ini",
    link: "Lihat rincian",
  },
  {
    label: "Meja terisi",
    value: "9/12",
    money: false,
    context: "Saat ini",
    link: "Buka papan meja",
  },
];

/** Net sales per hour, 4-week average, 08.00–21.00 (sample, thousands of rupiah). */
export const v2Hourly = [
  320, 610, 980, 1240, 1510, 2280, 2050, 1320, 980, 1160, 1730, 2410, 1650, 990,
];
export const v2HourLabels = [
  "08",
  "09",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "19",
  "20",
  "21",
];
export const v2NowIndex = 6;

export const v2Transactions: {
  time: string;
  code: string;
  table: string;
  channel: string;
  status: "received" | "preparing" | "ready" | "delivered";
  total: number;
}[] = [
  {
    time: "13.58",
    code: "A-0147",
    table: "3",
    channel: "Take away",
    status: "received",
    total: 18000,
  },
  {
    time: "13.52",
    code: "A-0145",
    table: "7",
    channel: "QR",
    status: "preparing",
    total: 96000,
  },
  {
    time: "13.41",
    code: "A-0142",
    table: "12",
    channel: "Dine-in",
    status: "preparing",
    total: 128000,
  },
  {
    time: "13.27",
    code: "A-0139",
    table: "B01",
    channel: "QR",
    status: "ready",
    total: 412500,
  },
  {
    time: "13.05",
    code: "A-0137",
    table: "P1",
    channel: "Dine-in",
    status: "delivered",
    total: 1143500,
  },
  {
    time: "12.48",
    code: "A-0131",
    table: "W01",
    channel: "QR",
    status: "delivered",
    total: 28000,
  },
];

/** Today so far (sample, thousands of rupiah), 08.00 through the current hour. */
export const v2HourlyToday = [360, 580, 1040, 1310, 1620, 2390, 1470];
