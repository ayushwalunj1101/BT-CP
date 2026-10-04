"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "./WalletButton";

const LINKS = [
  { href: "/", label: "Trade" },
  { href: "/private", label: "Private (ZK)" },
  { href: "/batches", label: "Batches" },
  { href: "/bounty", label: "Bounty" },
  { href: "/exchange", label: "Normal exchange" },
];

export function Header() {
  const path = usePathname();
  return (
    <header className="bar">
      <Link href="/" className="brand">
        Obscura<span>dark pool</span>
      </Link>
      <nav className="nav" aria-label="Main">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>
      <WalletButton />
    </header>
  );
}
