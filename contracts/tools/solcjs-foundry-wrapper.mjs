#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Foundry invokes configured solc paths with --allow-paths. solcjs 0.8.28
// supports the Standard JSON interface but not that native-solc CLI flag.
// solcjs also writes a non-JSON SMT availability notice before Standard JSON.
// This adapter removes only that unsupported flag and non-JSON stdout prelude,
// then delegates compilation and preserves the compiler exit status.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solcjs = require.resolve("solc/solc.js");
const sanitizedArgs = [];

for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === "--allow-paths") {
    index += 1;
    continue;
  }
  sanitizedArgs.push(process.argv[index]);
}

const standardJson = sanitizedArgs.includes("--standard-json");
const child = spawn(process.execPath, [solcjs, ...sanitizedArgs], {
  stdio: standardJson ? ["inherit", "pipe", "inherit"] : "inherit",
});

let pendingStdoutWrites = 0;
let childResult = null;

function finishAfterStdoutDrains() {
  if (childResult === null || pendingStdoutWrites !== 0) return;
  if (childResult.signal) {
    process.kill(process.pid, childResult.signal);
    return;
  }
  process.exitCode = childResult.code ?? 1;
}

function forwardStdout(chunk) {
  pendingStdoutWrites += 1;
  process.stdout.write(chunk, () => {
    pendingStdoutWrites -= 1;
    finishAfterStdoutDrains();
  });
}

if (standardJson) {
  let stdoutPrefix = "";
  let hasWrittenJson = false;
  child.stdout.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    if (hasWrittenJson) {
      forwardStdout(chunk);
      return;
    }

    stdoutPrefix += chunk;
    const jsonStart = stdoutPrefix.indexOf("{");
    if (jsonStart !== -1) {
      hasWrittenJson = true;
      forwardStdout(stdoutPrefix.slice(jsonStart));
      stdoutPrefix = "";
    }
  });
}

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

// Foundry consumes wrapper stdout as one Standard JSON document. Wait for every
// forwarded write callback so a large solcjs response cannot be truncated when
// the compiler closes before the wrapper's stdout has drained.
child.on("close", (code, signal) => {
  childResult = { code, signal };
  finishAfterStdoutDrains();
});
