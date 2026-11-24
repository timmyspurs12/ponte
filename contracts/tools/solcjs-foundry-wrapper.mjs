#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Foundry invokes configured solc paths with --allow-paths. solcjs 0.8.28
// supports the Standard JSON interface but not that native-solc CLI flag.
// solcjs also writes a non-JSON SMT availability notice before Standard JSON.
// This adapter removes only that unsupported flag and non-JSON stdout prelude,
// then delegates compilation and preserves the compiler exit status.
//
// Why solcjs writes to a temporary file instead of a pipe
// ------------------------------------------------------
// In --standard-json mode solcjs ends with `console.log(output)` immediately
// followed by `process.exit(0)`. `process.exit` terminates the process without
// draining queued asynchronous writes, so whatever is still buffered in a pipe
// is discarded whenever stdout is not a TTY. Measured against this repository's
// reviewed source, same input and same compiler:
//
//   * solcjs stdout to a pipe  -> complete in 7/10 runs; the other 3 emitted
//     146258 or 182802 bytes and still reported exit status 0;
//   * solcjs stdout to a file  -> complete in 30/30 runs, byte-identical.
//
// The truncation therefore originates inside the compiler process, not in this
// wrapper: instrumenting the forwarding path showed the wrapper received exactly
// the bytes the child emitted and dropped none of them (`lost=0`). Writes to a
// regular file are synchronous inside solcjs, so the whole document reaches the
// filesystem before `process.exit` runs.
//
// This wrapper gives solcjs a temporary file as its stdout, reads it back after
// the child exits, strips the same non-JSON prelude as before, and forwards the
// bytes unchanged. No retry is attempted and no parsing is relaxed: a short
// document still fails to parse in Foundry exactly as it did before, but it can
// no longer be produced by this adapter.

import { spawn } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const solcjs = require.resolve("solc/solc.js");

/**
 * Sets the process exit status once every forwarded byte has been accepted by
 * our own stdout. Foundry reads this process's stdout as one Standard JSON
 * document, so exiting before the write callback fires would reintroduce the
 * same class of truncation one level up.
 */
function exitWith(status) {
  if (status.signal) {
    process.kill(process.pid, status.signal);
    return;
  }
  process.exitCode = status.code ?? 1;
}

function fail(error) {
  console.error(error);
  process.exitCode = 1;
}

/** Non Standard JSON modes keep the original inherited-stdio behaviour. */
function runPassthrough(args) {
  const child = spawn(process.execPath, [solcjs, ...args], {
    stdio: "inherit",
  });
  child.on("error", fail);
  child.on("close", (code, signal) => exitWith({ code, signal }));
}

/**
 * `--standard-json` path. The child's stdout is a regular file descriptor, so
 * its final `console.log` is written synchronously before it exits.
 */
function runStandardJson(args) {
  const directory = mkdtempSync(join(tmpdir(), "ponte-solc-"));
  const outputPath = join(directory, "stdout.json");
  const outputFd = openSync(outputPath, "w");

  let child;
  try {
    child = spawn(process.execPath, [solcjs, ...args], {
      stdio: ["inherit", outputFd, "inherit"],
    });
  } finally {
    // The child holds its own duplicate now; ours is no longer needed.
    closeSync(outputFd);
  }

  let settled = false;
  const cleanup = () => rmSync(directory, { recursive: true, force: true });

  const settle = (status) => {
    if (settled) return;
    settled = true;
    let raw;
    try {
      raw = readFileSync(outputPath, "utf8");
    } catch (error) {
      cleanup();
      fail(error);
      return;
    }
    cleanup();
    const jsonStart = raw.indexOf("{");
    const payload = jsonStart === -1 ? raw : raw.slice(jsonStart);
    process.stdout.write(payload, () => exitWith(status));
  };

  child.on("error", (error) => {
    if (settled) {
      fail(error);
      return;
    }
    settled = true;
    cleanup();
    fail(error);
  });
  child.on("close", (code, signal) => settle({ code, signal }));
}

const sanitizedArgs = [];

for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === "--allow-paths") {
    index += 1;
    continue;
  }
  sanitizedArgs.push(process.argv[index]);
}

if (sanitizedArgs.includes("--standard-json")) {
  runStandardJson(sanitizedArgs);
} else {
  runPassthrough(sanitizedArgs);
}
