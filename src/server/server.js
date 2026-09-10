// background.js — the coordinator/hub. Everything routes through here.
// Message shape convention: { type: string, payload: any }
//
// This implements the observe -> decide -> act -> re-observe loop 

const SERVER_URL = "http://localhost:8787/agent"; // swap for your real endpoint at somepoint (hah, get it?)
const BLUR_SERVER_URL = "http://localhost:8788/blur"; // your local Python blur service
const MAX_STEPS = 15; // circuit breaker so a confused model can't loop forever >:0

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



function broadcastStatus(payload) {
  chrome.runtime.sendMessage({ type: "AGENT_STATUS", payload }).catch(() => {});
}


const pendingConfirmations = new Map();

function waitForConfirmation(requestId) {
  return new Promise((resolve) => {
    pendingConfirmations.set(requestId, resolve);
  });
}

const pendingAnswers = new Map();

function waitForAnswer(requestId) {
  return new Promise((resolve) => {
    pendingAnswers.set(requestId, resolve);
  });
}


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
});

// Open the side panel when the toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});