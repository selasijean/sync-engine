"use client";

import "reflect-metadata"; // must be in a client component, not a server component
import { SyncProvider } from "@/lib/sync-engine/react";
import "@/lib/sync-engine/models"; // register models (side-effect import)
import type { BootstrapResponse } from "@/lib/sync-engine/core/StoreManager";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";
const SSE_URL = process.env.NEXT_PUBLIC_SSE_URL || "http://localhost:8081";

async function bootstrapFetcher(
  type: "full" | "partial",
  sinceSyncId?: number,
  onlyModels?: string[],
): Promise<BootstrapResponse> {
  const params = new URLSearchParams({ type });
  if (sinceSyncId !== undefined) params.set("since", String(sinceSyncId));
  if (onlyModels?.length) params.set("onlyModels", onlyModels.join(","));
  params.set("syncGroups", "demo-workspace");

  const res = await fetch(`${API_URL}/api/bootstrap?${params}`);
  if (!res.ok) throw new Error(`bootstrap ${res.status}`);
  return res.json();
}

async function transactionSender(transactions: any[]) {
  const res = await fetch(`${API_URL}/api/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sync-Groups": "demo-workspace",
    },
    body: JSON.stringify({ transactions }),
  });
  // Always parse the JSON body — flush() checks response.success to decide
  // whether to complete or revert. Only network failures (fetch throws) should
  // trigger the retry path.
  return res.json();
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SyncProvider
      config={{
        workspaceId: "demo-workspace",
        bootstrapFetcher,
        transactionSender,
        syncUrl: `${SSE_URL}/api/events`,
      }}
      fallback={
        <div style={{ padding: 40, textAlign: "center", color: "#888" }}>
          Loading sync engine...
        </div>
      }
    >
      {children}
    </SyncProvider>
  );
}
