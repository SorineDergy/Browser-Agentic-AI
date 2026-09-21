// claude.js — adapter between our provider-agnostic contract
// (see ../AGENT_PROTOCOL.md) and the Claude API.
//
// Nothing outside this file needs to know Claude is involved at all —
// it takes an `observation` object shaped per AGENT_PROTOCOL.md and
// returns a `decision` object shaped the same way, regardless of what's
// happening inside. That's what makes swapping providers later a
// contained change instead of a rewrite.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5"; // fine to swap for claude-opus-5 if you want stronger (slower/pricier) reasoning

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
report_decision tool with exactly one step_type:

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

const DECISION_TOOL = {
  name: "report_decision",
  description: "Report the single next step to take toward the user's goal.",
  input_schema: {
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
          submit: { type: "boolean", description: "for type actions: press Enter after typing to submit (e.g. a search box)" },
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

function buildUserMessageContent(observation) {
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
  const [, mediaType, base64Data] = match;

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

  // Image before text: this is Claude's documented preference for best results.
  return [
    { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
    { type: "text", text: textBlock },
  ];
}

async function getNextStep(observation) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — export it in your shell or put it in a .env file (see .env.example)"
    );
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessageContent(observation) }],
      tools: [DECISION_TOOL],
      // Forcing the exact tool (rather than "auto") is what guarantees a
      // structured response every time, instead of Claude sometimes just
      // replying with plain text.
      tool_choice: { type: "tool", name: "report_decision" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const toolUseBlock = data.content.find((block) => block.type === "tool_use");
  if (!toolUseBlock) {
    // Shouldn't happen with tool_choice forced, but fail loudly if it does
    // rather than silently returning something malformed to the extension.
    throw new Error("Claude did not return a tool_use block despite forced tool_choice");
  }

  return toolUseBlock.input; // already shaped exactly like our step_type decision object
}

export { getNextStep };