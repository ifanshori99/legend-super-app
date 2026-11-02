// /design-system: every base component with its states.
import { useState, type FormEvent } from "react";
import {
  Copy,
  MoreHorizontal,
  PencilLine,
  Plus,
  ShoppingBag,
  Trash2,
} from "lucide-react";
import { z } from "zod";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardShell,
  CardShellFooter,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField, fieldErrors } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  sampleMenu,
  sampleGuestsToday,
  sampleOpenOrders,
  sampleOrders,
  sampleOutlet,
  sampleSalesToday,
  type SampleOrder,
} from "@/components/design-system/sample-data";
import { Section, SubHeading } from "@/components/design-system/token-sections";

function SampleBadge() {
  const t = useT();
  return <Badge tone="warning">{t("common.sampleData")}</Badge>;
}

export function OrdersTable({
  orders,
  compact = false,
}: {
  orders: SampleOrder[];
  /** Drops table and station columns for narrow previews. */
  compact?: boolean;
}) {
  const t = useT();
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("designSystem.demo.colOrder")}</TableHead>
          {!compact && <TableHead>{t("designSystem.demo.colTable")}</TableHead>}
          <TableHead className={compact ? "hidden" : "hidden sm:table-cell"}>
            {t("designSystem.demo.colStation")}
          </TableHead>
          <TableHead>{t("designSystem.demo.colStatus")}</TableHead>
          <TableHead numeric>{t("designSystem.demo.colTotal")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => (
          <TableRow key={order.code}>
            <TableCell className="font-semibold whitespace-nowrap tabular">
              {order.code}
            </TableCell>
            {!compact && (
              <TableCell className="tabular">{order.table}</TableCell>
            )}
            <TableCell className={compact ? "hidden" : "hidden sm:table-cell"}>
              {order.station}
            </TableCell>
            <TableCell>
              <StatusPill status={order.status} />
            </TableCell>
            <TableCell numeric>
              <Money amount={order.total} className="text-[length:inherit]" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ButtonsDemo() {
  const t = useT();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button>
          <ShoppingBag aria-hidden="true" />
          {t("designSystem.demo.sendOrder")}
        </Button>
        <Button variant="brand">{t("designSystem.demo.add")}</Button>
        <Button variant="secondary">{t("common.cancel")}</Button>
        <Button variant="outline">{t("common.back")}</Button>
        <Button variant="ghost">{t("common.more")}</Button>
        <Button variant="destructive">
          <Trash2 aria-hidden="true" />
          {t("designSystem.demo.remove")}
        </Button>
        <Button variant="link">{t("designSystem.demo.viewOrders")}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm">{t("designSystem.demo.add")}</Button>
        <Button size="lg">{t("designSystem.demo.sendOrder")}</Button>
        <Button size="icon" variant="outline">
          <Plus aria-hidden="true" />
          <span className="sr-only">{t("designSystem.demo.add")}</span>
        </Button>
        <Button loading>{t("designSystem.components.loadingButton")}</Button>
        <Button disabled>{t("designSystem.components.disabled")}</Button>
      </div>
    </div>
  );
}

function FieldsDemo() {
  const t = useT();
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <FormField label={t("designSystem.demo.nameLabel")} required>
        <Input defaultValue="Sari" autoComplete="name" />
      </FormField>
      <FormField label={t("designSystem.demo.tableLabel")} required>
        <Select>
          <SelectTrigger>
            <SelectValue
              placeholder={t("designSystem.demo.tablePlaceholder")}
            />
          </SelectTrigger>
          <SelectContent>
            {["3", "7", "12", "15"].map((table) => (
              <SelectItem key={table} value={table}>
                {t("designSystem.demo.tableOption", { table })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <FormField
        label={t("designSystem.demo.noteLabel")}
        hint={t("designSystem.demo.noteHint")}
        className="sm:col-span-2"
      >
        <Textarea rows={2} />
      </FormField>
      <div className="flex min-h-control items-center gap-3">
        <Checkbox id="ds-split" defaultChecked />
        <Label
          htmlFor="ds-split"
          className="text-(length:--density-text) font-medium"
        >
          {t("designSystem.demo.splitBill")}
        </Label>
      </div>
      <div className="flex min-h-control items-center gap-3">
        <Switch id="ds-soldout" />
        <Label
          htmlFor="ds-soldout"
          className="text-(length:--density-text) font-medium"
        >
          {t("designSystem.demo.showSoldOut")}
        </Label>
      </div>
      <FormField
        label={t("designSystem.demo.phoneLabel")}
        error={t("designSystem.demo.phoneError")}
        required
      >
        <Input defaultValue="0812" inputMode="tel" />
      </FormField>
      <FormField label={t("designSystem.components.disabled")}>
        <Input disabled defaultValue="A-0142" />
      </FormField>
    </div>
  );
}

function ZodFormDemo() {
  const t = useT();
  const toast = useToast();
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  // Demo schema only; real order validation lives in packages/shared/validators.
  const schema = z.object({
    name: z.string().trim().min(2, t("designSystem.demo.nameError")),
    phone: z.string().regex(/^08\d{8,11}$/, t("designSystem.demo.phoneError")),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = schema.safeParse({
      name: data.get("name"),
      phone: String(data.get("phone") ?? "").replace(/[\s-]/g, ""),
    });
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }
    setErrors({});
    toast({
      tone: "success",
      title: t("designSystem.demo.sentTitle"),
      description: t("designSystem.components.submitted", {
        name: result.data.name,
      }),
    });
  }

  const count = Object.values(errors).filter(Boolean).length;
  return (
    <form noValidate onSubmit={onSubmit} className="grid max-w-md gap-4">
      {count > 0 && (
        <p
          role="alert"
          className="rounded-lg bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
        >
          {t("form.errorSummary", { count })}
        </p>
      )}
      <FormField
        label={t("designSystem.demo.nameLabel")}
        error={errors.name}
        required
      >
        <Input name="name" autoComplete="name" />
      </FormField>
      <FormField
        label={t("designSystem.demo.phoneLabel")}
        hint={t("designSystem.demo.phoneHint")}
        error={errors.phone}
        required
      >
        <Input name="phone" type="tel" inputMode="tel" autoComplete="tel" />
      </FormField>
      <Button type="submit" className="justify-self-start">
        {t("designSystem.demo.sendOrder")}
      </Button>
    </form>
  );
}

function OverlaysDemo() {
  const t = useT();
  const item = sampleMenu[0];
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">
            {t("designSystem.components.openDialog")}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("designSystem.demo.removeTitle", { item: item.name })}
            </DialogTitle>
            <DialogDescription>
              {t("designSystem.demo.removeBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t("common.cancel")}</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="destructive">
                {t("designSystem.demo.remove")}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet>
        <SheetTrigger asChild>
          <Button variant="outline">
            {t("designSystem.components.openSheet")}
          </Button>
        </SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{t("designSystem.demo.cart")}</SheetTitle>
            <SheetDescription>
              {t("designSystem.demo.cartHint")}
            </SheetDescription>
          </SheetHeader>
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">
            {sampleMenu.slice(0, 3).map((menu) => (
              <li
                key={menu.id}
                className="flex items-baseline justify-between gap-3 border-b pb-3"
              >
                <span>{menu.name}</span>
                <Money amount={menu.price} />
              </li>
            ))}
          </ul>
          <SheetFooter className="mt-auto">
            <div className="flex w-full items-baseline justify-between font-semibold">
              <span>{t("designSystem.demo.total")}</span>
              <Money
                amount={sampleMenu
                  .slice(0, 3)
                  .reduce((sum, m) => sum + m.price, 0)}
                size="lg"
              />
            </div>
            <Button size="lg" className="w-full">
              {t("designSystem.demo.sendOrder")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon">
            <MoreHorizontal aria-hidden="true" />
            <span className="sr-only">
              {t("designSystem.components.openMenu")}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem>
            <PencilLine aria-hidden="true" />
            {t("designSystem.demo.editNote")}
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Copy aria-hidden="true" />
            {t("designSystem.demo.duplicate")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive>
            <Trash2 aria-hidden="true" />
            {t("designSystem.demo.remove")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function MenuList({
  category,
}: {
  category?: (typeof sampleMenu)[number]["category"];
}) {
  const t = useT();
  const items = sampleMenu.filter((m) => !category || m.category === category);
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">
      {items.map((menu) => (
        <li
          key={menu.id}
          className="flex items-center gap-3 rounded-xl border bg-card p-3"
        >
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{menu.name}</p>
            <p className="truncate text-sm text-muted-foreground">
              {menu.description}
            </p>
            <Money amount={menu.price} className="mt-1 block font-semibold" />
          </div>
          <Button
            size="sm"
            variant="outline"
            aria-label={t("designSystem.demo.addItem", { item: menu.name })}
          >
            <Plus aria-hidden="true" />
            {t("designSystem.demo.add")}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function TabsDemo() {
  const t = useT();
  return (
    <Tabs defaultValue="all">
      <TabsList>
        <TabsTrigger value="all">{t("designSystem.demo.tabAll")}</TabsTrigger>
        <TabsTrigger value="coffee">
          {t("designSystem.demo.tabCoffee")}
        </TabsTrigger>
        <TabsTrigger value="nonCoffee">
          {t("designSystem.demo.tabNonCoffee")}
        </TabsTrigger>
        <TabsTrigger value="food">{t("designSystem.demo.tabFood")}</TabsTrigger>
      </TabsList>
      <TabsContent value="all">
        <MenuList />
      </TabsContent>
      <TabsContent value="coffee">
        <MenuList category="coffee" />
      </TabsContent>
      <TabsContent value="nonCoffee">
        <MenuList category="nonCoffee" />
      </TabsContent>
      <TabsContent value="food">
        <MenuList category="food" />
      </TabsContent>
    </Tabs>
  );
}

function DataDemo() {
  const t = useT();
  const [state, setState] = useState<DataState>("ready");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const rows = sampleOrders.filter(
    (o) =>
      !q ||
      o.code.toLowerCase().includes(q) ||
      o.station.toLowerCase().includes(q),
  );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <StatStrip label={t("designSystem.demo.salesToday")} columns={3}>
        <StatTile
          label={t("designSystem.demo.salesToday")}
          value={
            <Money
              amount={sampleSalesToday}
              className="text-[length:inherit]"
            />
          }
          context={t("designSystem.demo.today", { outlet: sampleOutlet })}
          source={<a href="#data">{t("designSystem.demo.viewTransactions")}</a>}
        />
        <StatTile
          label={t("designSystem.demo.openOrders")}
          value={sampleOpenOrders}
          context={t("designSystem.demo.today", { outlet: sampleOutlet })}
          source={<a href="#data">{t("designSystem.demo.viewOrders")}</a>}
        />
        <StatTile
          label={t("designSystem.demo.guestsToday")}
          value={sampleGuestsToday}
          context={t("designSystem.demo.today", { outlet: sampleOutlet })}
        />
      </StatStrip>
      <SegmentedControl<DataState>
        label={t("designSystem.demo.dataState")}
        value={state}
        onValueChange={setState}
        options={[
          { value: "ready", label: t("designSystem.states.filled") },
          { value: "loading", label: t("designSystem.states.loading") },
          { value: "empty", label: t("designSystem.states.empty") },
          { value: "error", label: t("designSystem.states.error") },
        ]}
      />
      <DataTableShell
        title={t("designSystem.demo.ordersTitle")}
        description={t("designSystem.demo.ordersHint")}
        state={state}
        search={{ value: query, onChange: setQuery }}
        onRetry={() => setState("loading")}
        empty={{
          title: t("designSystem.demo.emptyOrders"),
          description: t("designSystem.demo.emptyOrdersHint"),
        }}
        noResults={rows.length === 0}
        rowCount={rows.length}
        page={{ page: 1, total: 1, onChange: () => {} }}
      >
        <OrdersTable orders={rows} />
      </DataTableShell>
    </div>
  );
}

function FeedbackDemo() {
  const t = useT();
  const toast = useToast();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{t("status.neutral")}</Badge>
        <Badge tone="brand">{t("theme.tenant")}</Badge>
        <Badge tone="success">{t("status.success")}</Badge>
        <Badge tone="warning">{t("status.warning")}</Badge>
        <Badge tone="danger">{t("status.danger")}</Badge>
        <Badge tone="info">{t("status.info")}</Badge>
        <Badge tone="solid">3</Badge>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            toast({
              tone: "success",
              title: t("designSystem.demo.sentTitle"),
              description: t("designSystem.demo.sentBody"),
            })
          }
        >
          {t("designSystem.components.showToast")}
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-36 rounded-lg" />
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </Card>
        <Card className="p-0!">
          <EmptyState
            title={t("designSystem.demo.emptyOrders")}
            description={t("designSystem.demo.emptyOrdersHint")}
          />
        </Card>
        <Card className="p-0!">
          <ErrorState onRetry={() => {}} />
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{sampleMenu[3].name}</CardTitle>
          <CardDescription>{sampleMenu[3].description}</CardDescription>
        </CardHeader>
        <Money amount={sampleMenu[3].price} size="lg" />
      </Card>
    </div>
  );
}

// v3 (DESIGN.md §4): the double-shell card and its three layers, plus every
// status as icon + text.
function ShellDemo() {
  const t = useT();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <p className="max-w-prose text-sm leading-5 text-muted-foreground">
        {t("designSystem.components.shellHint")}
      </p>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <CardShell>
          <Card>
            <CardHeader>
              <p className="type-eyebrow text-muted-foreground">
                {t("designSystem.demo.today", { outlet: sampleOutlet })}
              </p>
              <CardTitle className="type-title">
                {t("designSystem.demo.shellCardTitle")}
              </CardTitle>
            </CardHeader>
            <CardDescription>
              {t("designSystem.demo.shellCardBody")}
            </CardDescription>
          </Card>
          <CardShellFooter>
            <a
              href="#data"
              className="font-semibold text-primary underline-offset-4 hover:underline"
            >
              {t("designSystem.demo.viewOrders")}
            </a>
          </CardShellFooter>
        </CardShell>
        <div className="grid gap-2">
          <p className="text-sm font-semibold">
            {t("designSystem.components.layers")}
          </p>
          <div className="rounded-container border bg-surface-2 p-3">
            <p className="mb-2 text-xs text-muted-foreground">
              {t("designSystem.components.layerCanvas")}
            </p>
            <div className="rounded-shell border bg-shell p-2 shadow-hairline">
              <p className="mb-2 px-1 text-xs text-muted-foreground">
                {t("designSystem.components.layerShell")}
              </p>
              <div className="rounded-container border bg-card p-3 text-xs shadow-hairline">
                {t("designSystem.components.layerCard")}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm font-semibold">
          {t("designSystem.components.statuses")}
        </p>
        <div className="flex flex-wrap gap-2">
          {STATUS_KINDS.map((status) => (
            <StatusPill key={status} status={status} />
          ))}
          <StatusPill status="late" solid />
        </div>
      </div>
    </div>
  );
}

const STATUS_KINDS = [
  "received",
  "preparing",
  "ready",
  "delivered",
  "onTrack",
  "near",
  "late",
] as const;

export function ComponentGallery() {
  const t = useT();
  return (
    <Section
      id="komponen"
      title={t("designSystem.sections.components")}
      aside={<SampleBadge />}
    >
      <div>
        <SubHeading>{t("designSystem.components.buttons")}</SubHeading>
        <ButtonsDemo />
      </div>
      <div>
        <SubHeading>{t("designSystem.components.fields")}</SubHeading>
        <FieldsDemo />
      </div>
      <div className="grid gap-8 md:grid-cols-2">
        <div>
          <SubHeading>{t("designSystem.components.form")}</SubHeading>
          <ZodFormDemo />
        </div>
        <div>
          <SubHeading>{t("designSystem.components.overlays")}</SubHeading>
          <OverlaysDemo />
        </div>
      </div>
      <div>
        <SubHeading>{t("designSystem.components.navigation")}</SubHeading>
        <TabsDemo />
      </div>
      <div>
        <SubHeading>{t("designSystem.components.shell")}</SubHeading>
        <ShellDemo />
      </div>
      <div id="data" className="scroll-mt-28">
        <SubHeading>{t("designSystem.components.data")}</SubHeading>
        <DataDemo />
      </div>
      <div>
        <SubHeading>{t("designSystem.components.feedback")}</SubHeading>
        <FeedbackDemo />
      </div>
    </Section>
  );
}
