// v2/src/ui/notify-hub.ts
// R25: Central notification hub for real-time UI updates.
//
// Architecture:
//   - HumanMemoryStore and CodeGraphReader mutations call notify() after a
//     successful write.
//   - The hub is a singleton EventEmitter that broadcasts to all connected
//     WebSocket clients.
//   - Each WebSocket client subscribes to a specific project — only events
//     for that project are sent.
//   - Events are debounced: if 50 notes are created in a batch import, only
//     ONE 'human_nodes_changed' event is emitted (after 200ms of silence).
//
// Event types:
//   - 'human_nodes_changed'    — create/update/delete on human_nodes
//   - 'human_edges_changed'    — create/delete on human_edges
//   - 'cbm_links_changed'      — junction table mutation
//   - 'graph_reindexed'        — V1 code graph re-indexed (external signal)
//   - 'sync_completed'         — Obsidian sync finished
//
// This is the cleanest design: the store doesn't know about WebSockets,
// the hub doesn't know about the store internals, and the UI only receives
// events relevant to its active project.

import { EventEmitter } from 'node:events';

export type NotificationEvent =
  | 'human_nodes_changed'
  | 'human_edges_changed'
  | 'cbm_links_changed'
  | 'graph_reindexed'
  | 'sync_completed';

interface HubEvent {
  project: string;
  type: NotificationEvent;
  timestamp: string;
  // Optional metadata (e.g., node IDs that changed).
  data?: Record<string, unknown>;
}

/**
 * Singleton notification hub. Broadcasts events to all registered listeners
 * (typically WebSocket connections).
 *
 * Events are debounced per (project, type) to avoid flooding: if the same
 * event type fires multiple times within DEBOUNCE_MS for the same project,
 * only the last one is emitted.
 */
/** R35: stores the timer AND the event metadata so flush() can preserve data. */
interface PendingEvent {
  timer: NodeJS.Timeout;
  project: string;
  type: NotificationEvent;
  data?: Record<string, unknown>;
}

export class NotifyHub {
  private emitter = new EventEmitter();
  private debounceTimers = new Map<string, PendingEvent>();
  private static readonly DEBOUNCE_MS = 200;

  constructor() {
    // Allow many listeners (one per WebSocket connection).
    this.emitter.setMaxListeners(100);
  }

  /**
   * Emit a notification event. Debounced per (project, type): if the same
   * event fires again within DEBOUNCE_MS, only the last one is broadcast.
   *
   * The 'type' parameter accepts `string` (not just NotificationEvent) so
   * that the HumanMemoryStore can call notify() without importing the
   * NotificationEvent type — this avoids a circular dependency.
   */
  notify(project: string, type: string, data?: Record<string, unknown>): void {
    const key = `${project}:${type}`;
    // Clear any pending debounce for this key.
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing.timer);

    // R35: store the event metadata alongside the timer so flush() can
    // preserve the data payload without parsing the key.
    const pendingEvent: PendingEvent = {
      project,
      type: type as NotificationEvent,
      data,
      timer: undefined as any, // will be set below
    };

    // Schedule the emission after DEBOUNCE_MS.
    pendingEvent.timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      const event: HubEvent = {
        project,
        type: type as NotificationEvent,
        timestamp: new Date().toISOString(),
        data,
      };
      this.emitter.emit('notification', event);
    }, NotifyHub.DEBOUNCE_MS);

    this.debounceTimers.set(key, pendingEvent);
  }

  /**
   * Subscribe to all notifications. Returns an unsubscribe function.
   * The listener receives ALL events — it should filter by project.
   */
  subscribe(listener: (event: HubEvent) => void): () => void {
    this.emitter.on('notification', listener);
    return () => {
      this.emitter.off('notification', listener);
    };
  }

  /**
   * Flush all pending debounced events immediately. Used on shutdown
   * to ensure no events are lost.
   *
   * R35: preserve the original `data` by storing it alongside the timer.
   * Previously, flush() parsed the key to reconstruct project+type but
   * lost the data payload. It also used split(':', 2) which would break
   * if the project name contained a colon (unlikely but fragile).
   */
  flush(): void {
    for (const [key, entry] of this.debounceTimers) {
      clearTimeout(entry.timer);
      this.debounceTimers.delete(key);
      const event: HubEvent = {
        project: entry.project,
        type: entry.type,
        timestamp: new Date().toISOString(),
        data: entry.data,
      };
      this.emitter.emit('notification', event);
    }
  }

  /**
   * Get the number of active subscribers (for diagnostics).
   */
  getSubscriberCount(): number {
    return this.emitter.listenerCount('notification');
  }
}

/**
 * Global singleton instance. Shared between the HTTP server, WebSocket
 * server, and the store (via dependency injection).
 */
let globalHub: NotifyHub | null = null;

export function getNotifyHub(): NotifyHub {
  if (!globalHub) {
    globalHub = new NotifyHub();
  }
  return globalHub;
}

/**
 * Reset the global hub (for tests only).
 */
export function resetNotifyHub(): void {
  if (globalHub) {
    globalHub.flush();
  }
  globalHub = null;
}
