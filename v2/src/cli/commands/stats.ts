// v2/src/cli/commands/stats.ts
// Pretty statistics dashboard — shows a summary of the human memory DB and code graph.

import { Command } from 'commander';
import { HumanMemoryStore, defaultHumanDbPath } from '../../human/store.js';
import { CodeGraphReader, defaultCodeDbPath } from '../../bridge/sqlite-ro.js';
import { deriveProjectName } from '../../config.js';

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Show a pretty statistics dashboard for the project')
    .option('--project <name>', 'Project name')
    .option('--json', 'Output as JSON instead of pretty text')
    .action((opts) => {
      const project = opts.project || deriveProjectName();
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));

      let codeReader: CodeGraphReader | undefined;
      try {
        codeReader = new CodeGraphReader(defaultCodeDbPath(project));
      } catch {
        // Code graph not available
      }

      try {
        const stats: Record<string, unknown> = {
          project,
          generated_at: new Date().toISOString(),
        };

        // Human memory stats — only include labels with count > 0 to keep output clean.
        // R15: use a single SQL query with GROUP BY instead of N queries (one per label).
        const humanStats: Record<string, number> = {};
        try {
          const labelRows = humanStore.getRawDb()
            .prepare('SELECT label, COUNT(*) AS c FROM human_nodes WHERE project = ? GROUP BY label ORDER BY c DESC')
            .all(project) as any[];
          for (const row of labelRows) {
            humanStats[row.label] = row.c;
          }
        } catch {
          // ignore — fall back to empty stats
        }
        const totalNotes = humanStore.countNodes(project);
        const totalEdges = humanStore.countEdges(project);

        stats['human_memory'] = {
          total_notes: totalNotes,
          total_edges: totalEdges,
          by_label: humanStats,
        };

        // Code graph stats
        if (codeReader) {
          const nodeCount = codeReader.countNodes(project);
          const edgeCount = codeReader.countEdges(project);
          const labelCounts = codeReader.countNodesByLabel(project);
          stats['code_graph'] = {
            total_nodes: nodeCount,
            total_edges: edgeCount,
            by_label: labelCounts,
          };
        } else {
          stats['code_graph'] = { available: false };
        }

        if (opts.json) {
          console.log(JSON.stringify(stats, null, 2));
        } else {
          printPrettyStats(stats);
        }
      } catch (e: any) {
        console.error('Error: ' + e.message);
        process.exitCode = 1;
      } finally {
        humanStore.close();
        codeReader?.close();
      }
    });
}

function printPrettyStats(stats: Record<string, unknown>): void {
  const project = stats.project as string;
  const human = stats.human_memory as any;
  const code = stats.code_graph as any;

  console.log('');
  console.log(`  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║  Codebase Memory V2 — Statistics Dashboard       ║`);
  console.log(`  ╚══════════════════════════════════════════════════╝`);
  console.log(`  Project: ${project}`);
  console.log(`  Generated: ${stats.generated_at}`);
  console.log('');

  // Human memory section
  console.log('  ┌─ Human Memory ──────────────────────────────────┐');
  console.log(`  │ Total notes:  ${String(human.total_notes).padEnd(34)}│`);
  console.log(`  │ Total edges:  ${String(human.total_edges).padEnd(34)}│`);
  console.log('  ├─────────────────────────────────────────────────┤');
  const labels = human.by_label as Record<string, number>;
  const labelEntries = Object.entries(labels).sort((a, b) => b[1] - a[1]);
  if (labelEntries.length > 0) {
    for (const [label, count] of labelEntries) {
      console.log(`  │ ${label.padEnd(20)} ${String(count).padStart(14)} notes      │`);
    }
  } else {
    console.log('  │ (no notes yet)                                  │');
  }
  console.log('  └─────────────────────────────────────────────────┘');
  console.log('');

  // Code graph section
  if (code.available !== false) {
    console.log('  ┌─ Code Graph (V1) ──────────────────────────────┐');
    console.log(`  │ Total nodes:  ${String(code.total_nodes).padEnd(34)}│`);
    console.log(`  │ Total edges:  ${String(code.total_edges).padEnd(34)}│`);
    console.log('  ├─────────────────────────────────────────────────┤');
    const codeLabels = code.by_label as Record<string, number>;
    const codeEntries = Object.entries(codeLabels).sort((a, b) => b[1] - a[1]);
    for (const [label, count] of codeEntries.slice(0, 8)) {
      console.log(`  │ ${label.padEnd(20)} ${String(count).padStart(14)} nodes      │`);
    }
    if (codeEntries.length > 8) {
      console.log(`  │ ... and ${codeEntries.length - 8} more labels${' '.repeat(Math.max(0, 25 - String(codeEntries.length - 8).length))}│`);
    }
    console.log('  └─────────────────────────────────────────────────┘');
  } else {
    console.log('  ┌─ Code Graph (V1) ──────────────────────────────┐');
    console.log('  │ ⚠️  Code graph not available                    │');
    console.log('  │    Run "cbm index_repository" to build it       │');
    console.log('  └─────────────────────────────────────────────────┘');
  }
  console.log('');
}
