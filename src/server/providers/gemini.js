// gemini.js — adapter between our provider-agnostic contract
// (see ../AGENT_PROTOCOL.md) and the Gemini API (free tier).
//
// Structurally this mirrors claude.js closely — same idea, different
// vendor's field names. That's the whole point of having designed the
// contract first: swapping providers is "write one of these files",
// not "redesign the system."

const MODEL = "gemini-3.6-flash"; // current free-tier, vision-capable model as of testing —
                                    // verify at https://aistudio.google.com if this changes later
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SYSTEM_PROMPT = `You control a web browser on behalf of a user, one step at a time.

You will be shown:
- the user's goal
- a screenshot of the current page. Some rectangular regions may be solid
  black — that is intentional redaction of personal information (faces,
  emails, etc.) applied before the image reached you. Never treat a black
  box as something to read or interact with.
- a list of interactive elements currently on the page, each with a CSS
  selector you can reference
- the history of actions already taken this session, and whether each
  succeeded

Decide the SINGLE next step toward the goal, then call the
report_decision function with exactly one step_type:

- "action": take one action (click / type / navigate / scroll / wait).
  Only ever use a selector from the provided element list — never invent
  or guess one that isn't listed.
- "done": the goal has been achieved. Include a short summary for the user.
- "blocked": you cannot find what you need on this page, or you've tried
  and it isn't working. Explain what's missing in the summary. Prefer
  this over guessing a selector that isn't listed.
- "needs_input": the request is ambiguous, or you need information only
  the user can provide (which of several accounts, which item, etc).
  Ask one specific question.
- "needs_confirmation": the action would submit payment information,
  delete data, send a message, or otherwise be hard to undo. Describe the
  action and why it needs confirmation. Do not perform sensitive actions
  without this step first.

Always fill in "reasoning" with a brief internal explanation — it's for
debugging logs, not shown to the user, so it's fine to be terse.`;

const DECISION_FUNCTION = {
  name: "report_decision",
  description: "Report the single next step to take toward the user's goal.",
  parameters: {
    type: "object",
    properties: {
      step_type: {
        type: "string",
        enum: ["action", "done", "blocked", "needs_input", "needs_confirmation"],
      },
      reasoning: {
        type: "string",
        description: "Brief internal explanation for why you chose this step. Not shown to the user.",
      },
      action: {
        type: "object",
        description: "Required when step_type is 'action' or 'needs_confirmation'.",
        properties: {
          type: { type: "string", enum: ["click", "type", "navigate", "scroll", "wait"] },
          selector: { type: "string", description: "CSS selector, required for click/type" },
          text: { type: "string", description: "text to type, required for type actions" },
          url: { type: "string", description: "required for navigate actions" },
          direction: { type: "string", enum: ["up", "down"], description: "required for scroll actions" },
          amount: { type: "number", description: "scroll distance in px, optional" },
          ms: { type: "number", description: "wait duration in ms, required for wait actions" },
        },
        required: ["type"],
      },
      summary: {
        type: "string",
        description: "Required when step_type is 'done' or 'blocked' — shown to the user.",
      },
      question: {
        type: "string",
        description: "Required when step_type is 'needs_input' — shown to the user.",
      },
      why: {
        type: "string",
        description: "Required when step_type is 'needs_confirmation' — shown to the user.",
      },
    },
    required: ["step_type", "reasoning"],
  },
};

function buildParts(observation) {
  const {
    user_goal,
    current_url,
    step_number,
    max_steps,
    screenshot,
    interactive_elements,
    history,
  } = observation;

  // screenshot arrives as a data URL: "data:image/png;base64,AAAA..."
  const match = screenshot.match(/^data:([^;]+);base64,(.*)$/s);
  if (!match) throw new Error("screenshot is not a valid base64 data URL");
  const [, mimeType, base64Data] = match;

  const textBlock = [
    `User goal: ${user_goal}`,
    `Current URL: ${current_url}`,
    `Step ${step_number} of max ${max_steps}`,
    "",
    "Interactive elements on this page (use these selectors, never invent one):",
    JSON.stringify(interactive_elements, null, 2),
    "",
    "History so far this session:",
    history.length ? JSON.stringify(history, null, 2) : "(none yet — this is the first step)",
  ].join("\n");

  // do better with visual context established before the text describing it.
  return [
    { inlineData: { mimeType, data: base64Data } },
    { text: textBlock },
  ];
}

async function callGeminiWithRetry(url, body, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.ok) return response;

    // 503 = server overloaded, 500 = internal error, 429 = rate limited.
    // All three are transient and worth a short retry — especially
    // relevant on a free tier, which sees more of these than a paid one.
    const isTransient = [429, 500, 503].includes(response.status);
    const errText = await response.text();
    lastError = new Error(`Gemini API error ${response.status}: ${errText}`);

    if (!isTransient || attempt === maxAttempts) throw lastError;

    const delayMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
    console.warn(
      `Gemini returned ${response.status} (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms...`
    );
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw lastError;
}

async function getNextStep(observation) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set — export it in your shell or put it in a .env file (see .env.example)"
    );
  }

  const response = await callGeminiWithRetry(`${API_URL}?key=${apiKey}`, {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: buildParts(observation) }],
    tools: [{ functionDeclarations: [DECISION_FUNCTION] }],
    // Forcing ANY + naming the one allowed function is Gemini's
    // it guarantees a function call instead of a free-text reply.
    toolConfig: {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["report_decision"],
      },
    },
  });

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const functionCallPart = parts.find((p) => p.functionCall);

  if (!functionCallPart) {
    throw new Error("Gemini did not return a functionCall despite forced tool_config");
  }

  // Note: unlike some other providers, Gemini's functionCall.args arrives
  // as an already-parsed object, not a JSON string — no JSON.parse needed.
  return functionCallPart.functionCall.args; // shaped like our step_type decision object
}

export { getNextStep };