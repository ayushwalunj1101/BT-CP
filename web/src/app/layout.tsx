import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import "./globals.css";
import { Providers } from "./providers";

const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-sans" });
const serif = Source_Serif_4({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-serif" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Obscura",
  description: "An on-chain dark pool: sealed orders, one price per batch, and a bounty that pays itself.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <div className="shell">
            <Header />
            <main>{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
