"use client";

import { usePathname } from "next/navigation";
import { PAGES, sheetNumber } from "./Header";

/** The drawing-sheet caption above each page: "SHEET 02 / 04 · BATCHES · OBSCURA DARK POOL · TESTNET". */
export function SheetLabel() {
  const path = usePathname();
  const index = PAGES.findIndex((p) => p.href === path);
  if (index < 0) return null;
  return (
    <p className="sheet" aria-hidden="true">
      Sheet {sheetNumber(index)} / {sheetNumber(PAGES.length - 1)} · {PAGES[index]!.label} · Obscura dark pool
      · testnet
    </p>
  );
}
