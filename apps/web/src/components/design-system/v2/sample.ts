// SAMPLE DATA for /design-system/v2 only (DESIGN.md v2 mockups). Realistic
// F&B content so layouts render at true length (RYUX RX-AS-03). Prices,
// counts, badges, and order codes are illustrative, not Cafe Legend data;
// every frame carries the "Contoh data" label. Photos: Unsplash License
// sample images in apps/web/demo/sample/menu (see DESIGN.md §4 Media).
import { createTranslator } from "@starter/shared/i18n";
import { demoMenuPhoto, demoMenuPhotoRef } from "@/lib/demo-media";
import type { LucideIcon } from "lucide-react";
import { Coffee, CupSoda, Soup, UtensilsCrossed } from "lucide-react";

const t = createTranslator();

export type SampleItem = {
  id: string;
  name: string;
  description: string;
  price: number;
  photo: string | null;
  icon: LucideIcon;
  badge?: string;
  soldOut?: boolean;
};

const photoNames: Record<string, string> = {
  "es-kopi-susu": "Kopi Susu Aren",
  "es-latte-aren": "Cafe Latte",
  cappuccino: "Cappuccino",
  "roti-telur": "Roti Telur Alpukat",
  "mie-kuah": "Mie Kuah",
  pancake: "Pancake Madu",
  "teh-melati": "Teh Tarik",
};
const photo = (name: string) =>
  demoMenuPhotoRef(name) ?? demoMenuPhoto(photoNames[name] ?? name);

export const v2Coffee: SampleItem[] = [
  {
    id: "es-kopi-susu",
    name: t("designV2.sample.text001"),
    description: t("designV2.sample.text002"),
    price: 28000,
    photo: photo("es-kopi-susu"),
    icon: Coffee,
    badge: t("designV2.sample.text003"),
  },
  {
    id: "es-latte-aren",
    name: t("designV2.sample.text004"),
    description: t("designV2.sample.text005"),
    price: 32000,
    photo: photo("es-latte-aren"),
    icon: Coffee,
  },
  {
    id: "cappuccino",
    name: t("designV2.sample.text006"),
    description: t("designV2.sample.text007"),
    price: 30000,
    photo: photo("cappuccino"),
    icon: Coffee,
  },
  {
    id: "kopi-tubruk",
    name: t("designV2.sample.text008"),
    description: t("designV2.sample.text009"),
    price: 20000,
    photo: null,
    icon: Coffee,
  },
];

export const v2Food: SampleItem[] = [
  {
    id: "nasi-goreng",
    name: t("designV2.sample.text010"),
    description: t("designV2.sample.text011"),
    price: 38000,
    photo: photo("nasi-goreng"),
    icon: UtensilsCrossed,
    badge: t("designV2.sample.text012"),
  },
  {
    id: "roti-telur",
    name: t("designV2.sample.text013"),
    description: t("designV2.sample.text014"),
    price: 34000,
    photo: photo("roti-telur"),
    icon: UtensilsCrossed,
    badge: t("designV2.sample.text015"),
  },
  {
    id: "mie-kuah",
    name: t("designV2.sample.text016"),
    description: t("designV2.sample.text017"),
    price: 35000,
    photo: photo("mie-kuah"),
    icon: Soup,
    soldOut: true,
  },
  {
    id: "pancake",
    name: t("designV2.sample.text018"),
    description: t("designV2.sample.text019"),
    price: 33000,
    photo: photo("pancake"),
    icon: UtensilsCrossed,
  },
];

export const v2Featured = [v2Coffee[0]!, v2Food[0]!, v2Food[1]!, v2Coffee[2]!];
export const v2Tea: SampleItem = {
  id: "teh-melati",
  name: t("designV2.sample.text020"),
  description: t("designV2.sample.text021"),
  price: 18000,
  photo: photo("teh-melati"),
  icon: CupSoda,
};

export const v2Categories = [
  t("designV2.sample.text022"),
  t("designV2.sample.text023"),
  t("designV2.sample.text024"),
  t("designV2.sample.text025"),
  t("designV2.sample.text026"),
];

