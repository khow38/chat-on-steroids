import { afterEach, beforeEach, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error This install/build helper is a plain Node script without declarations.
import { patchNodePty } from '../scripts/patch-node-pty.mjs';

const files = ['lib/windowsPtyAgent.js', 'lib/windowsTerminal.js'];
const installed = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
let temporary: string;
let modules: string;
let dependency: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'cos-node-pty-patch-'));
  modules = join(temporary, 'node_modules');
  dependency = join(modules, 'node-pty');
  await mkdir(join(dependency, 'lib'), { recursive: true });
  await Promise.all(['package.json', ...files].map(file =>
    copyFile(join(installed, file), join(dependency, file))));
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });
const images = () => Promise.all(files.map(file => readFile(join(dependency, file), 'utf8')));

it('checks and reapplies the authenticated patch without changing dependency bytes', async () => {
  const before = await images();
  expect(await patchNodePty(modules, { check: true })).toMatchObject({ changed: 0 });
  expect(await patchNodePty(modules)).toMatchObject({ changed: 0 });
  expect(await images()).toEqual(before);
});

it('refuses unrecognized bytes before changing either dependency file', async () => {
  const terminal = join(dependency, files[1]!);
  await writeFile(terminal, (await readFile(terminal, 'utf8')) + '\n// unrelated local edit\n');
  const before = await images();
  await expect(patchNodePty(modules)).rejects.toThrow(/Unrecognized node-pty/);
  expect(await images()).toEqual(before);
});

it('requires a reviewed version instead of applying the patch to another dependency', async () => {
  const metadataPath = join(dependency, 'package.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  metadata.version = '0.0.0-unreviewed';
  await writeFile(metadataPath, JSON.stringify(metadata));
  const before = await images();
  await expect(patchNodePty(modules)).rejects.toThrow('does not cover this node-pty version');
  expect(await images()).toEqual(before);
});
