"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Your sealed orders, kept in this browser. A ticket holds the salt needed to reveal; losing it means
 * the order cannot be revealed and its bond is forfeited, so the page also lets you download it.
 */
export type Ticket = {
  epoch: string;
  index: string;
  isBuy: boolean;
  /** Limit price and amount, in 18-decimal units. */
  limit: string;
  amount: string;
  salt: string;
  commitment: string;
  txHash: string;
};

function storageKey(scope: string) {
  return `obscura:tickets:${scope}`;
}

function load(scope: string): Ticket[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey(scope)) ?? "[]") as Ticket[];
  } catch {
    return [];
  }
}

/** Tickets for one chain, auction and account. `scope` is null until all three are known. */
export function useTickets(scope: string | null) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  useEffect(() => setTickets(scope ? load(scope) : []), [scope]);

  const save = useCallback(
    (next: Ticket[]) => {
      setTickets(next);
      if (!scope) return;
      try {
        localStorage.setItem(storageKey(scope), JSON.stringify(next));
      } catch {
        // storage unavailable (private window): tickets live for this session only
      }
    },
    [scope],
  );

  const add = useCallback(
    (t: Ticket) => save([t, ...(scope ? load(scope) : tickets)]),
    [save, scope, tickets],
  );
  const update = useCallback(
    (txHash: string, patch: Partial<Ticket>) =>
      save((scope ? load(scope) : tickets).map((t) => (t.txHash === txHash ? { ...t, ...patch } : t))),
    [save, scope, tickets],
  );
  const remove = useCallback(
    (txHash: string) => save((scope ? load(scope) : tickets).filter((t) => t.txHash !== txHash)),
    [save, scope, tickets],
  );
  return { tickets, add, update, remove };
}

/** Offer a ticket as a JSON file. */
export function downloadTicket(t: Ticket, extra: Record<string, string>) {
  const blob = new Blob([JSON.stringify({ ...extra, ...t }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `obscura-batch-${t.epoch}-${t.index}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
