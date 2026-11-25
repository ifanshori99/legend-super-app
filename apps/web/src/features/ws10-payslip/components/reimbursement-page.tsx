// "Reimburse" — the employee's claims and the photo-backed request form (PRD
// v1.7 §3 F31 "Klaim dengan foto bukti, kategori, batas per jabatan, approval,
// dan pembayaran melalui payroll atau kas"; §6 H reimbursements; HR-01 own rows
// only).
//
// The receipt is a private object: the contract takes a pre-signed upload
// reference (`receiptUploadRef`), never a storage key. The mock has no bucket,
// so the browser object URL stands in for it and the claim shows its own photo
// back; a real upload endpoint is a follow-up bead.
import { useState, type ChangeEvent, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ReceiptText } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { MediaPlate } from "@/components/ui/media-plate";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  SectionEmpty,
  SectionError,
} from "@/features/ws10-hris-employee/components/section-states";
import { formatRupiah } from "@starter/shared/i18n";
import type { MessageKey } from "@starter/shared/i18n";
import type { Reimbursement } from "@starter/shared/hris/payroll";
import { ApiError } from "@/lib/api/errors";
import { useAttemptKey } from "@/features/ws05-payment-admin/use-attempt-key";
import { formatBusinessDate } from "../format.ts";
import {
  useCreateReimbursement,
  useMyReimbursements,
  useReimbursementCategories,
} from "../hooks.ts";
import {
  isBusinessDate,
  parseAmountInput,
  RECEIPT_PHOTO_TYPES,
  receiptPhotoIssue,
  reimbursementStatusKey,
  reimbursementStatusTone,
  todayBusinessDate,
} from "../state.ts";
import { PageHeader } from "./page-header.tsx";
import { StateBadge } from "./state-badge.tsx";
import { SuccessCard } from "./success-card.tsx";

type Payout = "payroll" | "cash";

type FieldErrors = Partial<
  Record<"category" | "date" | "amount" | "note" | "photo", MessageKey>
>;

type Photo = { url: string };

function ClaimCard({
  claim,
  categoryName,
}: {
  claim: Reimbursement;
  categoryName: string;
}) {
  const t = useT();
  return (
    <Card className="gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <p className="text-sm leading-5 font-semibold">{categoryName}</p>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("payslip.reimbursement.expenseDate", {
              date: formatBusinessDate(claim.expenseDate),
            })}
          </p>
        </div>
        <StateBadge tone={reimbursementStatusTone(claim.status)}>
          {t(reimbursementStatusKey(claim.status))}
        </StateBadge>
      </div>

      <div className="flex items-end justify-between gap-3">
        <p className="min-w-0 text-sm leading-5">{claim.description}</p>
        <div className="grid shrink-0 justify-items-end gap-0.5">
          <Money amount={claim.amountIdr} className="font-semibold" />
          {claim.approvedAmountIdr !== null &&
            claim.approvedAmountIdr !== claim.amountIdr && (
              <p className="text-xs leading-4 text-muted-foreground">
                {t("payslip.reimbursement.approvedAmount", {
                  amount: formatRupiah(claim.approvedAmountIdr),
                })}
              </p>
            )}
        </div>
      </div>

      {claim.receiptUrl !== null && (
        <a
          href={claim.receiptUrl}
          target="_blank"
          rel="noreferrer"
          className="block w-16"
        >
          <MediaPlate
            src={claim.receiptUrl}
            alt={t("payslip.reimbursement.receipt")}
            ratio="card"
            className="w-16"
          />
        </a>
      )}
    </Card>
  );
}

