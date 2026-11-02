// /design-system: token documentation sections. Values shown are read from
// the same TypeScript palettes the contrast gate checks, so what is listed
// here is exactly what was verified.
import type { ReactNode } from "react";
import { cn } from "cn";
import { CircleAlert, CircleCheck } from "lucide-react";
import {
  REQUIRED_PAIRS,
  basePalettes,
  checkPalettes,
  checkTenantTheme,
  formatFailure,
  kontrasOverrides,
  mergeTenantPalettes,
  type ColorToken,
  type Density,
  type TenantThemeConfig,
  type ThemePalettes,
} from "@starter/shared/theme";
import { useT } from "@/components/i18n";
import {
  ORDER_STATUSES,
  StatusPill,
  TIMER_STATUSES,
} from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import { sampleMenu } from "@/components/design-system/sample-data";

export function Section({
  id,
  title,
  children,
  aside,
}: {
  id: string;
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-28 border-t py-10 first:border-t-0"
    >
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${id}-title`} className="type-display">
          {title}
        </h2>
        {aside}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8">{children}</div>
    </section>
  );
}

export function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="mb-3 text-base leading-6 font-semibold">{children}</h3>;
}

const GROUPS: {
  key: "neutral" | "brand" | "status";
  tokens: ColorToken[];
}[] = [
  {
    key: "neutral",
    tokens: [
      "background",
      "foreground",
      "card",
      "surface-2",
      "surface-3",
      "muted",
      "muted-foreground",
      "secondary",
      "accent",
      "border",
      "input",
      "ring",
    ],
  },
  {
    key: "brand",
    tokens: [
      "primary",
      "primary-foreground",
      "brand",
      "brand-foreground",
      "brand-subtle",
    ],
  },
  {
    key: "status",
    tokens: (["success", "warning", "danger", "info"] as const).flatMap(
      (s): ColorToken[] => [s, `${s}-foreground`, `${s}-subtle`],
    ),
  },
];

export function resolvePalettes(
  tenant: TenantThemeConfig | null,
  density: Density,
): ThemePalettes {
  const merged = tenant
    ? mergeTenantPalettes(basePalettes, tenant)
    : basePalettes;
  if (density !== "kontras") return merged;
  return {
    light: { ...merged.light, ...kontrasOverrides.light },
    dark: { ...merged.dark, ...kontrasOverrides.dark },
  };
}

function Chip({ hex }: { hex: string }) {
  return (
    <span className="flex items-center gap-2">
      <span
        className="size-7 shrink-0 rounded-md border"
        style={{ backgroundColor: hex }}
        aria-hidden="true"
      />
      <code className="font-mono text-xs text-muted-foreground">{hex}</code>
    </span>
  );
}

export function ColorsSection({
  tenant,
  density,
  failingExample,
}: {
  tenant: TenantThemeConfig | null;
  density: Density;
  failingExample: TenantThemeConfig;
}) {
  const t = useT();
  const palettes = resolvePalettes(tenant, density);
  const check = checkPalettes(palettes);
  const failing = checkTenantTheme(basePalettes, failingExample);
  const total = REQUIRED_PAIRS.length * 2;

  return (
    <Section id="warna" title={t("designSystem.sections.colors")}>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex gap-3 rounded-xl border bg-success-subtle p-card">
          <CircleCheck
            className="mt-0.5 size-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <div className="grid content-start gap-1">
            <p className="font-semibold">{t("designSystem.contrast.title")}</p>
            <p className="text-sm leading-5">
              {check.ok
                ? t("designSystem.contrast.passed", { count: total })
                : check.failures.map(formatFailure).join("; ")}
            </p>
          </div>
        </div>
        <div className="flex gap-3 rounded-xl border bg-danger-subtle p-card">
          <CircleAlert
            className="mt-0.5 size-5 shrink-0 text-danger"
            aria-hidden="true"
          />
          <div className="grid min-w-0 content-start gap-1">
            <p className="font-semibold">
              {t("designSystem.contrast.failedTitle")}
            </p>
            <p className="text-sm leading-5">
              {t("designSystem.contrast.failedHint")}
            </p>
            <ul className="mt-1 grid gap-0.5 font-mono text-xs leading-5">
              {failing.failures.slice(0, 3).map((f) => (
                <li key={`${f.mode}-${f.fg}-${f.bg}`} className="break-words">
                  {formatFailure(f)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        {GROUPS.map((group) => (
          <div key={group.key} className="min-w-0">
            <SubHeading>
              {t(`designSystem.colorGroups.${group.key}`)}
            </SubHeading>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-2 font-semibold">
                    {t("designSystem.demo.tokenCol")}
                  </th>
                  <th scope="col" className="py-2 pr-2 font-semibold">
                    {t("theme.light")}
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    {t("theme.dark")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {group.tokens.map((token) => (
                  <tr key={token} className="border-b last:border-0">
                    <th
                      scope="row"
                      className="py-2 pr-2 text-left font-mono text-xs font-medium"
                    >
                      {token}
                    </th>
                    <td className="py-2 pr-2">
                      <Chip hex={palettes.light[token]} />
                    </td>
                    <td className="py-2">
                      <Chip hex={palettes.dark[token]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <div>
        <SubHeading>{t("designSystem.colorGroups.order")}</SubHeading>
        <div className="flex flex-wrap gap-2">
          {ORDER_STATUSES.map((s) => (
            <StatusPill key={s} status={s} />
          ))}
          <span
            className="mx-1 w-px self-stretch bg-border"
            aria-hidden="true"
          />
          {TIMER_STATUSES.map((s) => (
            <StatusPill key={s} status={s} />
          ))}
        </div>
      </div>
    </Section>
  );
}

const TYPE_SCALE = [
  ["text-3xl", "30/36", "text-3xl leading-9 font-semibold tracking-tight"],
  ["text-2xl", "24/32", "text-2xl leading-8 font-semibold tracking-tight"],
  ["text-xl", "20/28", "text-xl leading-7 font-semibold"],
  ["text-lg", "18/28", "text-lg leading-7 font-semibold"],
  [
    "body (diwarisi)",
    "16 · 18 kontras",
    "text-(length:--density-text) leading-6",
  ],
  ["text-sm", "14/20", "text-sm leading-5"],
  ["text-xs", "12/16", "text-xs leading-4"],
] as const;

export function TypographySection() {
  const t = useT();
  const sample = t("designSystem.typography.sample");
  return (
    <Section id="tipografi" title={t("designSystem.sections.typography")}>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border p-card">
          <p className="mb-2 text-sm font-semibold text-muted-foreground">
            {t("designSystem.typography.brand")}
          </p>
          <p className="font-brand text-3xl leading-9 font-bold tracking-tight">
            {sampleMenu[0].name}
          </p>
          <p className="mt-2 font-brand leading-6">{sample}</p>
        </div>
        <div className="rounded-xl border p-card">
          <p className="mb-2 text-sm font-semibold text-muted-foreground">
            {t("designSystem.typography.ui")}
          </p>
          <p className="font-ui text-3xl leading-9 font-semibold tracking-tight">
            Meja 12 · A-0142
          </p>
          <p className="mt-2 font-ui leading-6">{sample}</p>
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <ul className="grid gap-3">
          {TYPE_SCALE.map(([name, size, cls]) => (
            <li key={name} className="flex items-baseline gap-4">
              <code className="w-28 shrink-0 font-mono text-xs text-muted-foreground">
                {name} <span className="block">{size}</span>
              </code>
              <span className={cn("min-w-0 truncate", cls)}>
                {sampleMenu[2].name}
              </span>
            </li>
          ))}
        </ul>
        <div>
          <SubHeading>{t("designSystem.typography.tabular")}</SubHeading>
          <div className="grid w-fit gap-1 rounded-xl border p-card font-ui">
            {[28000, 1248000, 456000, 9000].map((amount) => (
              <Money key={amount} amount={amount} className="text-right" />
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

const RADII = [
  ["rounded-xs", "rounded-xs"],
  ["rounded-sm", "rounded-sm"],
  ["rounded-md", "rounded-md"],
  ["rounded-lg", "rounded-lg"],
  ["rounded-xl", "rounded-xl"],
  ["rounded-2xl", "rounded-2xl"],
  ["rounded-control", "rounded-control"],
  ["rounded-field", "rounded-field"],
  ["rounded-container", "rounded-container"],
  ["rounded-shell", "rounded-shell"],
] as const;
const SPACES = [1, 2, 3, 4, 6, 8, 12, 16] as const;

export function ShapeSection() {
  const t = useT();
  return (
    <Section id="bentuk" title={t("designSystem.sections.shape")}>
      <div className="grid gap-8 md:grid-cols-2">
        <div>
          <SubHeading>{t("designSystem.shape.radius")}</SubHeading>
          <ul className="grid grid-cols-4 gap-3">
            {RADII.map(([name, cls]) => (
              <li key={name} className="grid justify-items-center gap-1.5">
                <span
                  className={cn(
                    "size-14 border-2 border-foreground bg-muted",
                    cls,
                  )}
                  aria-hidden="true"
                />
                <code className="text-center font-mono text-xs break-all text-muted-foreground">
                  {name.replace("rounded-", "")}
                </code>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <SubHeading>{t("designSystem.shape.spacing")}</SubHeading>
          <ul className="grid gap-2">
            {SPACES.map((n) => (
              <li key={n} className="flex items-center gap-3">
                <code className="w-20 shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground">
                  {n} · {n * 4}px
                </code>
                <span
                  className="h-3 rounded-xs bg-primary"
                  style={{ width: `${n * 4}px` }}
                  aria-hidden="true"
                />
              </li>
            ))}
          </ul>
        </div>
        <div>
          <SubHeading>{t("designSystem.shape.elevation")}</SubHeading>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-container border bg-card p-card text-sm shadow-hairline">
              {t("designSystem.shape.hairline")}
            </div>
            <div className="rounded-control bg-primary p-card text-sm font-semibold text-primary-foreground shadow-primary">
              {t("designSystem.shape.primaryShadow")}
            </div>
            <div className="rounded-xl border bg-card p-card text-sm shadow-raised">
              {t("designSystem.shape.raised")}
            </div>
            <div className="rounded-xl border bg-card p-card text-sm shadow-overlay">
              {t("designSystem.shape.overlay")}
            </div>
          </div>
        </div>
        <div>
          <SubHeading>{t("designSystem.shape.motion")}</SubHeading>
          <ul className="grid gap-1 font-mono text-xs">
            <li>--duration-fast · 120ms — {t("designSystem.shape.fast")}</li>
            <li>--duration-base · 200ms — {t("designSystem.shape.base")}</li>
            <li>--duration-slow · 320ms — {t("designSystem.shape.slow")}</li>
            <li>ease-standard · cubic-bezier(0.2, 0, 0, 1)</li>
          </ul>
          <p className="mt-3 text-sm leading-5 text-muted-foreground">
            {t("designSystem.shape.reducedMotion")}
          </p>
        </div>
      </div>
    </Section>
  );
}
