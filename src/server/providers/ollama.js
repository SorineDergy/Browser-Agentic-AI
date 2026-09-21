// ollama.js — adapter between our provider-agnostic contract
// (see ../AGENT_PROTOCOL.md) and a local model running via Ollama,
// using Ollama's structured outputs feature (format: <json schema>)
// for constrained decoding — the model is physically prevented from
// emitting tokens that don't match this schema, rather than just being
// asked nicely to follow it.
//
// Setup:
//   1. Install Ollama: https://ollama.com/download
//   2. Pull a vision-capable model:  ollama pull gemma3:12b
//      (gemma3 sizes 4b and up are multimodal; the 1b size is text-only)
//   3. Ollama runs a local server automatically on :11434 after install —
//      nothing else to start.
//
// No API key needed — this is 100% local, same machine as everything else.

import { Agent, setGlobalDispatcher } from "undici";

// Local model inference — especially a vision model chewing through an
// image plus an 8k-token context on a machine without a serious GPU —
// can legitimately take minutes, not seconds. Node's default fetch
// timeout (undici's headersTimeout, ~300s) can still be shorter than
// that. Raise it globally here, since this file is the one place we're
// deliberately talking to something this slow — the hosted providers
// return in a few seconds regardless, so this has no downside for them.
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 })); // 10 minutes

const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL = "gemma3:12b"; // swap for whatever vision-capable model you've pulled

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

Decide the SINGLE next step toward the goal, then respond with JSON
matching the required schema, using exactly one step_type:

- "action": take one action (click / type / navigate / scroll / wait).
  Only ever use a selector from the provided element list — never invent
  or guess one that isn't listed. Typing into a field automatically clears
  whatever was already in it first — you don't need to clear it yourself.
  Set submit: true on a type action to press Enter afterward (e.g. to fire
  a search), instead of a separate click on a submit button.
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

// The JSON Schema handed to Ollama's `format` field. This is what
// actually constrains generation — the model cannot produce a token
// sequence that violates this shape.
const DECISION_SCHEMA = {
  type: "object",
  properties: {
    step_type: {
      type: "string",
      enum: ["action", "done", "blocked", "needs_input", "needs_confirmation"],
    },
    reasoning: { type: "string" },
    action: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["click", "type", "navigate", "scroll", "wait"] },
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean" },
        url: { type: "string" },
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "number" },
        ms: { type: "number" },
      },
      required: ["type"], // was missing — this is what let action.type come back undefined
    },
    summary: { type: "string" },
    question: { type: "string" },
    why: { type: "string" },
  },
  required: ["step_type", "reasoning"],
};

function buildUserText(observation) {
  const { user_goal, current_url, step_number, max_steps, interactive_elements, history } =
    observation;

  // Local models have a much smaller usable context than hosted APIs by
  // default — trim harder here than the other providers need to. This
  // also, incidentally, plays to the smaller model's strengths: fewer
  // candidate elements to weigh is one less way for it to get confused.
  const trimmedElements = interactive_elements.slice(0, 40);
  const trimmedHistory = history.slice(-5);

  return [
    `User goal: ${user_goal}`,
    `Current URL: ${current_url}`,
    `Step ${step_number} of max ${max_steps}`,
    "",
    "Interactive elements on this page (use these selectors, never invent one):",
    JSON.stringify(trimmedElements, null, 2),
    "",
    "Recent history (most recent last):",
    trimmedHistory.length ? JSON.stringify(trimmedHistory, null, 2) : "(none yet — this is the first step)",
    "",
    "Respond with a JSON object matching the required step_type schema.",
  ].join("\n");
}

async function getNextStep(observation) {
  // screenshot arrives as a data URL: "data:image/png;base64,AAAA..."
  // Ollama wants the raw base64 only, no "data:...;base64," prefix.
  const match = observation.screenshot.match(/^data:([^;]+);base64,(.*)$/s);
  if (!match) throw new Error("screenshot is not a valid base64 data URL");
  const [, , base64Data] = match;

  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: DECISION_SCHEMA, // <-- this is the constrained decoding
      // Ollama defaults to a 4096-token context window, which a
      // screenshot + element list can blow past easily. Raise it
      // explicitly. Bigger context = more RAM/VRAM needed to hold it —
      // if this number causes an out-of-memory error instead, that's
      // your hardware's real ceiling, and the trim in buildUserText()
      // above becomes the lever to pull instead of a bigger num_ctx.
      options: { num_ctx: 8192 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: buildUserText(observation),
          images: [base64Data],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Ollama returned ${response.status}: ${errText}\n` +
        `(Is "ollama serve" running, and have you run "ollama pull ${MODEL}"?)`
    );
  }

  const data = await response.json();
  // Unlike the function-calling providers, Ollama returns the structured
  // result as a JSON STRING inside message.content — needs a parse step.
  // (This is also the one place local generation can still fail even with
  // a schema: the schema guarantees valid JSON *shape*, but a very small
  // model can still time out, get truncated, or occasionally produce
  // something that doesn't quite parse — worth keeping this try/catch
  // rather than assuming the schema makes JSON.parse infallible.)
  try {
    return JSON.parse(data.message.content);
  } catch (err) {
    throw new Error(`Ollama's response wasn't valid JSON despite the schema: ${data.message.content}`);
  }
}

export { getNextStep };