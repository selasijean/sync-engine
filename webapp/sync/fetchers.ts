import type { BootstrapResponse } from "sync-engine";
import { API_URL, WORKSPACE_ID } from "./config";

export async function bootstrapFetcher(
  type: "full" | "partial",
  sinceSyncId?: number,
  onlyModels?: string[],
): Promise<BootstrapResponse> {
  const params = new URLSearchParams({ type });
  if (sinceSyncId !== undefined) {
    params.set("since", String(sinceSyncId));
  }
  if ((onlyModels?.length ?? 0) > 0) {
    params.set("onlyModels", onlyModels?.join(",") ?? "");
  }
  params.set("syncGroups", WORKSPACE_ID);

  const res = await fetch(`${API_URL}/api/bootstrap?${params}`);
  if (!res.ok) {
    throw new Error(`bootstrap ${res.status}`);
  }
  return res.json();
}

export async function transactionSender(transactions: unknown[]) {
  const res = await fetch(`${API_URL}/api/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sync-Groups": WORKSPACE_ID,
    },
    body: JSON.stringify({ transactions }),
  });
  // Always parse the JSON body — flush() checks response.success to decide
  // whether to complete or revert. Only network failures (fetch throws) should
  // trigger the retry path.
  return res.json();
}
