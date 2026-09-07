

import "dotenv/config";
import express from "express";
import { getNextStep } from "./providers/gemini.js";

const app = express();
app.use(express.json({ limit: "15mb" })); // images can be large

const USE_REAL_MODEL = !!process.env.GEMINI_API_KEY;
if (USE_REAL_MODEL) {
  console.log("GEMINI_API_KEY found — using the real Gemini adapter.");
} else {
  console.log("No GEMINI_API_KEY set — using the scripted test stub.");
}

app.post("/agent", async (req, res) => {
  const { user_goal = "", step_number = 1 } = req.body;
  console.log(`[step ${step_number}] goal="${user_goal}"`);

  if (USE_REAL_MODEL) {
    try {
      const decision = await getNextStep(req.body);
      return res.json(decision);
    } catch (err) {
      console.error("Gemini adapter failed:", err);
      return res.json({
        step_type: "blocked",
        reasoning: "reasoning model call failed",
        summary: `Something went wrong talking to the reasoning model: ${err.message}`,
      });
    }
  }

  // --- scripted stub, for testing without an API key ---------------------
  const { interactive_elements = [] } = req.body;
  const goalLower = user_goal.toLowerCase();

  if (goalLower.startsWith("confirm") && step_number === 1) {
    return res.json({
      step_type: "needs_confirmation",
      reasoning: "test hook: forcing a confirmation prompt",
      action: { type: "click", selector: interactive_elements[0]?.selector || "body" },
      why: "This is a test of the confirmation flow — this action would normally be flagged as sensitive.",
    });
  }

  if (goalLower.startsWith("ask") && step_number === 1) {
    return res.json({
      step_type: "needs_input",
      reasoning: "test hook: forcing a clarifying question",
      question: "This is a test question — which option did you mean?",
    });
  }

  if (step_number === 1) {
    const firstWord = goalLower.split(" ")[0];
    const match = interactive_elements.find((el) =>
      el.text?.toLowerCase().includes(firstWord)
    );
    if (match) {
      return res.json({
        step_type: "action",
        reasoning: `found an element whose text matches "${firstWord}"`,
        action: { type: "click", selector: match.selector },
      });
    }
    return res.json({
      step_type: "blocked",
      reasoning: "no matching element found on step 1",
      summary: `Couldn't find anything matching "${user_goal}" on this page.`,
    });
  }

  return res.json({
    step_type: "done",
    reasoning: "test stub always finishes after one action",
    summary: "Test loop completed successfully.",
  });
});

const PORT = 8787;
app.listen(PORT, () => console.log(`Agent server listening on :${PORT}`));