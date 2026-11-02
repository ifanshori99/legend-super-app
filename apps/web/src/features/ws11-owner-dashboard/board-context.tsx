// One board instance per page render: the layout, the report runs and the
// latest ratings are read through this context, so section components stay
// free of fetch logic.
import { createContext, useContext, type ReactNode } from "react";
import type { OwnerBoard } from "./hooks";

const OwnerBoardContext = createContext<OwnerBoard | null>(null);

export function OwnerBoardProvider({
  board,
  children,
}: {
  board: OwnerBoard;
  children: ReactNode;
}) {
  return (
    <OwnerBoardContext.Provider value={board}>
      {children}
    </OwnerBoardContext.Provider>
  );
}

export function useOwnerBoardContext(): OwnerBoard {
  const board = useContext(OwnerBoardContext);
  if (board === null)
    throw new Error("useOwnerBoardContext must be used inside OwnerBoardProvider");
  return board;
}
