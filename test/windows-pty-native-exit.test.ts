import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  UnifiedExecProcessManager, execCommandResponseText, execCommandStructuredOutput,
  type ExecCommandToolOutput
} from '../src/main/codex/unified-exec.js';

// Select an optional isolated dependency copy while keeping the complete native node-pty
// implementation. Unlike the ordering fixture, this launches a real owned Windows process.
vi.mock('node-pty', async () => {
  const { createRequire } = await import('node:module');
  const { join } = await import('node:path');
  const require = createRequire(import.meta.url);
  const source = process.env.COS_TEST_NODE_PTY_DIR;
  return { default: require(source ? join(source, 'lib', 'index.js') : 'node-pty') };
});

const managers: UnifiedExecProcessManager[] = [];
const policy = { kind: 'tokens' as const, tokens: 10_000 };
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.terminateAllProcesses()));
});

function numericTerminal(result: ExecCommandToolOutput, id: number, code: number) {
  const structured = execCommandStructuredOutput(result);
  expect(JSON.parse(JSON.stringify(structured))).toMatchObject({ completed_session_id: id, exit_code: code });
  expect(structured).not.toHaveProperty('session_id');
  expect(execCommandResponseText(result)).toContain(`Process exited with code ${code}`);
  expect(execCommandResponseText(result)).not.toContain('undefined');
  return structured;
}

for (const code of [0, 7]) {
  it.runIf(process.platform === 'win32')(`delivers the real Windows PTY process exit ${code} through completion and replay`, async () => {
    const manager = new UnifiedExecProcessManager(5_000);
    managers.push(manager);
    const id = manager.allocateProcessId();
    // Wait for actual input instead of a timed exit, so machine load cannot make the child
    // finish before the test observes and owns its running session.
    const child = [
      "if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') throw new Error('Native PTY input is required');",
      'process.stdin.setRawMode(true);',
      "process.stdin.once('data', input => {",
      "  if (input.toString() !== 'x') throw new Error('Unexpected fixture input');",
      `  process.stdout.write('native-pty-exit=${code}\\r\\n', () => process.exit(${code}));`,
      '});',
      'process.stdin.resume();',
      "process.stdout.write('native-pty-ready\\r\\n');"
    ].join('\n');
    const initial = await manager.execCommand({
      processId: id, command: [process.execPath, '-e', child], shellType: 'bash',
      hookCommand: `owned native PTY exit ${code} fixture`, cwd: process.cwd(), displayCwd: '.',
      env: process.env, tty: true, yieldTimeMs: 250, maxOutputTokens: undefined, truncationPolicy: policy
    });
    expect(initial.processId).toBe(id);
    expect(initial.completion).toBeDefined();
    const poll = (input = '', yieldTimeMs = 5_000) => manager.writeStdin({
      processId: id, input, yieldTimeMs, maxOutputTokens: undefined, truncationPolicy: policy
    });
    let startupOutput = initial.rawOutput.toString();
    const readyDeadline = Date.now() + 10_000;
    while (!startupOutput.includes('native-pty-ready') && Date.now() < readyDeadline) {
      const ready = await poll();
      expect(ready.processId).toBe(id);
      startupOutput += ready.rawOutput.toString();
    }
    expect(startupOutput).toContain('native-pty-ready');
    expect(manager.listProcesses().find(entry => entry.processId === id)?.pid).toBeGreaterThan(0);

    const terminal = await poll('x', 10_000);
    const terminalStructured = numericTerminal(terminal, id, code);
    const completion = await initial.completion!;
    expect(completion.exitCode).toBe(code);
    const replay = await poll();
    const replayStructured = numericTerminal(replay, id, code);
    expect(replayStructured).toMatchObject({ output_replayed: true });
    expect(replay.rawOutput.toString()).toContain('native-pty-ready');
    expect(replay.rawOutput.toString()).toContain(`native-pty-exit=${code}`);
    await expect(poll('must not restart')).rejects.toThrow('already completed');

    const require = createRequire(import.meta.url);
    const source = process.env.COS_TEST_NODE_PTY_DIR;
    const version = require(source ? join(source, 'package.json') : 'node-pty/package.json').version;
    console.info('WINDOWS_PTY_NATIVE_EXIT', JSON.stringify({
      dependencyVersion: version, expectedCode: code,
      start: execCommandStructuredOutput(initial), terminal: terminalStructured,
      completion, replay: replayStructured
    }));
  });
}
