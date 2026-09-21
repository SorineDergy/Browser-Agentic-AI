// background.js — the coordinator/hub. Everything routes through here.
// Message shape convention: { type: string, payload: any }
//
// This implements the observe -> decide -> act -> re-observe loop from
// AGENT_PROTOCOL.md, replacing the earlier one-shot "execute a whole
// action list" design. See that doc for the full request/response
// contract this code implements.

const SERVER_URL = "http://localhost:8787/agent"; // swap for your real endpoint
const BLUR_SERVER_URL = "http://localhost:8788/blur"; // your local Python blur service
const MAX_STEPS = 15; // circuit breaker so a confused model can't loop forever

async function blurImageLocally(dataUrl) {
  const res = await fetch(BLUR_SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUrl }),
  });
  if (!res.ok) throw new Error(`Blur service returned ${res.status}`);
  const { image } = await res.json();
  return image;
}

// --- DOM inspection (injected on demand, no persistent content script) -
// Pulls a simplified list of interactive elements + a stable selector for
// each. This is what lets the server model say "click #submit" reliably
// instead of guessing coordinates.

function extractInteractiveElements() {
  const els = Array.from(
    document.querySelectorAll("a, button, input, select, textarea, [role=button]")
  ).slice(0, 200); // cap so payloads stay small

  function cssPath(el) {
    if (el.id) return `#${el.id}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let selector = node.tagName.toLowerCase();
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter(
            (c) => c.tagName === node.tagName
          )
        : [];
      if (siblings.length > 1) {
        selector += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(selector);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  return els.map((el) => ({
    selector: cssPath(el),
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || el.placeholder || "").trim().slice(0, 80),
    type: el.type || null,
  }));
}

// --- Action execution via chrome.debugger (Chrome DevTools Protocol) ----
// Synthetic DOM events (MouseEvent, dispatchEvent) always have
// event.isTrusted === false — some sites (bot-detection, React-controlled
// inputs) specifically check that and silently ignore untrusted events.
// chrome.debugger attaches the real DevTools protocol to the tab and
// dispatches input the same way actual DevTools does, indistinguishable
// from a real user action. Tradeoff: Chrome shows a persistent
// "<extension> is debugging this browser" banner for the whole session,
// and you can't have real DevTools open on the same tab at the same time.

const PROTOCOL_VERSION = "1.3";
const attachedTabs = new Set();

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    if (attachedTabs.has(tabId)) return resolve();
    chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, () => {
      if (chrome.runtime.lastError) {
        // Common cause: real DevTools is already open on this tab —
        // Chrome only allows one debugger client attached at a time.
        return reject(new Error(`chrome.debugger.attach failed: ${chrome.runtime.lastError.message}`));
      }
      attachedTabs.add(tabId);
      resolve();
    });
  });
}

function detachDebugger(tabId) {
  return new Promise((resolve) => {
    if (!attachedTabs.has(tabId)) return resolve();
    chrome.debugger.detach({ tabId }, () => {
      attachedTabs.delete(tabId);
      lastCursorPosition.delete(tabId);
      resolve(); // don't reject even if detach errors — we're cleaning up either way
    });
  });
}

// If the user opens real DevTools mid-loop, or closes the tab, Chrome
// force-detaches us — keep our own bookkeeping in sync with that.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attachedTabs.delete(source.tabId);
});

function sendDebuggerCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(`${method} failed: ${chrome.runtime.lastError.message}`));
      }
      resolve(result);
    });
  });
}

// Finds the element and returns the viewport-relative pixel coordinates
// of its center — CDP dispatches input by coordinate, not by selector,
// so this translation step is necessary. Scrolls the element into view
// first so the coordinates are actually valid on screen.
function getElementCenter(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  el.scrollIntoView({ block: "center" });
  const rect = el.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

// Tracks where the simulated cursor last was, per tab — a curved path
// needs a real starting point, not just the destination. Without this,
// the first move of every click would still be a straight teleport.
const lastCursorPosition = new Map();

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

// Builds a slightly-curved, jittered path between two points instead of
// a straight line — a quadratic Bezier with a randomly-offset control
// point, sampled into N intermediate steps, each nudged by a small
// random jitter (except the final point, which lands exactly on target).
// This is a real, if simple, improvement over a single teleport-to-target
// mouseMoved event — see the conversation this came from for why a
// straight line (or a single jump) is a much easier tell than this.
function buildCurvedPath(start, end, steps = 18) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);

  // Control point offset perpendicular to the straight line, scaled by
  // distance so short moves don't curve wildly and long moves don't stay
  // suspiciously straight.
  const curveStrength = randomBetween(0.15, 0.35) * distance * (Math.random() < 0.5 ? -1 : 1);
  const midX = (start.x + end.x) / 2 - (dy / (distance || 1)) * curveStrength;
  const midY = (start.y + end.y) / 2 + (dx / (distance || 1)) * curveStrength;

  const points = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Quadratic Bezier: (1-t)^2 * start + 2(1-t)t * control + t^2 * end
    const bx = (1 - t) ** 2 * start.x + 2 * (1 - t) * t * midX + t ** 2 * end.x;
    const by = (1 - t) ** 2 * start.y + 2 * (1 - t) * t * midY + t ** 2 * end.y;
    const isLast = i === steps;
    points.push({
      x: isLast ? end.x : bx + randomBetween(-2, 2),
      y: isLast ? end.y : by + randomBetween(-2, 2),
    });
  }
  return points;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function moveMouseAlongPath(tabId, path) {
  for (const point of path) {
    await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    await sleep(randomBetween(6, 18)); // real movement isn't instant between frames either
  }
}

async function clickViaDebugger(tabId, selector) {
  const [{ result: center }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: getElementCenter,
    args: [selector],
  });
  if (!center) return { ok: false };

  const start = lastCursorPosition.get(tabId) || {
    x: center.x + randomBetween(-120, 120),
    y: center.y + randomBetween(-120, 120),
  };
  const path = buildCurvedPath(start, center);
  await moveMouseAlongPath(tabId, path);
  lastCursorPosition.set(tabId, center);

  const { x, y } = center;
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sleep(randomBetween(40, 120)); // real clicks hold the button briefly, not instantly
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  return { ok: true };
}

async function typeViaDebugger(tabId, selector, text) {
  // Click first to focus the field for real.
  const clicked = await clickViaDebugger(tabId, selector);
  if (!clicked.ok) return { ok: false };

  // Real per-keystroke events instead of Input.insertText, which pastes
  // the whole string at once with no keydown/keyup sequence at all —
  // arguably an even easier tell than a straight-line mouse move, since
  // there's no keystroke choreography to analyze whatsoever.
  //
  // Known limitation: this handles plain printable characters (the
  // common case for filling in a search box or form field). It doesn't
  // map special keys (Backspace, Enter, arrows) to their proper CDP key
  // codes — worth extending if you need those, using a US-keyboard-layout
  // table the way tools like Puppeteer do internally.
  for (const char of text || "") {
    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      text: char,
      unmodifiedText: char,
      key: char,
    });
    await sleep(randomBetween(20, 60));
    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: char,
    });
    await sleep(randomBetween(60, 180)); // human inter-key timing varies a lot, not a fixed cadence
  }
  return { ok: true };
}

// --- scroll only — click/type moved to the debugger-based functions above

function dispatchAction(action) {
  // Runs inside the target page via chrome.scripting.executeScript.
  // Only scroll is left here: it doesn't hit isTrusted checks the way
  // clicks/typing can, so plain JS is fine and avoids an unnecessary
  // debugger round-trip for something this simple.
  if (action.type === "scroll") {
    const amount = action.amount || 500;
    window.scrollBy(0, action.direction === "up" ? -amount : amount);
    return { ok: true, action };
  }
  return { ok: false, action };
}

async function executeSingleAction(tabId, action) {
  if (action.type === "navigate") {
    await chrome.tabs.update(tabId, { url: action.url });
    await new Promise((r) => setTimeout(r, 1000)); // give navigation time to start
    return { ok: true, action };
  }
  if (action.type === "wait") {
    await new Promise((r) => setTimeout(r, action.ms || 500));
    return { ok: true, action };
  }
  if (action.type === "click") {
    const result = await clickViaDebugger(tabId, action.selector);
    await new Promise((r) => setTimeout(r, 300)); // let the page react before re-observing
    return { ...result, action };
  }
  if (action.type === "type") {
    const result = await typeViaDebugger(tabId, action.selector, action.text);
    await new Promise((r) => setTimeout(r, 300));
    return { ...result, action };
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: dispatchAction,
    args: [action],
  });
  await new Promise((r) => setTimeout(r, 300)); // let the page react before re-observing
  return result;
}

// --- One observe/decide round-trip --------------------------------------

async function observe(tabId, userGoal, stepNumber, history) {
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
  const blurredDataUrl = await blurImageLocally(screenshotDataUrl);

  const tab = await chrome.tabs.get(tabId);
  const [{ result: elements }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractInteractiveElements,
  });

  const observation = {
    user_goal: userGoal,
    current_url: tab.url,
    step_number: stepNumber,
    max_steps: MAX_STEPS,
    screenshot: blurredDataUrl, // blurred only — raw screenshot never leaves this function
    interactive_elements: elements,
    history,
  };

  const res = await fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(observation),
  });
  if (!res.ok) throw new Error(`Reasoning server returned ${res.status}`);
  return res.json(); // the step_type decision object, per AGENT_PROTOCOL.md
}

// --- Keeping the service worker alive during a slow model call ----------
// MV3 service workers can be terminated by Chrome independently of
// whether a fetch is still pending — a bare `await fetch(...)` doesn't
// reliably count as "activity" that resets Chrome's own timers. A local
// model call can take minutes (see providers/ollama.js), which is long
// enough to hit this. Periodically calling a trivial extension API
// resets the idle clock and keeps the worker (and the in-flight request)
// alive for the duration of the loop.

let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {}); // trivial call, result unused
  }, 20_000);
}

function stopKeepAlive() {
  clearInterval(keepAliveInterval);
  keepAliveInterval = null;
}

// --- Broadcasting progress to the side panel ----------------------------
// The side panel isn't guaranteed to have a listener open (e.g. if closed),
// so these are fire-and-forget: swallow the "no receiver" rejection.

function broadcastStatus(payload) {
  chrome.runtime.sendMessage({ type: "AGENT_STATUS", payload }).catch(() => {});
}

// --- needs_confirmation handshake ---------------------------------------
// The loop pauses mid-flight and waits for the side panel to send back a
// USER_CONFIRM_ACTION message with the same requestId before continuing.

const pendingConfirmations = new Map();

function waitForConfirmation(requestId) {
  return new Promise((resolve) => {
    pendingConfirmations.set(requestId, resolve);
  });
}

// --- needs_input handshake -----------------------------------------------
// Same pattern as confirmations: the loop pauses and waits for a
// USER_ANSWER message with the matching requestId, then resumes with the
// answer folded into `history` — rather than ending the loop and
// discarding everything gathered so far, which is what happened before.

const pendingAnswers = new Map();

function waitForAnswer(requestId) {
  return new Promise((resolve) => {
    pendingAnswers.set(requestId, resolve);
  });
}

// --- The main loop: observe -> decide -> act -> re-observe --------------
//
// Note: this no longer takes/calls a `sendResponse` for its final result.
// A single long-lived response channel can't survive the service worker
// being restarted mid-loop (which is exactly what was causing the
// "message channel closed" error with slow local-model calls) — so the
// outcome is reported entirely through broadcastStatus() instead, the
// same mechanism already used for step-by-step progress. Each broadcast
// is its own independent message, so a worker restart between broadcasts
// loses nothing already sent.

async function runAgentLoop(userGoal) {
  startKeepAlive();
  let tabId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab.id;
    await attachDebugger(tabId); // shows the "is debugging this browser" banner for this tab
    const history = [];

    for (let step = 1; step <= MAX_STEPS; step++) {
      broadcastStatus({ kind: "observing", step });
      const decision = await observe(tabId, userGoal, step, history);

      if (decision.step_type === "done") {
        broadcastStatus({ kind: "done", step, summary: decision.summary });
        return;
      }

      if (decision.step_type === "blocked") {
        broadcastStatus({ kind: "blocked", step, summary: decision.summary });
        return;
      }

      if (decision.step_type === "needs_input") {
        const requestId = `${Date.now()}-${step}`;
        broadcastStatus({ kind: "needs_input", step, question: decision.question, requestId });

        const answer = await waitForAnswer(requestId);

        // A clarification exchange isn't an action, so it gets its own
        // shape in history (no `action`/`result` fields) — the model
        // just needs to see the question it asked and what it was told.
        history.push({ step, question: decision.question, answer });
        broadcastStatus({ kind: "answer_received", step, answer });
        continue;
      }

      if (decision.step_type === "needs_confirmation") {
        const requestId = `${Date.now()}-${step}`;
        broadcastStatus({
          kind: "needs_confirmation",
          step,
          action: decision.action,
          why: decision.why,
          requestId,
        });

        const approved = await waitForConfirmation(requestId);
        if (!approved) {
          broadcastStatus({ kind: "cancelled", step });
          return;
        }

        const result = await executeSingleAction(tabId, decision.action);
        history.push({ step, action: decision.action, result: result.ok ? "ok" : "failed" });
        broadcastStatus({ kind: "action_executed", step, action: decision.action, result });
        continue;
      }

      if (decision.step_type === "action") {
        const result = await executeSingleAction(tabId, decision.action);
        history.push({ step, action: decision.action, result: result.ok ? "ok" : "failed" });
        broadcastStatus({ kind: "action_executed", step, action: decision.action, result });
        continue;
      }

      throw new Error(`Unknown step_type from reasoning server: "${decision.step_type}"`);
    }

    broadcastStatus({ kind: "max_steps", step: MAX_STEPS });
  } catch (err) {
    console.error("Agent loop failed:", err);
    broadcastStatus({ kind: "error", error: String(err) });
  } finally {
    stopKeepAlive();
    if (tabId != null) await detachDebugger(tabId);
  }
}

// --- Message routing ------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "USER_REQUEST") {
    runAgentLoop(message.payload.text); // fire-and-forget — see note above runAgentLoop
    sendResponse({ ok: true }); // just acknowledges receipt, synchronously, right away
    return false; // no long-lived channel needed anymore
  }

  if (message.type === "USER_CONFIRM_ACTION") {
    const resolve = pendingConfirmations.get(message.payload.requestId);
    if (resolve) {
      resolve(message.payload.approved);
      pendingConfirmations.delete(message.payload.requestId);
    }
    return false; // synchronous, no response needed
  }

  if (message.type === "USER_ANSWER") {
    const resolve = pendingAnswers.get(message.payload.requestId);
    if (resolve) {
      resolve(message.payload.answer);
      pendingAnswers.delete(message.payload.requestId);
    }
    return false; // synchronous, no response needed
  }
});

// Open the side panel when the toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});