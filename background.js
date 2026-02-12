const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_LANGUAGE = "Polish";
const REQUEST_TIMEOUT_MS = 45000;

function toRecipientList(value) {
  if (!value) {
    return "";
  }
  if (!Array.isArray(value)) {
    return String(value);
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry.email) {
        return entry.name ? `${entry.name} <${entry.email}>` : entry.email;
      }
      return JSON.stringify(entry);
    })
    .join(", ");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function plainTextToHtml(text) {
  const escaped = escapeHtml(text.trim());
  return `<div>${escaped.replaceAll("\n", "<br>")}</div>`;
}

function normalizeText(value) {
  return String(value || "").replaceAll("\r\n", "\n").trim();
}

function stripCodeFence(value) {
  const text = value.trim();
  if (text.startsWith("```") && text.endsWith("```")) {
    return text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "");
  }
  return text;
}

function parseCompletion(content, fallbackSubject) {
  const cleaned = stripCodeFence(content);

  try {
    const parsed = JSON.parse(cleaned);
    const subject = normalizeText(parsed.subject) || fallbackSubject;
    const body = normalizeText(parsed.body_plain);
    if (body) {
      return { subject, body };
    }
  } catch (_error) {
    // Fallback below.
  }

  return {
    subject: fallbackSubject,
    body: normalizeText(content)
  };
}

async function loadSettings() {
  const data = await messenger.storage.local.get({
    openaiApiKey: "",
    openaiModel: DEFAULT_MODEL,
    preferredLanguage: DEFAULT_LANGUAGE
  });
  return {
    apiKey: normalizeText(data.openaiApiKey),
    model: normalizeText(data.openaiModel) || DEFAULT_MODEL,
    preferredLanguage: normalizeText(data.preferredLanguage) || DEFAULT_LANGUAGE
  };
}

function buildMessages({ prompt, tone, language, composeDetails }) {
  const context = {
    currentSubject: normalizeText(composeDetails.subject),
    recipientsTo: toRecipientList(composeDetails.to),
    recipientsCc: toRecipientList(composeDetails.cc)
  };

  const userPrompt = [
    `Goal: ${normalizeText(prompt)}`,
    `Tone: ${normalizeText(tone) || "professional"}`,
    `Language: ${normalizeText(language) || DEFAULT_LANGUAGE}`,
    `Current subject: ${context.currentSubject || "(empty)"}`,
    `To: ${context.recipientsTo || "(empty)"}`,
    `Cc: ${context.recipientsCc || "(empty)"}`
  ].join("\n");

  return [
    {
      role: "system",
      content: [
        "You write production-ready emails.",
        "Return only valid JSON with keys: subject, body_plain.",
        "body_plain must be plain text, no markdown."
      ].join(" ")
    },
    {
      role: "user",
      content: userPrompt
    }
  ];
}

async function callOpenAi({ apiKey, model, messages }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${details}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content
          .map((part) => (typeof part === "string" ? part : part?.text || ""))
          .join("")
          .trim()
      : normalizeText(content);

    if (!text) {
      throw new Error("Empty response from OpenAI.");
    }
    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleGenerateEmail(message) {
  const { tabId, prompt, tone, language } = message;
  if (!tabId) {
    throw new Error("Compose tab not found.");
  }
  if (!normalizeText(prompt)) {
    throw new Error("Prompt cannot be empty.");
  }

  const settings = await loadSettings();
  if (!settings.apiKey) {
    throw new Error("Missing OpenAI API key. Open add-on options and set it first.");
  }

  const composeDetails = await messenger.compose.getComposeDetails(tabId);
  const messages = buildMessages({
    prompt,
    tone,
    language: normalizeText(language) || settings.preferredLanguage,
    composeDetails
  });

  const rawCompletion = await callOpenAi({
    apiKey: settings.apiKey,
    model: settings.model,
    messages
  });

  const generated = parseCompletion(rawCompletion, normalizeText(composeDetails.subject));
  const updates = {
    subject: generated.subject
  };

  if (composeDetails.isPlainText) {
    updates.plainTextBody = generated.body;
  } else {
    updates.body = plainTextToHtml(generated.body);
  }

  await messenger.compose.setComposeDetails(tabId, updates);

  return {
    ok: true,
    subject: generated.subject,
    body: generated.body
  };
}

messenger.runtime.onMessage.addListener((message) => {
  if (message?.type === "GENERATE_EMAIL") {
    return handleGenerateEmail(message);
  }
  return undefined;
});
