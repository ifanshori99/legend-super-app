// Example questions for an empty chat: four outline buttons per area. A click
// sends that question as-is. Paused while asking is paused (quota, budget,
// feature off, offline).
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { suggestionKeys, type ChatArea } from "../logic";

export function ChatSuggestions({
  area,
  onPick,
  disabled,
}: {
  area: ChatArea;
  onPick: (question: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <ul className="grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
      {suggestionKeys(area).map((key) => {
        const question = t(key as MessageKey);
        return (
          <li key={key} className="grid">
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => onPick(question)}
              className="h-auto! min-h-11 justify-start whitespace-normal px-4 py-2.5 text-start"
            >
              {question}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
