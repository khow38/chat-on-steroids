/**
 * Keep node-pty's Windows exit notification tied to the native process receipt.
 * The pinned package can close its output socket before the native exit callback.
 * Patch the public event owner, preserving upstream output flushing and native binaries.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const originalHashes = {
  '1.2.0-beta.15': {
    'lib/windowsPtyAgent.js': '4f503c377b11cbd113e1f32b3932fdc35e8132b0e647f4c6b70dc84224127c53',
    'lib/windowsTerminal.js': 'b05d53d49cf9f422c2836029676ac2829f59cc14f5bbbbfaafa08382ff044267'
  },
  '1.2.0-beta.18': {
    'lib/windowsPtyAgent.js': 'b7a03bcfa8d2f6cc766ece18757154e0356f6cc558be29f6f8a86f62ba872e38',
    'lib/windowsTerminal.js': 'a805ed3bad53077b9e4572fd9ae23c4ef27b3029675e02e9b45bb3480950b3e5'
  }
};
const defaultModules = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
const patches = [
  {
    file: 'lib/windowsPtyAgent.js',
    changes: [
      [
        '        this._onError = new eventEmitter2_1.EventEmitter2();',
        '        this._onError = new eventEmitter2_1.EventEmitter2();\n        this._onExit = new eventEmitter2_1.EventEmitter2();'
      ],
      [
        '    Object.defineProperty(WindowsPtyAgent.prototype, "inSocket", {',
        [
          '    Object.defineProperty(WindowsPtyAgent.prototype, "onExit", {',
          '        get: function () { return this._onExit.event; },',
          '        enumerable: false,',
          '        configurable: true',
          '    });',
          '    Object.defineProperty(WindowsPtyAgent.prototype, "inSocket", {'
        ].join('\n')
      ],
      [
        [
          '    WindowsPtyAgent.prototype._$onProcessExit = function (exitCode) {',
          '        var _this = this;',
          '        this._exitCode = exitCode;',
          '        if (!this._useConptyDll) {',
          '            this._flushDataAndCleanUp();',
          "            this._outSocket.on('data', function () { return _this._flushDataAndCleanUp(); });",
          '        }',
          '    };'
        ].join('\n'),
        [
          '    WindowsPtyAgent.prototype._$onProcessExit = function (exitCode) {',
          '        var _this = this;',
          '        if (this._exitCode !== undefined || !Number.isInteger(exitCode)) {',
          '            return;',
          '        }',
          '        this._exitCode = exitCode;',
          '        if (!this._useConptyDll) {',
          '            this._flushDataAndCleanUp();',
          "            this._outSocket.on('data', function () { return _this._flushDataAndCleanUp(); });",
          '        }',
          '        this._onExit.fire(exitCode);',
          '    };'
        ].join('\n')
      ]
    ]
  },
  {
    file: 'lib/windowsTerminal.js',
    changes: [
      [
        [
          "        // The socket 'close' handler that drives 'exit' is only attached after",
          '        // ready_datapipe, which never fires when connect() fails.',
          '        _this._agent.onError(function () {',
          '            _this._close();',
          "            _this.emit('exit', _this._agent.exitCode);",
          '        });'
        ].join('\n'),
        [
          '        // Socket closure and the native process exit callback may arrive in either order.',
          '        // Publish once both are observed; a connection error has no native process to await.',
          '        var socketClosed = false;',
          '        var exitEmitted = false;',
          '        var emitExit = function () {',
          '            if (exitEmitted || !Number.isInteger(_this._agent.exitCode)) {',
          '                return;',
          '            }',
          '            exitEmitted = true;',
          "            _this.emit('exit', _this._agent.exitCode);",
          '        };',
          '        _this._agent.onExit(function () {',
          '            if (socketClosed) {',
          '                emitExit();',
          '            }',
          '        });',
          '        _this._agent.onError(function () {',
          '            _this._close();',
          '            emitExit();',
          '        });',
          "        _this._socket.on('close', function () {",
          '            socketClosed = true;',
          '            _this._close();',
          '            emitExit();',
          '        });'
        ].join('\n')
      ],
      [
        [
          '            // Cleanup after the socket is closed.',
          "            _this._socket.on('close', function () {",
          "                _this.emit('exit', _this._agent.exitCode);",
          '                _this._close();',
          '            });',
          '        });',
          '        _this._file = file;'
        ].join('\n'),
        [
          '        });',
          '        _this._file = file;'
        ].join('\n')
      ]
    ]
  }
];

const digest = (text) => createHash('sha256').update(text).digest('hex');

function replaceOnce(source, before, after, file) {
  const start = source.indexOf(before);
  if (start < 0 || source.indexOf(before, start + before.length) >= 0) {
    throw new Error('Unrecognized node-pty source in ' + file);
  }
  return source.slice(0, start) + after + source.slice(start + before.length);
}

function prepare(source, patch, originalSha256) {
  if (digest(source) === originalSha256) {
    const output = patch.changes.reduce((text, [before, after]) =>
      replaceOnce(text, before, after, patch.file), source);
    return { source, output, patched: false };
  }
  // Accept only the exact patched image: reverse all changes and authenticate the original.
  const original = [...patch.changes].reverse().reduce((text, [before, after]) =>
    replaceOnce(text, after, before, patch.file), source);
  if (digest(original) !== originalSha256) {
    throw new Error('Unrecognized node-pty bytes in ' + patch.file);
  }
  return { source, output: source, patched: true };
}

export async function patchNodePty(nodeModules = defaultModules, { check = false } = {}) {
  const directory = path.join(nodeModules, 'node-pty');
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const hashes = Object.hasOwn(originalHashes, metadata.version) ? originalHashes[metadata.version] : null;
  if (metadata.name !== 'node-pty' || !hashes) {
    throw new Error('The Windows exit patch does not cover this node-pty version; review it before changing the dependency.');
  }
  // Authenticate every file before writing any; refuse unrecognized pre-existing bytes.
  const prepared = await Promise.all(patches.map(async patch => ({
    file: path.join(directory, patch.file),
    ...prepare(await readFile(path.join(directory, patch.file), 'utf8'), patch, hashes[patch.file])
  })));
  if (check && prepared.some(file => !file.patched)) {
    throw new Error('The node-pty Windows exit patch is missing. Run node scripts/patch-node-pty.mjs.');
  }
  for (const file of prepared) {
    if (!file.patched) await writeFile(file.file, file.output);
  }
  return { version: metadata.version, changed: prepared.filter(file => !file.patched).length,
    files: prepared.map(file => ({ file: path.basename(file.file), sha256: digest(file.output) })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let nodeModules = defaultModules;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--node-modules' && args[i + 1]) nodeModules = path.resolve(args[++i]);
    else throw new Error('Unknown patch argument: ' + args[i]);
  }
  const result = await patchNodePty(nodeModules, { check });
  console.log(JSON.stringify(result));
}
