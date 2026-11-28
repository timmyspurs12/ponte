/**
 * Instrumentation preload for the module-import test.
 *
 * It wraps the official `KeyManagementServiceClient` export with a counting
 * subclass so the subprocess test can prove that importing the production
 * composition module constructs no KMS client and performs no ADC lookup at
 * module-import time, even when a valid KMS environment setting exists.
 *
 * Test-only: never loaded by the application or by any production path.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");

const originalLoad = Module._load;

Module._load = function wrappedLoad(request, parent, isMain) {
  const exports = originalLoad.call(this, request, parent, isMain);
  if (
    request === "@google-cloud/kms" &&
    exports &&
    typeof exports === "object" &&
    typeof exports.KeyManagementServiceClient === "function"
  ) {
    const Original = exports.KeyManagementServiceClient;
    exports.KeyManagementServiceClient = class CountingKmsClient extends Original {
      constructor(...args) {
        globalThis.__kmsClientConstructions =
          (globalThis.__kmsClientConstructions ?? 0) + 1;
        super(...args);
      }
    };
  }
  return exports;
};
