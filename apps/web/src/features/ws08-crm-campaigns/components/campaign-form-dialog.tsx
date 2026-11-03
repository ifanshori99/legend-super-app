// Create-campaign dialog (/kelola/kampanye): name, segment with its live
// audience size, channel, content, schedule, and a simple A/B variant
// (PRD §3.21 "Kampanye"). "Dibantu AI" fills the content from a deterministic
// local template (AI-12) and labels it as a draft to edit, never as live model
// output. LOY-04 is stated in the form: customers without active marketing
// consent never receive a promotional campaign.
import * as React from "react";
import { Sparkles } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { formatNumber } from "@starter/shared/i18n";
import type { CampaignChannel } from "@starter/shared/crm";
import { useOutletClock } from "@/lib/tenant-context";
import { useCreateCampaign, useSegmentPreview, useSegments } from "../hooks";
import {
  CAMPAIGN_CHANNELS,
  aiDraftContent,
  campaignBody,
  emptyCampaignForm,
  formatSplitPercent,
  hasFieldErrors,
  needsTemplateRef,
  parseSplitPercent,
  validateCampaignForm,
  type CampaignFieldErrors,
  type CampaignForm,
} from "../lib";
import { Notice } from "./campaign-shell";

export function CampaignFormDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const { timeZone } = useOutletClock();
  const create = useCreateCampaign();
  const segmentsQuery = useSegments();
  const segments = segmentsQuery.data?.data ?? [];

  const [form, setForm] = React.useState<CampaignForm>(emptyCampaignForm());
  const [errors, setErrors] = React.useState<CampaignFieldErrors>({});
  const [saveFailed, setSaveFailed] = React.useState(false);
  const [aiDraft, setAiDraft] = React.useState(false);

  // A fresh form each time the dialog opens; a cancelled draft is not saved.
  // The list remounts this component with a key on open (see
  // campaign-list-page.tsx), so the useState initialisers above already reset
  // it — no setState-in-effect (React lint) and no stale draft.

  const segment = segments.find((candidate) => candidate.id === form.segmentId);
  const preview = useSegmentPreview(segment?.definition);

  function set<Field extends keyof CampaignForm>(
    field: Field,
    value: CampaignForm[Field],
  ) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSaveFailed(false);
    // AI-12: once the copy came from the draft helper it stays labelled
    // "Dibantu AI" for this form, whether the user edits it or changes the
    // channel or audience: the generated text is still in the fields.
  }

  function fillWithDraft() {
    if (!segment) return;
    const draft = aiDraftContent({
      channel: form.channel,
      segmentName: segment.name,
      t,
    });
    setForm((current) => ({
      ...current,
      title: draft.title,
      body: draft.body,
      templateRef: draft.templateRef ?? "",
      ...(current.abEnabled
        ? {
            variantBTitle: draft.title,
            variantBBody: draft.body,
            variantBTemplateRef: draft.templateRef ?? "",
          }
        : {}),
    }));
    setErrors({});
    setSaveFailed(false);
    setAiDraft(true);
  }

  function save() {
    const next = validateCampaignForm(form, timeZone);
    setErrors(next);
    if (hasFieldErrors(next)) return;
    create.mutate(campaignBody(form, timeZone), {
      onSuccess: (campaign) => {
        toast({
          title: t("crmCampaigns.create.createdToast", { name: campaign.name }),
          tone: "success",
        });
        onOpenChange(false);
      },
      onError: () => setSaveFailed(true),
    });
  }

  const splitBp = parseSplitPercent(form.splitPercent);
  const splitValue =
    splitBp === null
      ? null
      : t("crmCampaigns.create.splitValue", {
          percent: formatSplitPercent(splitBp),
          rest: formatSplitPercent(10_000 - splitBp),
        });
  const audienceState = !form.segmentId
    ? "idle"
    : preview.isPending
      ? "loading"
      : preview.isError
        ? "error"
        : preview.data
          ? "ready"
          : "idle";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("crmCampaigns.create.title")}</DialogTitle>
          <DialogDescription>
            {t("crmCampaigns.create.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[70dvh] min-w-0 gap-4 overflow-y-auto pr-1">
          <FormField
            label={t("crmCampaigns.create.nameLabel")}
            hint={t("crmCampaigns.create.nameHint")}
            required
            error={errors.name ? t(errors.name) : undefined}
          >
            <Input
              value={form.name}
              onChange={(event) => set("name", event.target.value)}
              autoComplete="off"
            />
          </FormField>

          <FormField
            id="campaign-segment"
            label={t("crmCampaigns.create.segmentLabel")}
            hint={t("crmCampaigns.create.segmentHint")}
            required
            error={errors.segmentId ? t(errors.segmentId) : undefined}
          >
            <Select
              value={form.segmentId}
              onValueChange={(value) => set("segmentId", value)}
              disabled={segmentsQuery.isPending}
            >
              <SelectTrigger id="campaign-segment">
                <SelectValue
                  placeholder={
                    segmentsQuery.isPending
                      ? t("crmCampaigns.create.segmentLoading")
                      : t("crmCampaigns.create.segmentPlaceholder")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {segments.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {t("crmCampaigns.create.segmentOption", {
                      name: option.name,
                      count: formatNumber(option.size),
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {segmentsQuery.isError && (
            <Notice
              tone="warning"
              title={t("crmCampaigns.create.segmentLoadFailed")}
            >
              <button
                type="button"
                className="font-semibold underline underline-offset-4"
                onClick={() => void segmentsQuery.refetch()}
              >
                {t("common.retry")}
              </button>
            </Notice>
          )}
          {!segmentsQuery.isPending &&
            !segmentsQuery.isError &&
            segments.length === 0 && (
              <Notice tone="info" title={t("crmCampaigns.create.segmentEmpty")}>
                {t("crmCampaigns.consent.rule")}
              </Notice>
            )}

          <div
            data-testid="campaign-audience"
            className="grid gap-1 rounded-control bg-surface-2 px-3 py-2.5 text-sm leading-5"
            aria-live="polite"
          >
            <span className="type-eyebrow text-muted-foreground">
              {t("crmCampaigns.audience.label")}
            </span>
            <span className="font-semibold tabular">
              {audienceState === "loading"
                ? t("crmCampaigns.audience.loading")
                : audienceState === "ready"
                  ? t("crmCampaigns.audience.value", {
                      count: formatNumber(preview.data?.size ?? 0),
                    })
                  : audienceState === "error"
                    ? segment
                      ? t("crmCampaigns.audience.value", {
                          count: formatNumber(segment.size),
                        })
                      : t("crmCampaigns.audience.failed")
                    : "—"}
            </span>
            {segment !== undefined && (
              <span className="text-muted-foreground tabular">
                {t("crmCampaigns.audience.storedHint", {
                  count: formatNumber(segment.size),
                })}
              </span>
            )}
            <span className="text-muted-foreground">
              {audienceState === "error"
                ? t("crmCampaigns.audience.failed")
                : audienceState === "ready"
                  ? t("crmCampaigns.audience.liveHint")
                  : t("crmCampaigns.consent.rule")}
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              id="campaign-channel"
              label={t("crmCampaigns.create.channelLabel")}
              required
            >
              <Select
                value={form.channel}
                onValueChange={(value) =>
                  set("channel", value as CampaignChannel)
                }
              >
                <SelectTrigger id="campaign-channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CAMPAIGN_CHANNELS.map((channel) => (
                    <SelectItem key={channel} value={channel}>
                      {t(`crmCampaigns.channels.${channel}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("crmCampaigns.create.scheduledAtLabel")}
              hint={t("crmCampaigns.create.scheduledAtHint")}
              error={errors.scheduledAt ? t(errors.scheduledAt) : undefined}
            >
              <Input
                type="datetime-local"
                value={form.scheduledAt}
                onChange={(event) => set("scheduledAt", event.target.value)}
                className="tabular"
              />
            </FormField>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm leading-5 text-muted-foreground">
              {t("crmCampaigns.ai.hint")}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!segment}
              onClick={fillWithDraft}
            >
              <Sparkles aria-hidden="true" />
              {t("crmCampaigns.ai.button")}
            </Button>
          </div>

          {aiDraft && (
            <Notice
              tone="info"
              title={`${t("crmCampaigns.ai.badge")} · ${t("crmCampaigns.ai.button")}`}
            >
              {t("crmCampaigns.ai.hint")}
            </Notice>
          )}

          <FormField
            label={t("crmCampaigns.create.titleLabel")}
            required
            error={errors.title ? t(errors.title) : undefined}
          >
            <Input
              value={form.title}
              onChange={(event) => set("title", event.target.value)}
              autoComplete="off"
            />
          </FormField>

          <FormField
            label={t("crmCampaigns.create.bodyLabel")}
            hint={t("crmCampaigns.create.bodyHint")}
            required
            error={errors.body ? t(errors.body) : undefined}
          >
            <Textarea
              value={form.body}
              onChange={(event) => set("body", event.target.value)}
            />
          </FormField>

          {needsTemplateRef(form.channel) && (
            <FormField
              label={t("crmCampaigns.create.templateRefLabel")}
              hint={t("crmCampaigns.create.templateRefHint")}
              required
              error={errors.templateRef ? t(errors.templateRef) : undefined}
            >
              <Input
                value={form.templateRef}
                onChange={(event) => set("templateRef", event.target.value)}
                autoComplete="off"
              />
            </FormField>
          )}

          <div className="grid gap-3 rounded-control border-(length:--border-w) p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="grid gap-0.5">
                <Label htmlFor="campaign-ab-toggle">
                  {t("crmCampaigns.create.abToggle")}
                </Label>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("crmCampaigns.create.abHint")}
                </p>
              </div>
              <Switch
                id="campaign-ab-toggle"
                checked={form.abEnabled}
                onCheckedChange={(checked) => set("abEnabled", checked)}
              />
            </div>

            {form.abEnabled && (
              <div className="grid gap-3">
                <FormField
                  label={t("crmCampaigns.create.variantBTitle")}
                  required
                  error={
                    errors.variantBTitle ? t(errors.variantBTitle) : undefined
                  }
                >
                  <Input
                    value={form.variantBTitle}
                    onChange={(event) =>
                      set("variantBTitle", event.target.value)
                    }
                    autoComplete="off"
                  />
                </FormField>
                <FormField
                  label={t("crmCampaigns.create.variantBBody")}
                  required
                  error={
                    errors.variantBBody ? t(errors.variantBBody) : undefined
                  }
                >
                  <Textarea
                    value={form.variantBBody}
                    onChange={(event) =>
                      set("variantBBody", event.target.value)
                    }
                  />
                </FormField>
                {needsTemplateRef(form.channel) && (
                  <FormField
                    label={t("crmCampaigns.create.variantBTemplateRef")}
                    required
                    error={
                      errors.variantBTemplateRef
                        ? t(errors.variantBTemplateRef)
                        : undefined
                    }
                  >
                    <Input
                      value={form.variantBTemplateRef}
                      onChange={(event) =>
                        set("variantBTemplateRef", event.target.value)
                      }
                      autoComplete="off"
                    />
                  </FormField>
                )}
                <FormField
                  label={t("crmCampaigns.create.splitLabel")}
                  hint={t("crmCampaigns.create.splitHint")}
                  error={
                    errors.splitPercent ? t(errors.splitPercent) : undefined
                  }
                >
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    step={0.5}
                    inputMode="decimal"
                    value={form.splitPercent}
                    onChange={(event) =>
                      set("splitPercent", event.target.value)
                    }
                    className="tabular"
                  />
                </FormField>
                {splitValue && (
                  <p className="text-sm leading-5 text-muted-foreground tabular">
                    {splitValue}
                  </p>
                )}
              </div>
            )}
          </div>

          <Notice tone="info" title={t("crmCampaigns.consent.title")}>
            <p>{t("crmCampaigns.consent.rule")}</p>
            <p className="mt-1 text-muted-foreground">
              {t("crmCampaigns.consent.channelNote")}
            </p>
          </Notice>

          {saveFailed && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {t("crmCampaigns.create.saveFailed")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={save}
            loading={create.isPending}
            disabled={create.isPending}
          >
            {t("crmCampaigns.create.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
