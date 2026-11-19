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
  stdio: standardJson ? ["inherit", "pipe", "inherit"] : "inherit"
});

if (standardJson) {
  let stdoutPrefix = "";
  let hasWrittenJson = false;

  child.stdout.on("data", (chunk) => {
    if (hasWrittenJson) {
      process.stdout.write(chunk);
      return;
    }

    stdoutPrefix += chunk.toString("utf8");
    const jsonStart = stdoutPrefix.indexOf("{");
    if (jsonStart !== -1) {
      hasWrittenJson = true;
      process.stdout.write(stdoutPrefix.slice(jsonStart));
      stdoutPrefix = "";
    }
  });
}

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
