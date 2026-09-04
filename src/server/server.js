// server.js — minimal stub reasoning server.
// Run: npm install express && node server.js
// This does NOT call a real model yet — it just proves the pipeline
// works end-to-end. Replace handleAgentRequest with a real call to
// your heavier reasoning/vision-language model.

import express from "express";

const app = express();
app.use(express.json({ limit: "15mb" })); // images can be large

app.post("/agent", async (req, res) => {
  const { userText, image, elements, url } = req.body;

  console.log(`Request: "${userText}" on ${url}`);
  console.log(`Received ${elements?.length ?? 0} candidate elements, image present: ${!!image}`);

  // TODO: send `userText`, `image` (already blurred), and `elements` to
  // your real reasoning model, and have it return a plan in this shape:
  const actions = pickDummyAction(userText, elements);

  res.json({ actions });
});

function pickDummyAction(userText, elements) {
  // Placeholder logic: just click the first button-like element it finds
  // whose text loosely matches the request, or do nothing.
  const match = (elements || []).find((el) =>
    el.text?.toLowerCase().includes(userText.toLowerCase().split(" ")[0])
  );
  if (match) {
    return [{ type: "click", selector: match.selector }];
  }
  return [];
}

const PORT = 8787;
app.listen(PORT, () => console.log(`Stub agent server listening on :${PORT}`));