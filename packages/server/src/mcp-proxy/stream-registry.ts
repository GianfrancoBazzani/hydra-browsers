// Registry of open MCP requests and MCP streams (spec section 8.3).

export interface StreamOwner {
  tokenId: string;
  userId: string;
  sessionId: string;
}

export interface StreamEntry extends StreamOwner {
  abort(reason: string): void;
}

export class StreamRegistry {
  readonly #entries = new Set<StreamEntry>();

  /** Adds an open request or stream. The returned function removes it (call it when the response ends). */
  register(entry: StreamEntry): () => void {
    this.#entries.add(entry);
    return () => {
      this.#entries.delete(entry);
    };
  }

  /** Removes and aborts each entry that matches. Returns the number of aborted entries. */
  closeWhere(predicate: (entry: StreamOwner) => boolean, reason: string): number {
    const matched = [...this.#entries].filter((entry) =>
      predicate({ tokenId: entry.tokenId, userId: entry.userId, sessionId: entry.sessionId }),
    );
    for (const entry of matched) {
      this.#entries.delete(entry);
      try {
        entry.abort(reason);
      } catch {
        // An abort must not stop the other closes.
      }
    }
    return matched.length;
  }

  size(): number {
    return this.#entries.size;
  }
}
