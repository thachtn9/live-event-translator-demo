import {
  DEFAULT_POLISH_MODEL,
  POLISH_MODEL_FALLBACKS,
  buildPolishPrompt,
  parseGenerateContentText,
} from "./polish-text.js";

export async function polishTranscriptText({
  text,
  apiKey,
  model = DEFAULT_POLISH_MODEL,
}) {
  const batch = String(text ?? "").trim();
  if (!batch) {
    return "";
  }
  if (!apiKey) {
    throw new Error("Cần Gemini API key để làm sạch bản dịch.");
  }

  const models = [model, ...POLISH_MODEL_FALLBACKS.filter((item) => item !== model)];
  let lastError = null;

  for (const candidate of models) {
    try {
      return await generatePolishedText({
        apiKey,
        model: candidate,
        prompt: buildPolishPrompt(batch),
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // Try next model on not-found / unsupported; otherwise stop.
      if (!/not found|404|unsupported|NOT_FOUND/i.test(message)) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("Không làm sạch được bản dịch.");
}

async function generatePolishedText({ apiKey, model, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      payload?.error?.message ||
      payload?.error?.status ||
      `HTTP ${response.status}`;
    if (response.status === 429) {
      throw new Error("Quota tạm thời — giữ bản thô");
    }
    throw new Error(detail);
  }

  return parseGenerateContentText(payload);
}
