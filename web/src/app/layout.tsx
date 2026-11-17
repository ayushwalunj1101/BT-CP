import type { Metadata } from "next";
import { Red_Hat_Display, Red_Hat_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { SheetLabel } from "@/components/SheetLabel";
import "./globals.css";
import { Providers } from "./providers";

const sans = Red_Hat_Display({ subsets: ["latin"], variable: "--font-sans" });
const mono = Red_Hat_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Obscura",
  description: "An on-chain dark pool: sealed orders, one price per batch, and a bounty that pays itself.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <Header />
          <div className="shell">
            <SheetLabel />
            <main>{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