export function ReimbursementPage() {
  const t = useT();
  const query = useMyReimbursements();
  const categories = useReimbursementCategories();
  const create = useCreateReimbursement();
  const attempt = useAttemptKey();

  const [categoryId, setCategoryId] = useState("");
  const [expenseDate, setExpenseDate] = useState(todayBusinessDate());
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [payout, setPayout] = useState<Payout>("payroll");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitFailure, setSubmitFailure] = useState<MessageKey | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const activeCategories = (categories.data?.data ?? []).filter(
    (category) => category.isActive,
  );
  const selectedCategory =
    activeCategories.find((category) => category.id === categoryId) ?? null;
  const categoryNames = new Map(
    activeCategories.map((category) => [category.id, category.name]),
  );

  function handlePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clear the input so choosing the same file again still fires a change.
    event.target.value = "";
    if (!file) return;
    // UX check only (JPEG/PNG/WebP, storage `receipt` limit of 10 MiB): the
    // upload endpoint re-validates the bytes. SVG/GIF/HEIC are refused here.
    const issue = receiptPhotoIssue(file);
    if (issue !== null) {
      setErrors((current) => ({
        ...current,
        photo:
          issue === "type"
            ? "payslip.reimbursement.errors.photoType"
            : "payslip.reimbursement.errors.photoTooLarge",
      }));
      return;
    }
    // A replaced, never-submitted preview frees its memory.
    if (photo !== null) URL.revokeObjectURL(photo.url);
    // Mock: the object URL is both the preview and the upload reference, and it
    // stays valid for this page session so the created claim can show its own
    // photo back. A real build uploads to the private bucket first and receives
    // a pre-signed reference (follow-up bead).
    setPhoto({ url: URL.createObjectURL(file) });
    setErrors((current) => ({ ...current, photo: undefined }));
  }

  function validate(): { amountIdr: number; description: string } | null {
    const next: FieldErrors = {};
    if (categoryId === "")
      next.category = "payslip.reimbursement.errors.categoryRequired";

    if (expenseDate === "") {
      next.date = "payslip.reimbursement.errors.dateRequired";
    } else if (!isBusinessDate(expenseDate)) {
      next.date = "payslip.reimbursement.errors.dateInvalid";
    }

    const amountIdr = parseAmountInput(amount);
    if (amount.trim() === "") {
      next.amount = "payslip.reimbursement.errors.amountRequired";
    } else if (amountIdr === null) {
      next.amount = "payslip.reimbursement.errors.amountInvalid";
    }

    const description = note.trim();
    if (description === "") {
      next.note = "payslip.reimbursement.errors.noteRequired";
    } else if (description.length > 500) {
      next.note = "payslip.reimbursement.errors.noteTooLong";
    }

    if (selectedCategory?.receiptRequired && photo === null) {
      next.photo = "payslip.reimbursement.errors.photoRequired";
    }

    setErrors(next);
    if (Object.values(next).some(Boolean) || amountIdr === null) return null;
    return { amountIdr, description };
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitFailure(null);
    const valid = validate();
    if (!valid) return;
    // Same request after a lost response reuses its key (replay, no second
    // claim); a changed request is a new attempt.
    const body = {
      categoryId,
      expenseDate,
      amountIdr: valid.amountIdr,
      description: valid.description,
      receiptUploadRef: photo?.url ?? null,
      payout,
    };
    create.mutate(
      { ...body, idempotencyKey: attempt.keyFor(body) },
      {
        onSuccess: () => {
          attempt.settle();
          setSubmitted(true);
          setAmount("");
          setNote("");
          setPhoto(null);
          setErrors({});
        },
        onError: (error) =>
          setSubmitFailure(
            error instanceof ApiError &&
              error.code === "PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED"
              ? "payslip.reimbursement.errors.submitLimit"
              : "payslip.reimbursement.errors.submit",
          ),
      },
    );
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link to="/karyawan">
            <ChevronLeft aria-hidden="true" />
            {t("payslip.backHome")}
          </Link>
        </Button>
        <PageHeader
          title={t("payslip.reimbursement.title")}
          subtitle={t("payslip.reimbursement.subtitle")}
        />
      </div>

      <section className="grid gap-2">
        <h2 className="type-eyebrow text-muted-foreground">
          {t("payslip.reimbursement.historyTitle")}
        </h2>
        {query.isPending ? (
          <div aria-busy="true" className="grid gap-3">
            <span className="sr-only" role="status">
              {t("common.loading")}
            </span>
            <Skeleton className="h-40 w-full rounded-container" />
          </div>
        ) : query.isError ? (
          <Card>
            <SectionError
              title={t("payslip.reimbursement.listErrorTitle")}
              description={t("payslip.reimbursement.listErrorHint")}
              onRetry={() => void query.refetch()}
            />
          </Card>
        ) : query.reimbursements.length === 0 ? (
          <Card>
            <SectionEmpty
              icon={ReceiptText}
              title={t("payslip.reimbursement.emptyTitle")}
              description={t("payslip.reimbursement.emptyDescription")}
            />
          </Card>
        ) : (
          <ul className="grid gap-3">
            {query.reimbursements.map((claim) => (
              <li key={claim.id}>
                <ClaimCard
                  claim={claim}
                  categoryName={
                    categoryNames.get(claim.categoryId) ??
                    t("payslip.reimbursement.categoryUnknown")
                  }
                />
              </li>
            ))}
          </ul>
        )}

        {query.hasNextPage && (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage
              ? t("payslip.state.loadingMore")
              : t("payslip.state.loadMore")}
          </Button>
        )}
      </section>

      {submitted ? (
        <SuccessCard
          title={t("payslip.reimbursement.successTitle")}
          description={t("payslip.reimbursement.successBody")}
          actionLabel={t("payslip.reimbursement.successAction")}
          onAction={() => setSubmitted(false)}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="font-brand type-title">
              {t("payslip.reimbursement.requestTitle")}
            </CardTitle>
            <CardDescription>
              {t("payslip.reimbursement.requestSubtitle")}
            </CardDescription>
          </CardHeader>

          {categories.isPending ? (
            <div aria-busy="true" className="grid gap-2">
              <span className="sr-only" role="status">
                {t("common.loading")}
              </span>
              <Skeleton className="h-control w-full rounded-field" />
              <Skeleton className="h-control w-full rounded-field" />
            </div>
          ) : categories.isError ? (
            <SectionError
              title={t("payslip.reimbursement.categoriesErrorTitle")}
              description={t("payslip.reimbursement.categoriesErrorHint")}
              onRetry={() => void categories.refetch()}
            />
          ) : activeCategories.length === 0 ? (
            <SectionEmpty
              icon={ReceiptText}
              title={t("payslip.reimbursement.categoryEmpty")}
            />
          ) : (
            <form className="grid gap-3" noValidate onSubmit={handleSubmit}>
              <FormField
                label={t("payslip.reimbursement.categoryLabel")}
                error={errors.category ? t(errors.category) : undefined}
                required
              >
                <Select value={categoryId} onValueChange={setCategoryId}>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t(
                        "payslip.reimbursement.categoryPlaceholder",
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {activeCategories.map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField
                label={t("payslip.reimbursement.dateLabel")}
                error={errors.date ? t(errors.date) : undefined}
                required
              >
                <Input
                  type="date"
                  max={todayBusinessDate()}
                  value={expenseDate}
                  onChange={(event) => setExpenseDate(event.target.value)}
                />
              </FormField>

              <FormField
                label={t("payslip.reimbursement.amountLabel")}
                error={errors.amount ? t(errors.amount) : undefined}
                required
              >
                <Input
                  inputMode="numeric"
                  autoComplete="off"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder={t("payslip.reimbursement.amountPlaceholder")}
                />
              </FormField>

              <FormField
                label={t("payslip.reimbursement.noteLabel")}
                error={errors.note ? t(errors.note) : undefined}
                required
              >
                <Textarea
                  value={note}
                  maxLength={500}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={t("payslip.reimbursement.notePlaceholder")}
                />
              </FormField>

              <FormField
                label={t("payslip.reimbursement.photoLabel")}
                hint={t("payslip.reimbursement.photoHint")}
                error={errors.photo ? t(errors.photo) : undefined}
                required={selectedCategory?.receiptRequired ?? false}
              >
                <Input
                  type="file"
                  accept={RECEIPT_PHOTO_TYPES.join(",")}
                  onChange={handlePhoto}
                />
              </FormField>

              {photo !== null && (
                <MediaPlate
                  src={photo.url}
                  alt={t("payslip.reimbursement.receipt")}
                  ratio="card"
                  className="w-20"
                />
              )}

              <div className="grid gap-1.5">
                <p className="text-sm leading-5 font-semibold">
                  {t("payslip.reimbursement.payoutLabel")}
                </p>
                <SegmentedControl
                  label={t("payslip.reimbursement.payoutLabel")}
                  value={payout}
                  onValueChange={(value) => setPayout(value)}
                  options={[
                    {
                      value: "payroll",
                      label: t("payslip.reimbursement.payout.payroll"),
                    },
                    {
                      value: "cash",
                      label: t("payslip.reimbursement.payout.cash"),
                    },
                  ]}
                />
              </div>

              {submitFailure && (
                <div role="alert" className="grid gap-0.5">
                  <p className="text-sm leading-5 font-semibold text-danger">
                    {t(submitFailure)}
                  </p>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("payslip.reimbursement.errors.submitHint")}
                  </p>
                </div>
              )}

              <Button
                type="submit"
                size="lg"
                className="w-full"
                loading={create.isPending}
              >
                {create.isPending
                  ? t("payslip.reimbursement.submitting")
                  : t("payslip.reimbursement.submit")}
              </Button>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}