export const v2Cart = [
  {
    item: v2Coffee[0]!,
    qty: 2,
    options: t("designV2.sample.text027"),
    unit: 34000,
    mine: true,
  },
  {
    item: v2Food[0]!,
    qty: 1,
    options: t("designV2.sample.text028"),
    unit: 38000,
    mine: false,
  },
  {
    item: v2Coffee[3]!,
    qty: 1,
    options: t("designV2.sample.text029"),
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
    note: t("designV2.sample.text030"),
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
  {
    code: "B02",
    seats: 6,
    state: "reserved",
    note: t("designV2.sample.text031"),
  },
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
  { label: t("designV2.sample.text022"), count: 12 },
  { label: t("designV2.sample.text032"), count: 6 },
  { label: t("designV2.sample.text033"), count: 2 },
  { label: t("designV2.sample.text034"), count: 1 },
  { label: t("designV2.sample.text035"), count: 3 },
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
    channel: t("designV2.sample.text036"),
    timer: "late",
    elapsed: "16:40",
    items: [
      {
        qty: 2,
        name: t("designV2.sample.text001"),
        mods: t("designV2.sample.text037"),
        flag: t("designV2.sample.text038"),
      },
      {
        qty: 1,
        name: t("designV2.sample.text006"),
        mods: t("designV2.sample.text039"),
      },
    ],
    note: t("designV2.sample.text040"),
  },
  {
    table: "7",
    code: "A-0145",
    channel: t("designV2.sample.text041"),
    timer: "near",
    elapsed: "07:12",
    items: [
      {
        qty: 1,
        name: t("designV2.sample.text004"),
        mods: t("designV2.sample.text042"),
      },
      {
        qty: 2,
        name: t("designV2.sample.text008"),
        flag: t("designV2.sample.text043"),
      },
    ],
  },
  {
    table: "3",
    code: "A-0147",
    channel: t("designV2.sample.text044"),
    timer: "onTrack",
    elapsed: "02:05",
    items: [{ qty: 1, name: t("designV2.sample.text020") }],
  },
];

export const v2Attention = [
  {
    tone: "danger" as const,
    text: t("designV2.sample.text045"),
    action: t("designV2.sample.text046"),
  },
  {
    tone: "warning" as const,
    text: t("designV2.sample.text047"),
    action: t("designV2.sample.text048"),
  },
  {
    tone: "info" as const,
    text: t("designV2.sample.text049"),
    action: t("designV2.sample.text050"),
  },
];

export const v2Stats = [
  {
    label: t("designV2.sample.text051"),
    value: 18450000,
    money: true,
    context: t("designV2.sample.text052"),
    link: t("designV2.sample.text053"),
  },
  {
    label: t("designV2.sample.text054"),
    value: 214,
    money: false,
    context: t("designV2.sample.text055"),
    link: t("designV2.sample.text053"),
  },
  {
    label: t("designV2.sample.text056"),
    value: 86215,
    money: true,
    context: t("designV2.sample.text057"),
    link: t("designV2.sample.text058"),
  },
  {
    label: t("designV2.sample.text059"),
    value: "9/12",
    money: false,
    context: t("designV2.sample.text060"),
    link: t("designV2.sample.text061"),
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
    channel: t("designV2.sample.text044"),
    status: "received",
    total: 18000,
  },
  {
    time: "13.52",
    code: "A-0145",
    table: "7",
    channel: t("designV2.sample.text041"),
    status: "preparing",
    total: 96000,
  },
  {
    time: "13.41",
    code: "A-0142",
    table: "12",
    channel: t("designV2.sample.text036"),
    status: "preparing",
    total: 128000,
  },
  {
    time: "13.27",
    code: "A-0139",
    table: "B01",
    channel: t("designV2.sample.text041"),
    status: "ready",
    total: 412500,
  },
  {
    time: "13.05",
    code: "A-0137",
    table: "P1",
    channel: t("designV2.sample.text036"),
    status: "delivered",
    total: 1143500,
  },
  {
    time: "12.48",
    code: "A-0131",
    table: "W01",
    channel: t("designV2.sample.text041"),
    status: "delivered",
    total: 28000,
  },
];

/** Today so far (sample, thousands of rupiah), 08.00 through the current hour. */
export const v2HourlyToday = [360, 580, 1040, 1310, 1620, 2390, 1470];
