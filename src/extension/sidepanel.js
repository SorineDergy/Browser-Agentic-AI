const log = document.getElementById("log");
const textInput = document.getElementById("textInput");
const sendBtn = document.getElementById("sendBtn");
const micBtn = document.getElementById("micBtn");

// When set, the next thing the user types/speaks is an ANSWER to a
// question the agent asked mid-loop, not a brand new request. Cleared
// once that answer is sent.
let pendingQuestionRequestId = null;

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

// Called whenever the agent loop has genuinely stopped and it's safe to
// let the user start something new (a fresh request, or an answer).
function reenableInput() {
  sendBtn.disabled = false;
  textInput.placeholder = "Ask the agent to do something...";
}

function sendRequest(text) {
  if (!text.trim()) return;

  if (pendingQuestionRequestId) {
    // We're mid-loop, answering a question — route to USER_ANSWER and
    // resume the SAME loop, instead of starting a brand new one.
    const requestId = pendingQuestionRequestId;
    pendingQuestionRequestId = null;
    addEntry(text, "user");
    textInput.value = "";
    sendBtn.disabled = true;
    chrome.runtime.sendMessage({ type: "USER_ANSWER", payload: { requestId, answer: text } });
    return;
  }

  addEntry(text, "user");
  textInput.value = "";
  sendBtn.disabled = true;

  // The response here is just a synchronous "received" acknowledgment —
  // the actual outcome streams in via AGENT_STATUS broadcasts below,
  // since a long local-model call can outlive a single response channel
  // (see background.js for why). Send stays disabled until a broadcast
  // reports the loop has actually ended (or is paused waiting on us).
  chrome.runtime.sendMessage({ type: "USER_REQUEST", payload: { text } }, () => {
    if (chrome.runtime.lastError) {
      addEntry(`Error: ${chrome.runtime.lastError.message}`, "error");
      reenableInput();
    }
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
      reenableInput();
      break;

    case "blocked":
      addEntry(`Stuck: ${s.summary}`, "error");
      reenableInput();
      break;

    case "needs_input":
      // Loop is now PAUSED, waiting on us — not ended. Remember the
      // requestId so the next thing typed gets routed back as an answer.
      addEntry(`Question: ${s.question}`);
      pendingQuestionRequestId = s.requestId;
      sendBtn.disabled = false;
      textInput.placeholder = "Type your answer...";
      textInput.focus();
      break;

    case "answer_received":
      addEntry(`You answered: ${s.answer}`, "user");
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
      reenableInput();
      break;

    case "max_steps":
      addEntry(`Stopped after ${s.step} steps without finishing.`, "error");
      reenableInput();
      break;

    case "error":
      addEntry(`Error: ${s.error}`, "error");
      reenableInput();
      break;
  }
});

sendBtn.addEventListener("click", () => sendRequest(textInput.value));
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendRequest(textInput.value);
});

// --- Voice input via the Web Speech API ---------------------------------
// Works for both a fresh request and answering a pending question — it
// just calls sendRequest(), same as typing does.

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