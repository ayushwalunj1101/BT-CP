"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "./WalletButton";

/** The site's pages, numbered like the sheets of a drawing set. SheetLabel uses the same list. */
export const PAGES = [
  { href: "/", label: "Trade" },
  { href: "/batches", label: "Batches" },
  { href: "/bounty", label: "Bounty" },
  { href: "/exchange", label: "Normal exchange" },
];

export function sheetNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

export function Header() {
  const path = usePathname();
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="brand" aria-label="Obscura, home">
          Obscura
        </Link>
        <nav className="nav" aria-label="Main">
          {PAGES.map((p, i) => (
            <Link key={p.href} href={p.href} aria-current={path === p.href ? "page" : undefined}>
              <span className="n" aria-hidden="true">
                {sheetNumber(i)}
              </span>
              {p.label}
            </Link>
          ))}
        </nav>
        <div className="topbar-end">
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
