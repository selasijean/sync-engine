import { toError, type EngineErrorContext } from "./types";

export interface SSEClient {
  onmessage: ((event: { data: string }) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((event?: any) => void) | null;
  close(): void;
}

export type SSEClientFactory = (url: string) => SSEClient;

export type SSEErrorReporter = (
  err: Error,
  context: EngineErrorContext,
) => void;

export const createBrowserSSEFactory =
  (init?: EventSourceInit): SSEClientFactory =>
  (url) =>
    new EventSource(url, init);

export abstract class BaseSSEConnection {
  private eventSource: SSEClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    protected url: string,
    private sseClientFactory: SSEClientFactory = createBrowserSSEFactory(),
    private reportError?: SSEErrorReporter,
  ) {}

  connect() {
    this.openEventSource();
  }

  disconnect() {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource != null) {
      this.eventSource.close();
      this.eventSource = null;
      this.onClose();
    }
  }

  reconnect() {
    this.openEventSource();
  }

  get isConnected() {
    return this.eventSource != null;
  }

  protected buildUrl(): string {
    return this.url;
  }

  protected abstract onMessage(data: string): void;

  protected onReconnect(): void {}
  protected onOpen(): void {}
  protected onClose(): void {}

  private openEventSource() {
    if (this.eventSource != null) {
      this.eventSource.close();
      this.eventSource = null;
      this.onClose();
    }

    const url = this.buildUrl();

    try {
      this.eventSource = this.sseClientFactory(url);

      this.eventSource.onmessage = (e) => {
        try {
          this.onMessage(e.data);
        } catch (err) {
          this.reportError?.(toError(err), {
            kind: "ssePacketParse",
            url,
            raw: e.data,
          });
        }
      };

      this.eventSource.onerror = () => {
        this.eventSource?.close();
        this.eventSource = null;
        this.onClose();
        this.scheduleReconnect();
      };

      this.onOpen();
    } catch (err) {
      this.reportError?.(toError(err), { kind: "sseConstruction", url });
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openEventSource();
      this.onReconnect();
    }, 3000);
  }
}
