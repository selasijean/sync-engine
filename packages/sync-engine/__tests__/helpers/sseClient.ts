import { vi } from "vitest";
import type { SSEClient, SSEClientFactory } from "@sync-engine/SyncConnection";

/** An SSEClient whose onmessage/onerror can be triggered manually. */
export function controllableSSEClient(): SSEClient & {
  triggerError: () => void;
} {
  const client: SSEClient & { triggerError: () => void } = {
    onmessage: null,
    onerror: null,
    close: vi.fn(),
    triggerError() {
      this.onerror?.(new Event("error"));
    },
  };
  return client;
}

export function makeFactory(client: SSEClient): SSEClientFactory {
  return () => client;
}

export function sendMessage(client: SSEClient, payload: unknown) {
  client.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
}
