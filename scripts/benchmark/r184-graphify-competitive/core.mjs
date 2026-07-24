import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

export function normalizeAnswer(value) {
  let normalized = String(value ?? '').replaceAll('\r', '').trim();
  const fence = normalized.match(/^```(?:json|text)?\s*\n([\s\S]*?)\n```$/);
  if (fence) normalized = fence[1].trim();
  return normalized.replaceAll('\\', '/');
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function flatten(value, prefix = '$') {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flatten(item, `${prefix}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .flatMap((key) => flatten(value[key], `${prefix}.${key}`));
  }
  return [{ path: prefix, value }];
}

function parseCandidate(task, answerText) {
  const normalized = normalizeAnswer(answerText);
  if (task.answer_format === 'json') return stable(JSON.parse(normalized));
  if (task.answer_format === 'chain') {
    return normalized.split(/\s*->\s*/).map((part) => part.trim());
  }
  return normalized;
}

export function gradeAnswer(task, answerText) {
  let actual;
  try {
    actual = parseCandidate(task, answerText);
  } catch (error) {
    return {
      grade: 'FAIL',
      exact: false,
      expected_atoms: flatten(task.answer).length,
      correct_atoms: 0,
      wrong_extra: true,
      error: `parse failure: ${error.message}`,
    };
  }
  const expected = stable(task.answer);
  const exact = JSON.stringify(actual) === JSON.stringify(expected);
  if (exact) {
    const atomCount = flatten(expected).length;
    return {
      grade: 'PASS',
      exact: true,
      expected_atoms: atomCount,
      correct_atoms: atomCount,
      wrong_extra: false,
    };
  }

  const expectedAtoms = flatten(expected);
  const actualAtoms = flatten(actual);
  const expectedByPath = new Map(
    expectedAtoms.map((atom) => [atom.path, JSON.stringify(atom.value)]),
  );
  let correctAtoms = 0;
  let wrongExtra = false;
  for (const atom of actualAtoms) {
    const serialized = JSON.stringify(atom.value);
    if (expectedByPath.get(atom.path) === serialized) {
      correctAtoms += 1;
    } else {
      wrongExtra = true;
    }
  }
  const threshold = Math.ceil(expectedAtoms.length / 2);
  return {
    grade: !wrongExtra && correctAtoms >= threshold ? 'PARTIAL' : 'FAIL',
    exact: false,
    expected_atoms: expectedAtoms.length,
    correct_atoms: correctAtoms,
    wrong_extra: wrongExtra,
  };
}

function assertInside(root, candidate, label) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    return resolvedCandidate;
  }
  throw new Error(`${label} escapes root: ${resolvedCandidate}`);
}

function copyReplacement(mutationRoot, targetRoot, entry) {
  const source = assertInside(mutationRoot, join(mutationRoot, entry), 'replacement source');
  const destination = assertInside(targetRoot, join(targetRoot, entry), 'replacement destination');
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { force: false, errorOnExist: true });
}

export function mutateExistingFixture({ destination, mutationRoot }) {
  const manifest = JSON.parse(readFileSync(join(mutationRoot, 'mutation.json'), 'utf8'));
  for (const entry of manifest.rename) {
    const from = assertInside(destination, join(destination, entry.from), 'rename source');
    const to = assertInside(destination, join(destination, entry.to), 'rename destination');
    if (!existsSync(from) || existsSync(to)) {
      throw new Error(`Registered rename is not applicable: ${entry.from} -> ${entry.to}`);
    }
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    rmSync(to);
    copyReplacement(mutationRoot, destination, entry.replacement);
  }
  for (const entry of manifest.replace) {
    const destinationPath = assertInside(destination, join(destination, entry.path), 'replace destination');
    if (!existsSync(destinationPath)) throw new Error(`Missing replace target: ${entry.path}`);
    rmSync(destinationPath);
    copyReplacement(mutationRoot, destination, entry.replacement);
  }
  for (const entry of manifest.add) {
    const destinationPath = assertInside(destination, join(destination, entry.path), 'add destination');
    if (existsSync(destinationPath)) throw new Error(`Add target already exists: ${entry.path}`);
    copyReplacement(mutationRoot, destination, entry.source);
  }
  for (const entry of manifest.delete) {
    const destinationPath = assertInside(destination, join(destination, entry), 'delete destination');
    if (!existsSync(destinationPath)) throw new Error(`Missing delete target: ${entry}`);
    rmSync(destinationPath);
  }
  return manifest;
}

export function applyRegisteredMutation({
  sourceFixture,
  destination,
  mutationRoot,
}) {
  if (existsSync(destination)) {
    throw new Error(`Refusing to overwrite mutation destination: ${destination}`);
  }
  if (!statSync(sourceFixture).isDirectory()) {
    throw new Error(`Fixture source is not a directory: ${sourceFixture}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(sourceFixture, destination, { recursive: true, errorOnExist: true });

  return mutateExistingFixture({ destination, mutationRoot });
}

export function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

export function writeJsonExclusive(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}
