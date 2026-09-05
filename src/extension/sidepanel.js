const log = document.getElementById("log");
const textInput = document.getElementById("textInput");
const sendBtn = document.getElementById("sendBtn");
const micBtn = document.getElementById("micBtn");

function addEntry(text, cls = "") {
  const div = document.createElement("div");
  div.className = `entry ${cls}`.trim();
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function describeAction(action) {
  if (!action) return "(no action)";
  switch (action.type) {
    case "click": return `click ${action.selector}`;
    case "type": return `type into ${action.selector}`;
    case "navigate": return `navigate to ${action.url}`;
    case "scroll": return `scroll ${action.direction}`;
    case "wait": return `wait ${action.ms}ms`;
    default: return action.type;
  }
}

function sendRequest(text) {
  if (!text.trim()) return;
  addEntry(text, "user");
  textInput.value = "";
  sendBtn.disabled = true;

  chrome.runtime.sendMessage({ type: "USER_REQUEST", payload: { text } }, (response) => {
    sendBtn.disabled = false;
    if (chrome.runtime.lastError) {
      addEntry(`Error: ${chrome.runtime.lastError.message}`, "error");
      return;
    }
    if (!response.ok) {
      addEntry(`Error: ${response.error}`, "error");
    }
    // Step-by-step progress already streamed in via AGENT_STATUS messages
    // below — the final response here just tells us the loop is over.
  });
}

// --- Live progress from the agent loop in background.js -----------------

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "AGENT_STATUS") return;
  const s = message.payload;

  switch (s.kind) {
    case "observing":
      addEntry(`Step ${s.step}: looking at the page...`);
      break;

    case "action_executed":
      addEntry(
        `Step ${s.step}: ${describeAction(s.action)} ${s.result.ok ? "✓" : "✗ (element not found)"}`
      );
      break;

    case "done":
      addEntry(`Done: ${s.summary}`);
      break;

    case "blocked":
      addEntry(`Stuck: ${s.summary}`, "error");
      break;

    case "needs_input":
      addEntry(`Question: ${s.question}`);
      break;

    case "needs_confirmation": {
      // Simple synchronous confirm() for the skeleton — fine for a first
      // pass, though a custom in-panel prompt would feel less jarring
      // than a native browser dialog once this feels worth polishing.
      const approved = window.confirm(
        `${s.why}\n\nAction: ${describeAction(s.action)}\n\nProceed?`
      );
      chrome.runtime.sendMessage({
        type: "USER_CONFIRM_ACTION",
        payload: { requestId: s.requestId, approved },
      });
      addEntry(approved ? `Confirmed step ${s.step}` : `Cancelled step ${s.step}`);
      break;
    }

    case "cancelled":
      addEntry(`Stopped — you cancelled step ${s.step}`);
      break;
  }
});

sendBtn.addEventListener("click", () => sendRequest(textInput.value));
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendRequest(textInput.value);
});

// --- Voice input via the Web Speech API ---------------------------------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizing = false;

if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    sendRequest(transcript);
  };
  recognition.onend = () => {
    recognizing = false;
    micBtn.textContent = "🎤";
  };

  micBtn.addEventListener("click", () => {
    if (recognizing) {
      recognition.stop();
    } else {
      recognizing = true;
      micBtn.textContent = "⏹";
      recognition.start();
    }
  });
} else {
  micBtn.disabled = true;
  micBtn.title = "Speech recognition not supported in this context";
}