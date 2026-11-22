import Module from "node:module";

// Node backend tests execute server modules outside Next's compiler. The
// `server-only` marker intentionally throws in that bare Node condition, while
// Auth.js v5 imports Next server APIs that are incompatible with the old
// `react-server` Node condition used by this runner. Stub only the marker for
// this disposable test process; application builds retain every server-only
// boundary and never load this file.
const originalLoad = Module._load;
Module._load = function loadTestServerOnlyMarker(request, parent, isMain) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
