#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');

function usage() {
  console.error('Usage: node scripts/run-with-timeout.js <timeoutSeconds> <command> [args...]');
  console.error('Example: node scripts/run-with-timeout.js 120 npm run test:unit');
}

const [, , timeoutArg, ...commandParts] = process.argv;
const timeoutSeconds = Number(timeoutArg);

if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || commandParts.length === 0) {
  usage();
  process.exit(2);
}

const displayCommand = commandParts.join(' ');
const { executable, args } = resolveCommand(commandParts, displayCommand);
const start = Date.now();
let finished = false;

function elapsedSeconds() {
  return ((Date.now() - start) / 1000).toFixed(1);
}

function log(message) {
  console.log(`[watchdog] ${message}`);
}

function killProcessTree(pid) {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 5000
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The child may have exited between timeout and kill.
    }
  }
}

log(`Command: ${displayCommand}`);
log(`Timeout: ${timeoutSeconds}s`);

const child = spawn(executable, args, {
  shell: false,
  stdio: 'inherit',
  windowsHide: true
});

const timeout = setTimeout(() => {
  if (finished) {
    return;
  }

  finished = true;
  log(`TIMEOUT after ${elapsedSeconds()}s. Killing command: ${displayCommand}`);
  try {
    child.kill('SIGTERM');
  } catch {
    // Fall through to process-tree cleanup.
  }
  killProcessTree(child.pid);
  log(`Command timed out after ${elapsedSeconds()}s; exiting with code 124.`);
  process.exit(124);
}, timeoutSeconds * 1000);

child.on('error', error => {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timeout);
  console.error(`[watchdog] Failed to start command after ${elapsedSeconds()}s: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timeout);

  log(`Command finished in ${elapsedSeconds()}s with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
  if (code === 0) {
    process.exit(0);
  }
  process.exit(code ?? 1);
});

function resolveCommand(parts, fullCommand) {
  if (process.platform === 'win32') {
    const lower = parts[0].toLowerCase();
    if (lower === 'npm' || lower === 'npx') {
      return {
        executable: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', fullCommand]
      };
    }
  }

  return {
    executable: parts[0],
    args: parts.slice(1)
  };
}
