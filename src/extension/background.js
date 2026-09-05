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

// --- The main loop: observe -> decide -> act -> re-observe --------------

async function runAgentLoop(userGoal, sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab.id;
    const history = [];

    for (let step = 1; step <= MAX_STEPS; step++) {
      broadcastStatus({ kind: "observing", step });
      const decision = await observe(tabId, userGoal, step, history);

      if (decision.step_type === "done") {
        broadcastStatus({ kind: "done", step, summary: decision.summary });
        sendResponse({ ok: true, outcome: "done", summary: decision.summary });
        return;
      }

      if (decision.step_type === "blocked") {
        broadcastStatus({ kind: "blocked", step, summary: decision.summary });
        sendResponse({ ok: true, outcome: "blocked", summary: decision.summary });
        return;
      }

      if (decision.step_type === "needs_input") {
        // Simplification for the skeleton: the loop ends here and surfaces
        // the model's question. Resuming the SAME loop with the user's
        // answer (rather than starting a fresh request) is a reasonable
        // next improvement, but needs a bit more state-threading than
        // this skeleton does today.
        broadcastStatus({ kind: "needs_input", step, question: decision.question });
        sendResponse({ ok: true, outcome: "needs_input", question: decision.question });
        return;
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
          sendResponse({ ok: true, outcome: "cancelled" });
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

    sendResponse({ ok: false, error: `Stopped after ${MAX_STEPS} steps without finishing.` });
  } catch (err) {
    console.error("Agent loop failed:", err);
    sendResponse({ ok: false, error: String(err) });
  }
}

// --- Message routing ------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "USER_REQUEST") {
    runAgentLoop(message.payload.text, sendResponse);
    return true; // keep the message channel open for the async sendResponse
  }

  if (message.type === "USER_CONFIRM_ACTION") {
    const resolve = pendingConfirmations.get(message.payload.requestId);
    if (resolve) {
      resolve(message.payload.approved);
      pendingConfirmations.delete(message.payload.requestId);
    }
    return false; // synchronous, no response needed
  }
});

// Open the side panel when the toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});