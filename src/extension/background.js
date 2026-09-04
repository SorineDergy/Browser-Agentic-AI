// background.js — the coordinator/hub. Everything routes through here.
// Message shape convention: { type: string, payload: any }

const SERVER_URL = "http://localhost:8787/agent"; // swap for your real server endpoint sometime in 800 years
const BLUR_SERVER_URL = "http://localhost:8788/blur"; // Python mediapipe+teserract service

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
  function fireClick(el) {
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
    );
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

async function executeActions(tabId, actions) {
  const results = [];
  for (const action of actions) {
    if (action.type === "navigate") {
      await chrome.tabs.update(tabId, { url: action.url });
      results.push({ ok: true, action });
      continue;
    }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: dispatchAction,
      args: [action],
    });
    results.push(result);
    // small delay between actions so the page can react before the next one
    await new Promise((r) => setTimeout(r, 300));
  }
  return results;
}

// --- Main flow ----------------------------------------------------------

async function handleUserRequest(payload, sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const screenshotDataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });

    const blurredDataUrl = await blurImageLocally(screenshotDataUrl);

    const [{ result: elements }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractInteractiveElements,
    });

    const serverResponse = await fetch(SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userText: payload.text,
        image: blurredDataUrl, // blurred image only — raw one never leaves the device
        elements,
        url: tab.url,
      }),
    });
    const { actions } = await serverResponse.json();

    const results = await executeActions(tab.id, actions);
    sendResponse({ ok: true, actions, results });
  } catch (err) {
    console.error("Agent request failed:", err);
    sendResponse({ ok: false, error: String(err) });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "USER_REQUEST") {
    handleUserRequest(message.payload, sendResponse);
    return true; // keep the message channel open for async sendResponse
  }
});

// Open the side panel when the toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});



// SOMEONE SEND HELP, IDK ANY JAVASCRIPT 