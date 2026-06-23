/**
 * ChronoCode — AI Adaptation Evaluator (Firebase Cloud Function)
 *
 * Why this is a separate server-side function:
 * The Anthropic API key must NEVER be embedded in frontend JS (same reasoning
 * as your SmartHR credential setup). This function receives the session's
 * snapshot history + evolving requirement timeline, asks Claude to evaluate
 * how well the candidate adapted across stage changes, and returns a
 * structured score. The frontend only ever talks to this HTTPS endpoint.
 *
 * Deploy:
 *   1. cd functions && npm install
 *   2. firebase functions:config:set anthropic.key="sk-ant-..."
 *      (or, for 2nd-gen functions, set ANTHROPIC_API_KEY as a secret — see below)
 *   3. firebase deploy --only functions
 */

const functions = require("firebase-functions");
const fetch = require("node-fetch");

// Use Firebase secrets (recommended) instead of functions.config() for new projects:
//   firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || (functions.config().anthropic && functions.config().anthropic.key);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten this to your hosting domain in production
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

exports.evaluateAdaptation = functions
  .runWith({ secrets: ["ANTHROPIC_API_KEY"], timeoutSeconds: 60, memory: "256MB" })
  .https.onRequest(async (req, res) => {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.set(k, v));
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on the server." });
    }

    try {
      const { challenge, snapshots, events, sessionId } = req.body;

      if (!challenge || !snapshots || !Array.isArray(snapshots)) {
        return res.status(400).json({ error: "Missing challenge or snapshots in request body." });
      }

      // Build a compact, ordered transcript of the session for the model.
      // We cap snapshot count and code length to control token usage/cost.
      const cappedSnapshots = snapshots.slice(0, 40).map(s => ({
        t: s.elapsedSeconds,
        stage: s.stageIndex,
        trigger: s.trigger,
        code: (s.code || "").slice(0, 4000)
      }));

      const stageList = (challenge.stages || []).map((s, i) =>
        `Stage ${i + 1} (at ${s.atSeconds}s): "${s.title}" — ${s.requirementText}`
      ).join("\n");

      const transcript = cappedSnapshots.map(s =>
        `--- t=${s.t}s | stage=${s.stage + 1} | trigger=${s.trigger} ---\n${s.code}`
      ).join("\n\n");

      const systemPrompt = `You are evaluating a candidate's coding session on "ChronoCode", a platform where requirements evolve over time mid-session. Your job is to judge ADAPTABILITY: how well the candidate adjusted their code and approach each time the requirement changed, not just whether the final code is correct.

Score on these dimensions, each 0-100:
- "Responsiveness": did the candidate's code visibly change shortly after each new stage requirement appeared, or did they ignore changes?
- "Code Quality": readability, structure, and correctness of the final code.
- "Incremental Reasoning": did they build on prior work or rewrite from scratch each time (rewriting from scratch repeatedly is a negative signal)?
- "Completeness": how many of the evolving requirements were ultimately addressed in the final code?

Return ONLY valid JSON, no markdown fences, no preamble, in this exact shape:
{
  "adaptabilityScore": <0-100 overall score, weighted average>,
  "dimensions": [
    {"name": "Responsiveness", "score": <0-100>},
    {"name": "Code Quality", "score": <0-100>},
    {"name": "Incremental Reasoning", "score": <0-100>},
    {"name": "Completeness", "score": <0-100>}
  ],
  "summary": "<3-4 sentence human-readable evaluation>"
}`;

      const userPrompt = `Challenge: ${challenge.title} (language: ${challenge.language})

Timeline of evolving requirements:
${stageList}

Code snapshots over time (chronological):
${transcript}

Evaluate this candidate's adaptability across the timeline and return the JSON object described in your instructions.`;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("Anthropic API error:", response.status, errText);
        return res.status(502).json({ error: "AI evaluation upstream error", detail: errText });
      }

      const data = await response.json();
      const textBlock = (data.content || []).find(b => b.type === "text");
      let parsed;
      try {
        const clean = (textBlock?.text || "").replace(/```json|```/g, "").trim();
        parsed = JSON.parse(clean);
      } catch (parseErr) {
        console.error("Failed to parse model output:", textBlock?.text);
        return res.status(502).json({ error: "Could not parse AI evaluation output." });
      }

      return res.status(200).json(parsed);
    } catch (err) {
      console.error("evaluateAdaptation error:", err);
      return res.status(500).json({ error: "Internal error", detail: err.message });
    }
  });
