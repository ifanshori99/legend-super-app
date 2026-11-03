// The form-level error, announced once (role="alert"). Field errors stay next
// to their field (DESIGN.md §4 FormField); this box is the summary an invalid or
// refused submit adds.
export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      data-slot="form-error"
      className="rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-sm leading-5 font-medium text-danger"
    >
      {message}
    </p>
  );
}
