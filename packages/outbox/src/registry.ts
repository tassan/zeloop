import type { OutboxHandler, OutboxHandlerRegistry } from "./types.js";

export function createRegistry(
  handlers: Record<string, OutboxHandler>,
): OutboxHandlerRegistry {
  const map = new Map<string, OutboxHandler>(Object.entries(handlers));
  return {
    get(eventType: string): OutboxHandler | undefined {
      return map.get(eventType);
    },
    list(): string[] {
      return [...map.keys()];
    },
  };
}
