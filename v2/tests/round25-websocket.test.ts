// v2/tests/round25-websocket.test.ts
// Tests for R25: NotifyHub + WebSocket real-time notifications.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NotifyHub, getNotifyHub, resetNotifyHub } from '../src/ui/notify-hub.js';
import { HumanMemoryStore } from '../src/human/store.js';

describe('R25: NotifyHub', () => {
  let hub: NotifyHub;

  beforeEach(() => {
    resetNotifyHub();
    hub = getNotifyHub();
  });

  afterEach(() => {
    resetNotifyHub();
  });

  it('emits events to subscribers', () => {
    const events: any[] = [];
    hub.subscribe((event) => events.push(event));

    hub.notify('test-project', 'human_nodes_changed', { node_id: 1 });

    // Events are debounced — wait for the debounce timer.
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(events.length).toBe(1);
        expect(events[0].project).toBe('test-project');
        expect(events[0].type).toBe('human_nodes_changed');
        expect(events[0].data?.node_id).toBe(1);
        resolve(void 0);
      }, 300);
    });
  });

  it('debounces rapid events of the same type', () => {
    const events: any[] = [];
    hub.subscribe((event) => events.push(event));

    // Fire 10 events rapidly — should result in 1 debounced emission.
    for (let i = 0; i < 10; i++) {
      hub.notify('test-project', 'human_nodes_changed', { node_id: i });
    }

    return new Promise((resolve) => {
      setTimeout(() => {
        expect(events.length).toBe(1);
        resolve(void 0);
      }, 400);
    });
  });

  it('does NOT debounce events of different types', () => {
    const events: any[] = [];
    hub.subscribe((event) => events.push(event));

    hub.notify('test-project', 'human_nodes_changed');
    hub.notify('test-project', 'human_edges_changed');

    return new Promise((resolve) => {
      setTimeout(() => {
        expect(events.length).toBe(2);
        resolve(void 0);
      }, 400);
    });
  });

  it('does NOT debounce events for different projects', () => {
    const events: any[] = [];
    hub.subscribe((event) => events.push(event));

    hub.notify('proj-a', 'human_nodes_changed');
    hub.notify('proj-b', 'human_nodes_changed');

    return new Promise((resolve) => {
      setTimeout(() => {
        expect(events.length).toBe(2);
        expect(events.some((e) => e.project === 'proj-a')).toBe(true);
        expect(events.some((e) => e.project === 'proj-b')).toBe(true);
        resolve(void 0);
      }, 400);
    });
  });

  it('unsubscribe stops receiving events', () => {
    const events: any[] = [];
    const unsubscribe = hub.subscribe((event) => events.push(event));

    hub.notify('test', 'human_nodes_changed');
    unsubscribe();

    return new Promise((resolve) => {
      setTimeout(() => {
        expect(events.length).toBe(0);
        resolve(void 0);
      }, 300);
    });
  });

  it('flush emits all pending debounced events immediately', () => {
    const events: any[] = [];
    hub.subscribe((event) => events.push(event));

    hub.notify('test', 'human_nodes_changed');
    // Flush before the debounce timer fires.
    hub.flush();

    // Should be emitted immediately, not after 200ms.
    expect(events.length).toBe(1);

    return new Promise((resolve) => {
      setTimeout(() => {
        // No additional events should arrive.
        expect(events.length).toBe(1);
        resolve(void 0);
      }, 300);
    });
  });

  it('getSubscriberCount returns the correct count', () => {
    expect(hub.getSubscriberCount()).toBe(0);
    const unsub1 = hub.subscribe(() => {});
    expect(hub.getSubscriberCount()).toBe(1);
    const unsub2 = hub.subscribe(() => {});
    expect(hub.getSubscriberCount()).toBe(2);
    unsub1();
    expect(hub.getSubscriberCount()).toBe(1);
    unsub2();
    expect(hub.getSubscriberCount()).toBe(0);
  });
});

