const DEFAULT_MODEL = "gpt-5.3-codex";
const DEFAULT_LANGUAGE = "Polish";
const DEFAULT_BACKEND_URL = "http://127.0.0.1:8787";
const REQUEST_TIMEOUT_MS = 60000;

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

function extractPlainTextFooter(currentBody) {
  const body = String(currentBody || "").replaceAll("\r\n", "\n");
  if (!body) {
    return "";
  }

  const separators = ["\n-- \n", "\n--\n"];
  let markerIndex = -1;
  for (const separator of separators) {
    const index = body.indexOf(separator);
    if (index !== -1 && (markerIndex === -1 || index < markerIndex)) {
      markerIndex = index;
    }
  }

  if (markerIndex === -1) {
    return "";
  }

  return body.slice(markerIndex).replace(/^\n+/, "").trimEnd();
}

function mergePlainTextWithFooter(generatedBody, currentBody) {
  const footer = extractPlainTextFooter(currentBody);
  if (!footer) {
    return generatedBody;
  }
  return `${generatedBody.trimEnd()}\n\n${footer}`;
}

function findTagStartFromNeedle(html, needle) {
  const lower = html.toLowerCase();
  const index = lower.indexOf(needle.toLowerCase());
  if (index === -1) {
    return -1;
  }
  if (needle.startsWith("<")) {
    return index;
  }
  return html.lastIndexOf("<", index);
}

function extractHtmlTail(currentHtml) {
  const html = String(currentHtml || "");
  if (!html.trim()) {
    return "";
  }

  const markers = ["moz-signature", "moz-cite-prefix", "<blockquote"];
  let startIndex = -1;

  for (const marker of markers) {
    const candidate = findTagStartFromNeedle(html, marker);
    if (candidate !== -1 && (startIndex === -1 || candidate < startIndex)) {
      startIndex = candidate;
    }
  }

  if (startIndex === -1) {
    return "";
  }

  return html.slice(startIndex).trim();
}

function mergeHtmlWithTail(generatedBody, currentHtml) {
  const generatedHtml = plainTextToHtml(generatedBody);
  const preservedTail = extractHtmlTail(currentHtml);
  if (!preservedTail) {
    return generatedHtml;
  }
  return `${generatedHtml}<br><br>${preservedTail}`;
}

function normalizeText(value) {
  return String(value || "").replaceAll("\r\n", "\n").trim();
}

function htmlToPlainText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(value, maxLength) {
  const text = normalizeText(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n\n[...truncated...]`;
}

function normalizeBaseUrl(value) {
  return normalizeText(value).replace(/\/+$/, "");
}

async function loadSettings() {
  const data = await messenger.storage.local.get({
    backendBaseUrl: DEFAULT_BACKEND_URL,
    codexModel: DEFAULT_MODEL,
    preferredLanguage: DEFAULT_LANGUAGE
  });

  return {
    backendBaseUrl: normalizeBaseUrl(data.backendBaseUrl) || DEFAULT_BACKEND_URL,
    model: normalizeText(data.codexModel) || DEFAULT_MODEL,
    preferredLanguage: normalizeText(data.preferredLanguage) || DEFAULT_LANGUAGE
  };
}

async function callBackendGenerate({ backendBaseUrl, payload }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await fetch(`${backendBaseUrl}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (_error) {
      throw new Error(
        `Cannot reach backend at ${backendBaseUrl}. Start it with: cd server && node index.js`
      );
    }

    const responseText = await response.text();
    let responseBody = null;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch (_error) {
        responseBody = null;
      }
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("Not signed in. Open add-on settings and connect OpenAI.");
      }
      const details = responseBody?.error || responseText || `Backend error ${response.status}.`;
      throw new Error(details);
    }

    if (!responseBody || typeof responseBody !== "object") {
      throw new Error("Invalid backend response format.");
    }

    return responseBody;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleGenerateEmail(message) {
  const { tabId, prompt, tone, language, quickStatus } = message;
  if (!tabId) {
    throw new Error("Compose tab not found.");
  }
  if (!normalizeText(prompt)) {
    throw new Error("Prompt cannot be empty.");
  }

  const settings = await loadSettings();
  if (!settings.backendBaseUrl) {
    throw new Error("Missing backend URL. Open add-on settings.");
  }

  const composeDetails = await messenger.compose.getComposeDetails(tabId);
  const currentBodyContext = composeDetails.isPlainText
    ? normalizeText(composeDetails.plainTextBody)
    : htmlToPlainText(composeDetails.body);

  const result = await callBackendGenerate({
    backendBaseUrl: settings.backendBaseUrl,
    payload: {
      prompt,
      tone: normalizeText(tone) || "professional",
      language: normalizeText(language) || settings.preferredLanguage,
      model: settings.model,
      quickStatus: normalizeText(quickStatus),
      currentSubject: normalizeText(composeDetails.subject),
      currentBody: truncateText(currentBodyContext, 8000),
      to: toRecipientList(composeDetails.to),
      cc: toRecipientList(composeDetails.cc),
      isPlainText: Boolean(composeDetails.isPlainText)
    }
  });

  const generatedSubject = normalizeText(result.subject) || normalizeText(composeDetails.subject);
  const generatedBody = normalizeText(result.body_plain || result.body || "");
  if (!generatedBody) {
    throw new Error("Backend returned empty email body.");
  }

  const updates = {
    subject: generatedSubject
  };

  if (composeDetails.isPlainText) {
    updates.plainTextBody = mergePlainTextWithFooter(generatedBody, composeDetails.plainTextBody);
  } else {
    updates.body = mergeHtmlWithTail(generatedBody, composeDetails.body);
  }

  await messenger.compose.setComposeDetails(tabId, updates);

  return {
    ok: true,
    subject: generatedSubject,
    body: generatedBody
  };
}

messenger.runtime.onMessage.addListener((message) => {
  if (message?.type === "GENERATE_EMAIL") {
    return handleGenerateEmail(message);
  }
  return undefined;
});
