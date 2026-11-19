#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Runs the exact platform-specific Forge binary supplied by the locked
// @foundry-rs/forge package and forwards its exit status to npm.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const targets = {
  darwin: { arm64: "darwin-arm64", x64: "darwin-amd64" },
  linux: { arm64: "linux-arm64", x64: "linux-amd64" },
  win32: { x64: "win32-amd64" }
};
const target = targets[process.platform]?.[process.arch];

if (!target) {
  throw new Error(`Unsupported Forge platform: ${process.platform}/${process.arch}`);
}

const binaryName = process.platform === "win32" ? "forge.exe" : "forge";
const forge = require.resolve(`@foundry-rs/forge-${target}/bin/${binaryName}`);
const child = spawn(forge, process.argv.slice(2), { stdio: "inherit" });

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
