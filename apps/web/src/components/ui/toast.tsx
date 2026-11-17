// Toasts confirm a finished action ("Pesanan dikirim"). They never carry the
// only copy of an error the user must fix: put that next to the field or in
// an ErrorState. Radix announces them politely and pauses on hover/focus.
import * as React from "react";
import { cn } from "cn";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { useT } from "@/components/i18n";

type ToastTone = "info" | "success" | "danger";
type ToastInput = { title: string; description?: string; tone?: ToastTone };
type ToastItem = ToastInput & { id: number };

const ToastContext = React.createContext<(toast: ToastInput) => void>(() => {
  throw new Error("useToast must be used inside <Toaster>");
});

export function useToast() {
  return React.useContext(ToastContext);
}

const ICONS = { info: Info, success: CircleCheck, danger: CircleAlert };
const ICON_COLOR = {
  info: "text-info",
  success: "text-success",
  danger: "text-danger",
};

// Toasts sit at the top below `sm` and bottom-right from `sm` up, so a swipe
// dismisses toward the nearest screen edge. Radix takes one direction only.
const WIDE_QUERY = "(min-width: 40rem)";
function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const isWide = () => window.matchMedia(WIDE_QUERY).matches;

export function Toaster({ children }: { children: React.ReactNode }) {
  const t = useT();
  const wide = React.useSyncExternalStore(subscribeWide, isWide, () => false);
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const nextId = React.useRef(0);
  const push = React.useCallback((toast: ToastInput) => {
    const id = ++nextId.current;
    setItems((current) => [...current.slice(-2), { ...toast, id }]);
  }, []);
  const remove = (id: number) =>
    setItems((current) => current.filter((item) => item.id !== id));

  return (
    <ToastContext.Provider value={push}>
      <ToastPrimitive.Provider swipeDirection={wide ? "down" : "up"} label={t("toast.region")}>
        {children}
        {items.map(({ id, title, description, tone = "info" }) => {
          const Icon = ICONS[tone];
          return (
            <ToastPrimitive.Root
              key={id}
              type={tone === "danger" ? "foreground" : "background"}
              onOpenChange={(open) => !open && remove(id)}
              className="flex items-start gap-3 rounded-container border bg-card p-4 text-foreground shadow-overlay data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2 sm:data-[state=open]:slide-in-from-bottom-2 data-[swipe=end]:animate-out data-[swipe=move]:translate-y-(--radix-toast-swipe-move-y)"
            >
              <Icon
                className={cn("mt-0.5 size-5 shrink-0", ICON_COLOR[tone])}
                aria-hidden="true"
              />
              <div className="grid flex-1 gap-0.5">
                <ToastPrimitive.Title className="text-sm leading-5 font-semibold">
                  {title}
                </ToastPrimitive.Title>
                {description && (
                  <ToastPrimitive.Description className="text-sm leading-5 text-muted-foreground">
                    {description}
                  </ToastPrimitive.Description>
                )}
              </div>
              <ToastPrimitive.Close
                aria-label={t("toast.dismiss")}
                className="-m-1.5 inline-grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" aria-hidden="true" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          );
        })}
        {/* On phones toasts sit at the top so they never cover bottom sheets,
            sticky actions or the bottom nav. From sm up they sit bottom-right;
            a page can lift them above its own chrome (e.g. the customer bottom
            nav) by setting --toast-inset-bottom; it defaults to 0px. */}
        <ToastPrimitive.Viewport
          label={t("toast.region")}
          className="fixed inset-x-0 top-0 z-[60] flex flex-col gap-2 p-4 pt-[max(1rem,env(safe-area-inset-top))] outline-none sm:inset-x-auto sm:top-auto sm:right-0 sm:bottom-[var(--toast-inset-bottom,0px)] sm:w-96 sm:pt-4 sm:pb-[max(1rem,env(safe-area-inset-bottom))]"
        />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
