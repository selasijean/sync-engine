export interface SSEClient {
  onmessage: ((event: { data: string }) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((event?: any) => void) | null;
  close(): void;
}

export type SSEClientFactory = (url: string) => SSEClient;

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
        } catch {
          // ignore malformed messages
        }
      };

      this.eventSource.onerror = () => {
        this.eventSource?.close();
        this.eventSource = null;
        this.onClose();
        this.scheduleReconnect();
      };

      this.onOpen();
    } catch {
      // construction failed
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
