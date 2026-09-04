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
      return;
    }
    const summary = response.actions
      .map((a) => `${a.type}${a.selector ? " " + a.selector : ""}${a.url ? " " + a.url : ""}`)
      .join("\n");
    addEntry(`Did:\n${summary}`);
  });
}

sendBtn.addEventListener("click", () => sendRequest(textInput.value));
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendRequest(textInput.value);
});

// --- Voice input via the Web Speech API ---------------------------------
// Note: SpeechRecognition needs to run in a page context with mic
// permission granted; side panels support this like a normal page.

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