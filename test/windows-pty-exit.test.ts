import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { Script } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  UnifiedExecProcessManager, execCommandResponseText, execCommandStructuredOutput,
  type ExecCommandToolOutput
} from '../src/main/codex/unified-exec.js';

const pty = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node-pty', () => ({ default: { spawn: pty.spawn } }));

type ExitEvent = { exitCode: number; signal?: number };
type Terminal = {
  readonly pid: number;
  onExit(listener: (event: ExitEvent) => void): unknown;
};

// Load the installed dependency's real Windows terminal, agent and event forwarding code.
// Only the OS boundary is controlled: no native process, worker or real socket is started.
// In particular, the fixture does not manufacture the public onExit event under test.
function windowsPtyHarness() {
  const require = createRequire(import.meta.url);
  const packageDir = process.env.COS_TEST_NODE_PTY_DIR || dirname(require.resolve('node-pty/package.json'));
  const lib = join(packageDir, 'lib');
  const modules = new Map<string, { exports: Record<string, unknown> }>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const callbacks = new Map<number, (code: unknown) => void>();
  const outputs: Socket[] = [];
  const workers: Conout[] = [];
  let nextTimer = 0;
  let nextPty = 0;
  let connectFailure: Error | undefined;

  class Socket extends EventEmitter {
    readable = true;
    writable = true;
    destroyed = false;
    constructor(options?: { fd: number }) {
      super();
      if (!options) outputs.push(this);
    }
    setEncoding() { return this; }
    write() { return true; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('close');
    }
  }

  class Conout {
    private ready?: () => void;
    onReady(listener: () => void) { this.ready = listener; }
    onError(_listener: (error: Error) => void) {}
    connectSocket(_socket: Socket) {}
    dispose() {}
    constructor() { workers.push(this); }
    connect() { this.ready!(); }
  }

  const native = {
    startProcess: () => {
      const id = ++nextPty;
      return { fd: 0, pty: id, conin: `fixture-in-${id}`, conout: `fixture-out-${id}` };
    },
    connect: (id: number, _command: string, _cwd: string, _env: string[], _dll: boolean,
      callback: (code: unknown) => void) => {
      if (connectFailure) throw connectFailure;
      callbacks.set(id, callback);
      // A zero fixture PID also makes UnifiedExecProcess.terminate skip OS tree killing.
      return { pid: 0 };
    },
    kill: vi.fn(), resize: vi.fn(), clear: vi.fn()
  };

  function load(filename: string): Record<string, unknown> {
    const cached = modules.get(filename);
    if (cached) return cached.exports;
    const module = { exports: {} as Record<string, unknown> };
    modules.set(filename, module);
    const localRequire = (id: string): unknown => {
      if (id === 'fs') return { openSync: () => 0 };
      if (id === 'net') return { Socket };
      if (id === 'child_process') return { fork: () => { throw new Error('Fixture must not fork an OS process'); } };
      if (id === './windowsConoutConnection') return { ConoutConnection: Conout };
      if (id === './utils') return {
        ...require(join(lib, 'utils.js')),
        loadNativeModule: () => ({ module: native })
      };
      if (id.startsWith('.')) return load(resolve(dirname(filename), `${id}.js`));
      return require(id);
    };
    const evaluate = new Script(
      `(function(require, module, exports, __filename, __dirname) {\n${readFileSync(filename, 'utf8')}\n})`,
      { filename }
    ).runInNewContext({
      console, Buffer,
      process: { env: {}, cwd: () => process.cwd(), kill: () => { throw new Error('Fixture must not signal an OS process'); } },
      setTimeout: (callback: () => void, delay: number) => {
        const id = ++nextTimer;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (id: number) => { timers.delete(id); }
    }) as (require: (id: string) => unknown, module: { exports: Record<string, unknown> },
      exports: Record<string, unknown>, filename: string, directory: string) => void;
    evaluate(localRequire, module, module.exports, filename, dirname(filename));
    return module.exports;
  }

  const WindowsTerminal = load(join(lib, 'windowsTerminal.js')).WindowsTerminal as
    new (file: string, args: string[] | string, options: Record<string, unknown>) => Terminal;
  type Spawned = {
    terminal: Terminal; exits: ReturnType<typeof vi.fn>;
    connect(): void; data(text: string): void; close(): void;
    duplicateClose(): void; nativeExit(code: unknown): void;
  };
  let receiveSpawn: ((record: Spawned) => void) | undefined;
  return {
    nextSpawn: () => new Promise<Spawned>(resolve => { receiveSpawn = resolve; }),
    failConnect: (error: Error) => { connectFailure = error; },
    spawn: (file: string, args: string[] | string, options: Record<string, unknown>) => {
      const terminal = new WindowsTerminal(file, args, options);
      const id = nextPty;
      const output = outputs.at(-1)!;
      const worker = workers.at(-1)!;
      const exits = vi.fn();
      terminal.onExit(exits);
      const record: Spawned = {
        terminal, exits,
        connect: () => { worker.connect(); if (callbacks.has(id)) output.emit('connect'); },
        data: text => { output.emit('data', text); },
        close: () => output.destroy(),
        duplicateClose: () => { output.emit('close'); },
        nativeExit: code => { callbacks.get(id)!(code); }
      };
      receiveSpawn!(record);
      receiveSpawn = undefined;
      return terminal;
    },
    flushOutput: () => {
      // Exercise the real agent's existing post-exit flush callback without sleeping.
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 1_000) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    dispose: () => { timers.clear(); }
  };
}

let harness: ReturnType<typeof windowsPtyHarness>;
let manager: UnifiedExecProcessManager;
const policy = { kind: 'tokens' as const, tokens: 10_000 };
beforeEach(() => {
  harness = windowsPtyHarness();
  pty.spawn.mockImplementation(harness.spawn);
  manager = new UnifiedExecProcessManager(5_000);
});
afterEach(async () => {
  await manager.terminateAllProcesses();
  harness.dispose();
  pty.spawn.mockReset();
});

async function start(connects = true) {
  const id = manager.allocateProcessId();
  const spawned = harness.nextSpawn();
  const pending = manager.execCommand({
    processId: id, command: ['fixture-shell'], shellType: 'bash',
    hookCommand: 'Windows PTY exit ordering', cwd: process.cwd(), displayCwd: '/fixture',
    env: {}, tty: true, yieldTimeMs: 250, maxOutputTokens: undefined, truncationPolicy: policy
  });
  const record = await spawned;
  record.connect();
  if (connects) record.data('ready\r\n');
  const initial = await pending;
  return { id, record, initial };
}

function poll(id: number, input = '') {
  return manager.writeStdin({ processId: id, input, yieldTimeMs: 250,
    maxOutputTokens: undefined, truncationPolicy: policy });
}

function expectNumericTerminal(result: ExecCommandToolOutput, id: number, code: number) {
  const structured = execCommandStructuredOutput(result);
  expect(JSON.parse(JSON.stringify(structured))).toMatchObject({ completed_session_id: id, exit_code: code });
  expect(structured).not.toHaveProperty('session_id');
  expect(execCommandResponseText(result)).toContain(`Process exited with code ${code}`);
  expect(execCommandResponseText(result)).not.toContain('undefined');
}

for (const code of [0, 7]) {
  it(`waits for the real native exit ${code} after the output socket has closed`, async () => {
    const { id, record, initial } = await start();
    const completed = vi.fn();
    void initial.completion!.then(completed);
    record.data('last output\r\n');
    record.close();
    const beforeNativeExit = await poll(id);
    expect(execCommandStructuredOutput(beforeNativeExit)).toMatchObject({ session_id: id });
    expect(execCommandStructuredOutput(beforeNativeExit)).not.toHaveProperty('completed_session_id');
    expect(beforeNativeExit.rawOutput.toString()).toBe('last output\r\n');
    expect(completed).not.toHaveBeenCalled();
    expect(record.exits).not.toHaveBeenCalled();
    expect(manager.backgroundState(new Set([id]))).toEqual({ running: [id], exitedUnread: [] });
    expect(await manager.offerCompletedOutput(new Set([id]), { completedAt: null, failed: false }, 1000)).toBeNull();

    record.nativeExit(code);
    await expect(initial.completion).resolves.toMatchObject({ exitCode: code });
    expect(completed).toHaveBeenCalledOnce();
    expect(record.exits).toHaveBeenCalledOnce();
    expectNumericTerminal(await poll(id), id, code);
    const replay = await poll(id);
    expectNumericTerminal(replay, id, code);
    expect(execCommandStructuredOutput(replay)).toMatchObject({ output_replayed: true });
    expect(replay.rawOutput.toString()).toBe('ready\r\nlast output\r\n');
    await expect(poll(id, 'must not restart')).rejects.toThrow('already completed');
  });
}

it('keeps the real native exit pending until the final output has drained', async () => {
  const { id, record, initial } = await start();
  const completed = vi.fn();
  void initial.completion!.then(completed);
  record.nativeExit(7);
  record.data('tail after native exit\r\n');
  const stillDraining = await poll(id);
  expect(stillDraining).toMatchObject({ processId: id, exitCode: null });
  expect(stillDraining.rawOutput.toString()).toBe('tail after native exit\r\n');
  expect(record.exits).not.toHaveBeenCalled();
  expect(completed).not.toHaveBeenCalled();
  harness.flushOutput();
  await expect(initial.completion).resolves.toMatchObject({ exitCode: 7 });
  expectNumericTerminal(await poll(id), id, 7);
  expect((await poll(id)).rawOutput.toString()).toBe('ready\r\ntail after native exit\r\n');
});

it('publishes one terminal event and preserves its code across duplicate notifications', async () => {
  const { id, record } = await start();
  record.nativeExit(7);
  harness.flushOutput();
  expectNumericTerminal(await poll(id), id, 7);
  record.duplicateClose();
  record.nativeExit(0);
  record.duplicateClose();
  harness.flushOutput();
  expect(record.exits).toHaveBeenCalledOnce();
  expectNumericTerminal(await poll(id), id, 7);
});

it('uses each terminal own native receipt when two output sockets close first', async () => {
  const a = await start();
  const b = await start();
  a.record.close();
  b.record.close();
  expect(manager.backgroundState(new Set([a.id, b.id]))).toEqual({
    running: [a.id, b.id].sort((left, right) => left - right), exitedUnread: []
  });
  b.record.nativeExit(7);
  expectNumericTerminal(await poll(b.id), b.id, 7);
  expect(manager.backgroundState(new Set([a.id]))).toEqual({ running: [a.id], exitedUnread: [] });
  expect(a.record.exits).not.toHaveBeenCalled();
  a.record.nativeExit(0);
  expectNumericTerminal(await poll(a.id), a.id, 0);
  expect(a.record.exits).toHaveBeenCalledOnce();
  expect(b.record.exits).toHaveBeenCalledOnce();
});

it('preserves the upstream numeric connection error before ready_datapipe', async () => {
  harness.failConnect(new Error('CreateProcess failed, error code: 5'));
  const { id, record, initial } = await start(false);
  expectNumericTerminal(initial, id, 5);
  expect(record.exits).toHaveBeenCalledOnce();
  expectNumericTerminal(await poll(id), id, 5);
});

for (const malformed of [undefined, Number.NaN]) {
  it(`does not complete from a malformed native exit (${String(malformed)})`, async () => {
    const { id, record, initial } = await start();
    record.data('awaiting exit status\r\n');
    record.nativeExit(malformed);
    record.close();
    const waiting = await poll(id);
    expect(waiting).toMatchObject({ processId: id, exitCode: null });
    expect(record.exits).not.toHaveBeenCalled();
    record.nativeExit(7);
    await expect(initial.completion).resolves.toMatchObject({ exitCode: 7 });
    expectNumericTerminal(await poll(id), id, 7);
  });
}
