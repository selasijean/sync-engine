"use client";

import "reflect-metadata"; // must be in a client component, not a server component
import { SyncProvider } from "sync-engine/react";
import "@/sync/models"; // register models (side-effect import)
import { bootstrapFetcher, transactionSender } from "@/sync/fetchers";
import { WORKSPACE_ID, SSE_URL } from "@/sync/config";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SyncProvider
      config={{
        workspaceId: WORKSPACE_ID,
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
