// The server's refusal of a money request, shown under the form. It takes
// focus and scrolls into view when it appears, so a keyboard or screen reader
// user lands on the reason instead of searching for it.
import * as React from "react";

export function ServerError({ message }: { message: string | null }) {
  const ref = React.useRef<HTMLParagraphElement>(null);
  React.useEffect(() => {
    if (!message) return;
    ref.current?.focus();
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [message]);
  if (!message) return null;
  return (
    <p
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="text-sm leading-5 font-medium text-danger outline-none"
    >
      {message}
    </p>
  );
}
