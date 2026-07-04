// v2/tests/human/store.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HumanMemoryStore } from '../../src/human/store.js';
import { HumanNodeLabel, HumanEdgeType } from '../../src/human/schema.js';

describe('HumanMemoryStore', () => {
  let store: HumanMemoryStore;

  beforeEach(() => {
    store = HumanMemoryStore.openMemory();
  });

  afterEach(() => {
    store.close();
  });

  it('creates and retrieves a node', () => {
    const node = store.createNode({
      project: 'test',
      label: 'ADR',
      title: 'ADR-001: Test decision',
      body_markdown: 'Some body',
      tags: ['adr', 'auth'],
      cbm_node_ids: [1234, 1235],
    });
    expect(node.id).toBeGreaterThan(0);
    expect(node.slug).toBe('adr-001-test-decision');

    const retrieved = store.getNodeById(node.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe('ADR-001: Test decision');
    expect(retrieved!.cbm_node_ids).toEqual([1234, 1235]);
    expect(retrieved!.tags).toEqual(['adr', 'auth']);
  });

  it('rejects invalid label', () => {
    expect(() => {
      store.createNode({
        project: 'test',
        label: 'InvalidLabel' as any,
        title: 'Test',
      });
    }).toThrow();
  });

  it('creates and retrieves edges', () => {
    const node = store.createNode({
      project: 'test',
      label: 'ADR',
      title: 'ADR-002: Linked',
      cbm_node_ids: [42],
    });

    const edge = store.createEdge({
      project: 'test',
      source_human_node_id: node.id,
      target_kind: 'code',
      target_cbm_node_id: 42,
      type: 'DECIDES',
    });

    expect(edge.id).toBeGreaterThan(0);

    const edges = store.listEdgesToCodeNode('test', 42);
    expect(edges.length).toBe(1);
    expect(edges[0].type).toBe('DECIDES');
  });

  it('lists nodes by cbm_node_id via JSON_EACH', () => {
    store.createNode({
      project: 'test',
      label: 'BugNote',
      title: 'Bug 1',
      cbm_node_ids: [100, 200, 300],
    });
    store.createNode({
      project: 'test',
      label: 'ADR',
      title: 'ADR for 100',
      cbm_node_ids: [100],
    });

    const nodesFor100 = store.listNodesByCbmNodeId('test', 100);
    expect(nodesFor100.length).toBe(2);

    const nodesFor200 = store.listNodesByCbmNodeId('test', 200);
    expect(nodesFor200.length).toBe(1);
    expect(nodesFor200[0].title).toBe('Bug 1');
  });

  it('updates a node without changing slug', () => {
    const node = store.createNode({
      project: 'test',
      label: 'BugNote',
      title: 'Original title',
    });
    const originalSlug = node.slug;

    const updated = store.updateNode(node.id, { title: 'New title' });
    expect(updated!.title).toBe('New title');
    expect(updated!.slug).toBe(originalSlug);
  });

  it('counts nodes by label', () => {
    store.createNode({ project: 'test', label: 'ADR', title: 'ADR-1' });
    store.createNode({ project: 'test', label: 'ADR', title: 'ADR-2' });
    store.createNode({ project: 'test', label: 'BugNote', title: 'Bug-1' });

    expect(store.countNodes('test', 'ADR')).toBe(2);
    expect(store.countNodes('test', 'BugNote')).toBe(1);
    expect(store.countNodes('test')).toBe(3);
  });

  it('cascades delete edges when node deleted', () => {
    const node = store.createNode({
      project: 'test',
      label: 'ADR',
      title: 'To delete',
      cbm_node_ids: [1],
    });
    store.createEdge({
      project: 'test',
      source_human_node_id: node.id,
      target_kind: 'code',
      target_cbm_node_id: 1,
      type: 'DECIDES',
    });

    expect(store.listEdgesFromNode(node.id).length).toBe(1);
    store.deleteNode(node.id);
    expect(store.listEdgesFromNode(node.id).length).toBe(0);
  });
});
