// The only way components touch the AI guidelines.
import { useQuery } from "@tanstack/react-query";
import { aiGuidelinesQuery } from "./queries.ts";

const browser = () => typeof window !== "undefined";

export function useAiGuidelines() {
  return useQuery({ ...aiGuidelinesQuery(), enabled: browser() });
}
