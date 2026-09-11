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

function dispatchAction(action) {
  // Runs inside the target page via chrome.scripting.executeScript.
  // Handles click/type/scroll. navigate/wait are handled outside the page
  // in executeSingleAction, since they don't need page-context access.
  function fireClick(el) {
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
    );
  }

  if (action.type === "scroll") {
    const amount = action.amount || 500;
    window.scrollBy(0, action.direction === "up" ? -amount : amount);
    return { ok: true, action };
  }

  const el = action.selector ? document.querySelector(action.selector) : null;
  if (action.type === "click" && el) {
    el.scrollIntoView({ block: "center" });
    fireClick(el);
  } else if (action.type === "type" && el) {
    el.focus();
    el.value = action.text || "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return { ok: !!el, action };
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
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab.id;
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