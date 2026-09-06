# Extension Details


## background.js

### Screenshot system

This is what takes the "screenshot", just grabs whatevers on the screen.

```
const screenshotDataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
const blurredDataUrl = await blurImageLocally(screenshotDataUrl);
```

### How this file works <br>

```
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "USER_REQUEST") {
    runAgentLoop(message.payload.text, sendResponse);
    return true;
  }
  if (message.type === "USER_CONFIRM_ACTION") {
    ...
    return false;
  }
});
``` 
This code is the file's entry point, for when ```sidepanel.js``` calls ```chrome.runtime.sendMessage({ type: "USER_REQUEST", ... })```, this listener activates, sees the type and starts ```runAgentLoop```
<br>
```return true;``` is used too get chrome too keep the channel oppen for the async sendResponse. 
<br>

```runAgentLoop``` is the actual loop: <br>
```async function runAgentLoop(userGoal, sendResponse) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab.id;
  const history = [];

  for (let step = 1; step <= MAX_STEPS; step++) {
    broadcastStatus({ kind: "observing", step });
    const decision = await observe(tabId, userGoal, step, history);

    if (decision.step_type === "done") { ...; return; }
    if (decision.step_type === "blocked") { ...; return; }
    if (decision.step_type === "needs_input") { ...; return; }
    if (decision.step_type === "needs_confirmation") { ... }
    if (decision.step_type === "action") { ... }
  }
}
```
Just your run of the mill loop statement with just a small addition ```await observe()``` that is just used to determine wether to keep going, history is just a plain array that has new entry added to it everytime an action executes. <br>

Functions ```extractInteractiveElements``` and ```dispatchAction``` are not called in ```background.js```, Instead ```chrome.scripting.executeScript``` takes the function, serializes it and sends it over to the webpage's JS enviroment, where it runs.<br>
```dispatchAction``` does the actual clickss/scrolls/typing and it has to run inside the page to do so, the results come back as an array. <br>
<sub> (```chrome.scripting.executeScript``` can inject into multiple frames, hence ```[{ result: ... }]``` with array destructuring even though you're usually only touching one frame) </sub><br>

```pendingConfirmations``` is used for the conformation handshake <br>
```
const pendingConfirmations = new Map();

function waitForConfirmation(requestId) {
  return new Promise((resolve) => {
    pendingConfirmations.set(requestId, resolve);
  });
}
```
```new Promise((resolve) => { ... some async work ..., then call resolve(value) })``` You would expect this to get resolved inside the same function, but in our case, the ```resolve``` happens somewhere else in the file, the _somewhere else_ being: <br>
```
if (message.type === "USER_CONFIRM_ACTION") {
  const resolve = pendingConfirmations.get(message.payload.requestId);
  if (resolve) {
    resolve(message.payload.approved);
    pendingConfirmations.delete(message.payload.requestId);
  }
}
```
This is the second branch of the message listener from the first step. <br>

This is the pattern down to its bare essentials: <br>
```
// Step 1: a place to stash "resolve" functions we haven't called yet
const pending = new Map();

// Step 2: a function that returns a Promise, but doesn't resolve it itself —
// it just stores the resolver and hands the (still-pending) Promise back
function waitForSomeoneElse(id) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
  });
}

// Step 3: some UNRELATED code, running at some UNKNOWN later time,
// is what actually decides the value and fires the resolve
function reportResult(id, value) {
  const resolve = pending.get(id);
  if (resolve) {
    resolve(value);       // <-- THIS is what makes the original Promise settle
    pending.delete(id);
  }
}

// --- using it ---

async function main() {
  console.log("about to wait...");
  const answer = await waitForSomeoneElse("request-1");
  console.log("got an answer:", answer);   // this line doesn't run until reportResult() is called
}

main();

// Simulate "later, from somewhere else" — e.g. a button click handler,
// a network response, a timer, anything
setTimeout(() => {
  reportResult("request-1", 42);
}, 3000);
```

