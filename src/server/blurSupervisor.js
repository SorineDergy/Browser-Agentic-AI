// blurSupervisor.js — manages the Python blur service (server/blur_service)
// as a child process: starts it lazily on first use, health-checks it
// before forwarding real requests, and shuts it down after a period of
// inactivity so mediapipe + Tesseract aren't sitting loaded in memory
// between sessions.
//
// Nothing outside this file needs to know the Python process even
// exists — server.js just calls forwardBlurRequest(body).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Folder containing blur_server.py. Defaults to a "blur_service" folder
// next to this file; set BLUR_SERVICE_DIR in .env (absolute path) if your
// project is laid out differently.
const BLUR_SERVICE_DIR = process.env.BLUR_SERVICE_DIR || path.join(__dirname, "blur_service");
const BLUR_SERVICE_PORT = 8788;
const BLUR_SERVICE_URL = `http://localhost:${BLUR_SERVICE_PORT}`;

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // shut down after 5 idle minutes
const STARTUP_TIMEOUT_MS = 60_000; // first boot loads mediapipe, so be generous
const HEALTH_POLL_INTERVAL_MS = 300;
const IDLE_CHECK_INTERVAL_MS = 30_000;

// A spawned child process does NOT inherit an activated venv from your
// shell — only the venv's own python binary knows where its installed
// packages (mediapipe, pytesseract, etc.) live. If you're using a venv,
// set BLUR_SERVICE_PYTHON in server/.env to its actual python path, e.g.:
//   BLUR_SERVICE_PYTHON=/path/to/server/blur_service/.venv/bin/python
// (or ...\.venv\Scripts\python.exe on Windows). Without it, this falls
// back to whatever "python3"/"python" resolves to on your system PATH,
// which may not have the right packages installed.
const DEFAULT_PYTHON = process.platform === "win32" ? "python" : "python3";
const PYTHON_BIN = process.env.BLUR_SERVICE_PYTHON || DEFAULT_PYTHON;

let child = null;
let ready = false; // true only once the health check has passed — NOT just "process spawned"
let lastUsedAt = 0;
let starting = null; // in-flight startup promise, so concurrent requests don't spawn it twice

function isRunning() {
  return child !== null && child.exitCode === null && !child.killed;
}

async function waitForHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // If the process died during boot (bad import, port in use), stop
    // waiting immediately instead of polling until the timeout.
    if (child === null) return false;
    try {
      const res = await fetch(`${BLUR_SERVICE_URL}/health`);
      if (res.ok) return true;
    } catch {
      // Not listening yet — expected while it's still booting. Keep polling.
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

function spawnBlurService() {
  // Node reports a missing working directory as "spawn <command> ENOENT" —
  // the same message as a missing command — which is very misleading.
  // Check each thing ourselves so the error names the real culprit.
  if (!fs.existsSync(BLUR_SERVICE_DIR)) {
    throw new Error(
      `Blur service folder not found: ${BLUR_SERVICE_DIR}\n` +
        `Set BLUR_SERVICE_DIR in .env to the absolute path of the folder containing blur_server.py.`
    );
  }
  if (!fs.existsSync(path.join(BLUR_SERVICE_DIR, "blur_server.py"))) {
    throw new Error(`blur_server.py not found inside ${BLUR_SERVICE_DIR} — wrong BLUR_SERVICE_DIR?`);
  }
  if (/[\\/]/.test(PYTHON_BIN) && !fs.existsSync(PYTHON_BIN)) {
    throw new Error(`Python not found at BLUR_SERVICE_PYTHON=${PYTHON_BIN}`);
  }

  console.log(`Starting blur service:\n  python: ${PYTHON_BIN}\n  folder: ${BLUR_SERVICE_DIR}`);
  const proc = spawn(
    PYTHON_BIN,
    ["-m", "uvicorn", "blur_server:app", "--port", String(BLUR_SERVICE_PORT)],
    { cwd: BLUR_SERVICE_DIR, stdio: ["ignore", "pipe", "pipe"] }
  );

  // Prefix its output so it's clearly distinguishable in your terminal
  // from the Node server's own logs.
  proc.stdout.on("data", (d) => process.stdout.write(`[blur] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[blur] ${d}`));
  proc.on("error", (err) => {
    console.error(`Failed to launch "${PYTHON_BIN}": ${err.message}`);
    if (child === proc) { child = null; ready = false; }
  });
  proc.on("exit", (code) => {
    console.log(`Blur service exited (code ${code})`);
    if (child === proc) { child = null; ready = false; }
  });

  return proc;
}

async function ensureRunning() {
  // Check for an in-flight startup FIRST. The process counts as "running"
  // the moment it's spawned, long before it's actually accepting
  // connections — so a second concurrent request must wait on the same
  // startup, not just see a live process and charge ahead.
  if (starting) {
    await starting;
    return;
  }

  if (ready && isRunning()) return;

  starting = (async () => {
    ready = false;
    child = spawnBlurService();
    const healthy = await waitForHealthy(STARTUP_TIMEOUT_MS);
    if (healthy) {
      ready = true;
    } else {
      if (child) child.kill();
      child = null;
      throw new Error(
        `Blur service didn't become healthy — check the [blur] logs above for the ` +
          `real error (missing dependency, wrong BLUR_SERVICE_PYTHON, port ${BLUR_SERVICE_PORT} ` +
          `already in use, etc).`
      );
    }
    console.log("Blur service is up.");
  })();

  try {
    await starting;
  } finally {
    starting = null;
  }
}

async function forwardBlurRequest(body) {
  // Reset the idle clock BEFORE starting anything: after a long idle the
  // old timestamp is stale, and the idle checker could otherwise kill a
  // freshly-spawned process mid-boot.
  lastUsedAt = Date.now();
  await ensureRunning();
  lastUsedAt = Date.now();
  const res = await fetch(`${BLUR_SERVICE_URL}/blur`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  lastUsedAt = Date.now(); // and again after, since blurring itself can take a few seconds
  if (!res.ok) throw new Error(`Blur service returned ${res.status}`);
  return res.json();
}

// Periodically check for inactivity and shut the subprocess down. No
// point keeping mediapipe/Tesseract loaded once you've stopped actively
// using the extension for a while.
setInterval(() => {
  // `ready && !starting`: never shut down a service that's still booting.
  if (ready && !starting && isRunning() && Date.now() - lastUsedAt > INACTIVITY_TIMEOUT_MS) {
    console.log(`Blur service idle for ${INACTIVITY_TIMEOUT_MS / 1000}s — shutting it down.`);
    child.kill();
    child = null;
    ready = false;
  }
}, IDLE_CHECK_INTERVAL_MS).unref(); // unref: this timer alone shouldn't keep Node alive

// Clean up if the Node server itself exits, so you don't end up with an
// orphaned Python process still running after you stop `npm start`.
function killChild() {
  if (isRunning()) child.kill();
}
process.on("exit", killChild);
process.on("SIGINT", () => { killChild(); process.exit(0); });
process.on("SIGTERM", () => { killChild(); process.exit(0); });

export { forwardBlurRequest };