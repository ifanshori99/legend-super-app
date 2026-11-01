import {
  Building2,
  ChefHat,
  IdCard,
  House,
  LayoutDashboard,
  PieChart,
  ReceiptText,
  TrendingUp,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { AreaKey } from "@/lib/areas/definitions";

/** Icon of each area's index item in its navigation. */
export const AREA_ICONS: Readonly<Record<AreaKey, LucideIcon>> = {
  public: House,
  customer: UserRound,
  ops: ReceiptText,
  kitchen: ChefHat,
  kelola: LayoutDashboard,
  owner: TrendingUp,
  shareholder: PieChart,
  karyawan: IdCard,
  platform: Building2,
};
