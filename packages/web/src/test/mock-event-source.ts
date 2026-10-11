import { vi } from 'vitest';

/** A controllable EventSource. Tests drive it with open, emit, drop, and fail. */
export class MockEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = MockEventSource.CONNECTING;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  /** The connection is open (also after a browser reconnect). */
  open(): void {
    this.readyState = MockEventSource.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  /** The server sends one event with a JSON payload. */
  emit(type: string, data: unknown): void {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  /** The connection drops. The browser connects again by itself. */
  drop(): void {
    this.readyState = MockEventSource.CONNECTING;
    this.dispatchEvent(new Event('error'));
  }

  /**
   * The server ends the response, for example after a rights change (spec section 6.5). Like
   * a dropped connection, the browser connects again by itself (HTML standard, "reestablish the
   * connection").
   */
  end(): void {
    this.readyState = MockEventSource.CONNECTING;
    this.dispatchEvent(new Event('error'));
  }

  /** The server answers with an error status. The browser gives up. */
  fail(): void {
    this.readyState = MockEventSource.CLOSED;
    this.dispatchEvent(new Event('error'));
  }

  static install(): void {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  }

  /** The newest open source for a URL. */
  static latest(url: string): MockEventSource {
    const source = MockEventSource.instances
      .filter((s) => s.url === url && s.readyState !== MockEventSource.CLOSED)
      .at(-1);
    if (!source) throw new Error(`No open EventSource for ${url}`);
    return source;
  }
}