describe('R25: HumanMemoryStore emits notifications', () => {
  let hub: NotifyHub;

  beforeEach(() => {
    resetNotifyHub();
    hub = getNotifyHub();
  });

  afterEach(() => {
    resetNotifyHub();
  });

  it('emits human_nodes_changed on createNode', () => {
    const store = HumanMemoryStore.openMemory();
    store.attachNotifyHub(hub, 'test-project');

    const events: any[] = [];
    hub.subscribe((event) => events.push(event));

    store.createNode({
      project: 'test-project',
      label: 'ADR',
      title: 'Test ADR',
    });

    return new Promise((resolve) => {
      setTimeout(() => {
        expect(events.length).toBe(1);
        expect(events[0].type).toBe('human_nodes_changed');
        expect(events[0].project).toBe('test-project');
        expect(events[0].data?.action).toBe('create');
        store.close();
        resolve(void 0);
      }, 300);
    });
  });

  it('emits human_nodes_changed on updateNode', () => {
    const store = HumanMemoryStore.openMemory();
    store.attachNotifyHub(hub, 'test-project');

    const node = store.createNode({
      project: 'test-project',
      label: 'ADR',
      title: 'Original',
    });

    const events: any[] = [];
    hub.subscribe((event) => events.push(event));

    store.updateNode(node.id, { title: 'Updated' });

    return new Promise((resolve) => {
      setTimeout(() => {
        expect(events.length).toBe(1);
        expect(events[0].type).toBe('human_nodes_changed');
        expect(events[0].data?.action).toBe('update');
        store.close();
        resolve(void 0);
      }, 300);
    });
  });

  it('emits human_nodes_changed on deleteNode', () => {
    const store = HumanMemoryStore.openMemory();
    store.attachNotifyHub(hub, 'test-project');

    const node = store.createNode({
      project: 'test-project',
      label: 'ADR',
      title: 'To delete',
    });

    const events: any[] = [];
    hub.subscribe((event) => events.push(event));

    store.deleteNode(node.id);

    return new Promise((resolve) => {
      setTimeout(() => {
        expect(events.length).toBe(1);
        expect(events[0].type).toBe('human_nodes_changed');
        expect(events[0].data?.action).toBe('delete');
        store.close();
        resolve(void 0);
      }, 300);
    });
  });

  it('emits human_edges_changed on createEdge', () => {
    const store = HumanMemoryStore.openMemory();
    store.attachNotifyHub(hub, 'test-project');

    const node = store.createNode({
      project: 'test-project',
      label: 'ADR',
      title: 'Edge test',
    });

    const events: any[] = [];
    hub.subscribe((event) => events.push(event));

    store.createEdge({
      project: 'test-project',
      source_human_node_id: node.id,
      target_kind: 'code',
      target_cbm_node_id: 42,
      type: 'DECIDES',
    });

    return new Promise((resolve) => {
      setTimeout(() => {
        // createEdge with target_kind='code' triggers TWO notifications:
        // 1. human_edges_changed (the edge itself)
        // 2. human_nodes_changed (the source node's cbm_node_ids cache is updated)
        // Both are debounced separately (different types), so we expect 2 events.
        expect(events.length).toBe(2);
        const types = events.map((e) => e.type);
        expect(types).toContain('human_edges_changed');
        expect(types).toContain('human_nodes_changed');
        store.close();
        resolve(void 0);
      }, 300);
    });
  });

  it('does NOT emit when no hub is attached', () => {
    const store = HumanMemoryStore.openMemory();
    // Don't attach a hub.

    const events: any[] = [];
    hub.subscribe((event) => events.push(event));

    store.createNode({
      project: 'test-project',
      label: 'ADR',
      title: 'No hub test',
    });

    return new Promise((resolve) => {
      setTimeout(() => {
        expect(events.length).toBe(0);
        store.close();
        resolve(void 0);
      }, 300);
    });
  });
});
