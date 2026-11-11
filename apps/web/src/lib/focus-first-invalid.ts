/**
 * After a submit sets field errors, move focus to the first invalid control
 * inside `root` and bring it into view. Runs on the next frame so React has
 * committed `aria-invalid` first.
 */
export function focusFirstInvalid(root: HTMLElement | null): void {
  if (!root) return;
  requestAnimationFrame(() => {
    const target = root.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center" });
  });
}
