// Route-fed slot for the OperationsShell status bar (bead legend-3wyd). The
// area frame owns the shell, but only the screen knows its own name and its
// own actions (last-updated time, refresh). A screen calls
// useOperationsScreen({ title, actions }); the frame reads the registered
// value and falls back to the area name when no screen registered one.
// Without a provider (previews, tests) the hook does nothing.
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";

export type OperationsScreenValue = {
  /** Registration that owns the slot; empty when no screen registered. */
  id: string | null;
  title: string | null;
  actions: ReactNode;
};

export type OperationsScreenAction =
  | { type: "set"; id: string; title: string; actions: ReactNode }
  | { type: "clear"; id: string };

export const EMPTY_OPERATIONS_SCREEN: OperationsScreenValue = {
  id: null,
  title: null,
  actions: null,
};

export function operationsScreenReducer(
  state: OperationsScreenValue,
  action: OperationsScreenAction,
): OperationsScreenValue {
  if (action.type === "set") {
    return { id: action.id, title: action.title, actions: action.actions };
  }
  // Only the registration that owns the slot may clear it, so a late cleanup
  // of the previous screen never wipes the screen that replaced it.
  return state.id === action.id ? EMPTY_OPERATIONS_SCREEN : state;
}

/** Screen title when one is registered, else the area name. */
export function resolveOperationsTitle(
  screen: OperationsScreenValue,
  areaTitle: string,
): string {
  return screen.title || areaTitle;
}

const ValueContext = createContext<OperationsScreenValue>(
  EMPTY_OPERATIONS_SCREEN,
);
// null = no provider. Kept apart from the value so a screen that registers
// never re-renders when the slot changes (no register loop).
const DispatchContext = createContext<Dispatch<OperationsScreenAction> | null>(
  null,
);

export function OperationsScreenProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [value, dispatch] = useReducer(
    operationsScreenReducer,
    EMPTY_OPERATIONS_SCREEN,
  );
  return (
    <DispatchContext.Provider value={dispatch}>
      <ValueContext.Provider value={value}>{children}</ValueContext.Provider>
    </DispatchContext.Provider>
  );
}

/** What the frame renders in the shell; call inside the provider. */
export function useOperationsScreenValue(): OperationsScreenValue {
  return useContext(ValueContext);
}

// useLayoutEffect warns during SSR; the slot only matters after hydration.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useOperationsScreen({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  const id = useId();
  const dispatch = useContext(DispatchContext);
  useIsomorphicLayoutEffect(() => {
    dispatch?.({ type: "set", id, title, actions: actions ?? null });
  }, [dispatch, id, title, actions]);
  useIsomorphicLayoutEffect(
    () => () => dispatch?.({ type: "clear", id }),
    [dispatch, id],
  );
}
