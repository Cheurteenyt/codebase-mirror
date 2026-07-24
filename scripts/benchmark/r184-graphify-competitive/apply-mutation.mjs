#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyRegisteredMutation } from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.split('=');
    if (!key.startsWith('--') || rest.length === 0) {
      throw new Error(`Expected --name=value, received: ${argument}`);
    }
    return [key.slice(2), rest.join('=')];
  }),
);
if (!options.source || !options.destination) {
  throw new Error('Usage: node apply-mutation.mjs --source=<fixture> --destination=<new-directory>');
}
const manifest = applyRegisteredMutation({
  sourceFixture: resolve(options.source),
  destination: resolve(options.destination),
  mutationRoot: resolve(here, 'mutation'),
});
console.log(JSON.stringify({
  destination: resolve(options.destination),
  mutation_schema_version: manifest.schema_version,
}, null, 2));
