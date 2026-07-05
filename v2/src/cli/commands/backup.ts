// v2/src/cli/commands/backup.ts
// Backup and restore commands for the human memory DB.

import { Command } from 'commander';
import { HumanMemoryStore, defaultHumanDbPath } from '../../human/store.js';
import { safeJsonParse } from '../../constants.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveProjectName } from '../../config.js';

export function registerBackupCommand(program: Command): void {
  const backup = program.command('backup').description('Backup and restore human memory data');

  backup
    .command('export')
    .description('Export all human notes and edges to a JSON file')
    .option('--project <name>', 'Project name')
    .option('--output <path>', 'Output file path (default: ./cbm-v2-backup-<project>-<timestamp>.json)')
    .action((opts) => {
      const project = opts.project || deriveProjectName();
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));

      try {
        const notes = humanStore.listNodes(project, { limit: 100000 });
        // R15: fetch ALL edges in ONE query instead of N+1 per-note queries.
        // For 1000 notes this replaces 1000 queries with 1.
        const allEdges = humanStore.listAllEdges(project, 1000000);
        const edges: any[] = [];
        const noteIdSet = new Set(notes.map((n) => n.id));
        // Only include edges whose source note exists in our notes list (defensive).
        for (const edge of allEdges) {
          if (noteIdSet.has(edge.source_human_node_id)) {
            edges.push(edge);
          }
        }

        const backup = {
          version: '0.10.3',
          exported_at: new Date().toISOString(),
          project,
          notes: notes.map((n) => ({
            id: n.id,
            label: n.label,
            title: n.title,
            slug: n.slug,
            body_markdown: n.body_markdown,
            frontmatter_json: n.frontmatter_json,
            status: n.status,
            source: n.source,
            obsidian_path: n.obsidian_path,
            cbm_node_ids: n.cbm_node_ids,
            tags: n.tags,
            provenance: n.provenance,
            confidence: n.confidence,
            source_file: n.source_file,
            author: n.author,
            created_at: n.created_at,
            updated_at: n.updated_at,
            last_synced_at: n.last_synced_at,
          })),
          edges: edges.map((e) => ({
            id: e.id,
            source_human_node_id: e.source_human_node_id,
            target_kind: e.target_kind,
            target_cbm_node_id: e.target_cbm_node_id,
            target_human_node_id: e.target_human_node_id,
            type: e.type,
            properties_json: e.properties_json,
            provenance: e.provenance,
            confidence: e.confidence,
            source_file: e.source_file,
            created_at: e.created_at,
          })),
        };

        const outputPath =
          opts.output ||
          resolve(`cbm-v2-backup-${project}-${Date.now()}.json`);

        writeFileSync(outputPath, JSON.stringify(backup, null, 2), 'utf-8');
        console.log(`✅ Backup exported: ${outputPath}`);
        console.log(`   ${backup.notes.length} notes, ${backup.edges.length} edges`);
      } catch (e: any) {
        console.error(`Error: ${e.message}`);
        process.exitCode = 1;
      } finally {
        humanStore.close();
      }
    });

  backup
    .command('import')
    .description('Import human notes and edges from a JSON backup file')
    .argument('<file>', 'Backup JSON file path')
    .option('--project <name>', 'Project name (overrides backup project)')
    .option('--dry-run', 'Preview without writing')
    .action((file, opts) => {
      const filePath = resolve(file);
      if (!existsSync(filePath)) {
        console.error(`Error: file not found: ${filePath}`);
        process.exitCode = 1;
        return;
      }

      const project = opts.project || deriveProjectName();

      try {
        const raw = readFileSync(filePath, 'utf-8');
        let backup: any;
        try {
          backup = JSON.parse(raw);
        } catch {
          console.error('Error: invalid JSON in backup file');
          process.exitCode = 1;
          return;
        }

        if (!backup.notes || !Array.isArray(backup.notes)) {
          console.error('Error: invalid backup file (missing "notes" array)');
          process.exitCode = 1;
          return;
        }

        console.log(`Importing backup: ${filePath}`);
        console.log(`  Project: ${project}`);
        console.log(`  Notes: ${backup.notes.length}`);
        console.log(`  Edges: ${backup.edges?.length || 0}`);
        console.log(`  Exported at: ${backup.exported_at || 'unknown'}`);

        if (opts.dryRun) {
          console.log('\n(dry-run — no changes written)');
          return;
        }

        const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
        try {
          let importedNotes = 0;
          let importedEdges = 0;
          let skippedNotes = 0;

          // Import notes
          for (const note of backup.notes) {
            try {
              const existing = humanStore.getNodeBySlug(project, note.slug);
              if (existing) {
                // R15: log WHY the note was skipped (previously silent).
                // Also check if obsidian_path collides — two backups with the
                // same slug but different obsidian_paths would both be skipped
                // here, which is correct but confusing without a message.
                console.warn(`  Skip: note "${note.slug}" already exists (id=${existing.id})`);
                skippedNotes++;
                continue;
              }
              // R15: also check obsidian_path collision — if a note with the
              // same path exists under a different slug, createNode would
              // auto-suffix the slug, producing an unexpected path.
              if (note.obsidian_path) {
                const existingByPath = humanStore.getNodeByObsidianPath(project, note.obsidian_path);
                if (existingByPath) {
                  console.warn(`  Skip: note with path "${note.obsidian_path}" already exists (id=${existingByPath.id})`);
                  skippedNotes++;
                  continue;
                }
              }
              humanStore.createNode({
                project,
                label: note.label,
                title: note.title,
                body_markdown: note.body_markdown || '',
                frontmatter: safeJsonParse(note.frontmatter_json, {}),
                status: note.status || 'active',
                source: note.source || 'human',
                cbm_node_ids: note.cbm_node_ids || [],
                tags: note.tags || [],
                obsidian_path: note.obsidian_path || undefined,
                author: note.author || undefined,
              });
              importedNotes++;
            } catch (e: any) {
              console.error(`  Warning: skipped note "${note.slug}": ${e.message}`);
              skippedNotes++;
            }
          }

          // Import edges
          if (backup.edges && Array.isArray(backup.edges)) {
            // Build a map of old note IDs → new note IDs (by slug lookup)
            const oldToNewNoteId = new Map<number, number>();
            for (const oldNote of backup.notes) {
              const newNode = humanStore.getNodeBySlug(project, oldNote.slug);
              if (newNode) {
                oldToNewNoteId.set(oldNote.id, newNode.id);
              }
            }

            for (const edge of backup.edges) {
              try {
                // Remap source_human_node_id from old → new ID
                const sourceNewId = oldToNewNoteId.get(edge.source_human_node_id);
                if (!sourceNewId) continue; // source note doesn't exist

                // Remap target_human_node_id if it's a human-target edge
                let targetHumanNewId: number | null = null;
                if (edge.target_kind === 'human' && edge.target_human_node_id != null) {
                  targetHumanNewId = oldToNewNoteId.get(edge.target_human_node_id) ?? null;
                  if (!targetHumanNewId) continue; // target note doesn't exist
                }

                humanStore.createEdge({
                  project,
                  source_human_node_id: sourceNewId,
                  target_kind: edge.target_kind,
                  target_cbm_node_id: edge.target_kind === 'code' ? edge.target_cbm_node_id : null,
                  target_human_node_id: edge.target_kind === 'human' ? targetHumanNewId : null,
                  type: edge.type,
                  properties: safeJsonParse(edge.properties_json, {}),
                });
                importedEdges++;
              } catch (e: any) {
                console.error(`  Warning: skipped edge: ${e.message}`);
              }
            }
          }

          console.log(`\n✅ Import complete:`);
          console.log(`  Notes imported: ${importedNotes}`);
          console.log(`  Notes skipped (already exist): ${skippedNotes}`);
          console.log(`  Edges imported: ${importedEdges}`);
        } finally {
          humanStore.close();
        }
      } catch (e: any) {
        console.error(`Error: ${e.message}`);
        process.exitCode = 1;
      }
    });
}
