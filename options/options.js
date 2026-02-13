const DEFAULTS = {
  backendBaseUrl: "http://127.0.0.1:8787",
  codexModel: "gpt-5.3-codex",
  preferredLanguage: "Polish"
};

const form = document.getElementById("settings-form");
const backendUrlInput = document.getElementById("backend-url");
const modelInput = document.getElementById("codex-model");
const languageInput = document.getElementById("preferred-language");
const connectButton = document.getElementById("connect-account");
const refreshButton = document.getElementById("refresh-status");
const disconnectButton = document.getElementById("disconnect-account");
const authStateEl = document.getElementById("auth-state");
const statusEl = document.getElementById("status");

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = type || "";
}

function normalizeText(value) {
  return String(value || "").replaceAll("\r\n", "\n").trim();
}

function normalizeBaseUrl(url) {
  return normalizeText(url).replace(/\/+$/, "");
}

function updateAuthState(data) {
  if (!data?.logged_in) {
    authStateEl.textContent = "Not connected";
    return;
  }

  const provider = normalizeText(data.provider) || "OpenAI";
  authStateEl.textContent = `Connected (${provider})`;
}

async function loadSettings() {
  const data = await messenger.storage.local.get(DEFAULTS);
  backendUrlInput.value = normalizeBaseUrl(data.backendBaseUrl) || DEFAULTS.backendBaseUrl;
  modelInput.value = normalizeText(data.codexModel) || DEFAULTS.codexModel;
  languageInput.value = normalizeText(data.preferredLanguage) || DEFAULTS.preferredLanguage;
}

async function saveSettings() {
  const backendBaseUrl = normalizeBaseUrl(backendUrlInput.value);
  const codexModel = normalizeText(modelInput.value);

  if (!backendBaseUrl) {
    throw new Error("Backend URL cannot be empty.");
  }
  if (!codexModel) {
    throw new Error("Model cannot be empty.");
  }

  await messenger.storage.local.set({
    backendBaseUrl,
    codexModel,
    preferredLanguage: normalizeText(languageInput.value) || DEFAULTS.preferredLanguage
  });
}

async function openUrl(url) {
  try {
    if (messenger.windows?.openDefaultBrowser) {
      await messenger.windows.openDefaultBrowser(url);
      return;
    }
  } catch (_error) {
    // Fallback below.
  }
  await messenger.tabs.create({ url });
}

async function fetchJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (_error) {
    let origin = url;
    try {
      origin = new URL(url).origin;
    } catch (_parseError) {
      // Keep the raw URL when parsing fails.
    }
    throw new Error(
      `Cannot reach backend at ${origin}. Start it with: cd server && node index.js`
    );
  }

  const text = await response.text();

  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new Error(payload?.error || text || `Request failed (${response.status}).`);
  }

  return payload || {};
}

async function getBackendBaseUrl() {
  await saveSettings();
  const data = await messenger.storage.local.get(DEFAULTS);
  return normalizeBaseUrl(data.backendBaseUrl) || DEFAULTS.backendBaseUrl;
}

async function refreshAuthStatus() {
  try {
    const baseUrl = await getBackendBaseUrl();
    const payload = await fetchJson(`${baseUrl}/auth/openai/status`);
    updateAuthState(payload);
    if (payload.logged_in) {
      setStatus("OpenAI connected.", "success");
    } else {
      setStatus("OpenAI not connected yet.", "");
    }
  } catch (error) {
    updateAuthState({ logged_in: false });
    setStatus(error?.message || "Failed to check auth status.", "error");
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollLogin(baseUrl, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(2000);
    const payload = await fetchJson(
      `${baseUrl}/auth/openai/poll?session_id=${encodeURIComponent(sessionId)}`
    );
    if (payload.status === "pending") {
      continue;
    }
    if (payload.status === "approved") {
      return;
    }
    throw new Error(payload.error || "OpenAI login failed.");
  }
  throw new Error("OpenAI login timed out.");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("", "");
  try {
    await saveSettings();
    setStatus("Settings saved.", "success");
  } catch (error) {
    setStatus(error?.message || "Failed to save settings.", "error");
  }
});

refreshButton.addEventListener("click", async () => {
  setStatus("", "");
  await refreshAuthStatus();
});

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  setStatus("", "");

  try {
    const baseUrl = await getBackendBaseUrl();
    const start = await fetchJson(`${baseUrl}/auth/openai/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });

    if (start.status === "already_logged_in") {
      updateAuthState({ logged_in: true, provider: start.provider || "ChatGPT" });
      setStatus("Already connected.", "success");
      return;
    }

    if (!start.session_id || !start.verification_url) {
      throw new Error("Backend returned invalid login payload.");
    }

    await openUrl(start.verification_url);
    setStatus(
      start.user_code
        ? `Finish OpenAI login in browser (code: ${start.user_code}).`
        : "Finish OpenAI login in browser.",
      "success"
    );

    await pollLogin(baseUrl, start.session_id, (Number(start.expires_in) || 900) * 1000);
    updateAuthState({ logged_in: true, provider: "ChatGPT" });
    setStatus("OpenAI connected.", "success");
  } catch (error) {
    updateAuthState({ logged_in: false });
    setStatus(error?.message || "Failed to connect OpenAI.", "error");
  } finally {
    connectButton.disabled = false;
  }
});

disconnectButton.addEventListener("click", async () => {
  setStatus("", "");
  try {
    const baseUrl = await getBackendBaseUrl();
    await fetchJson(`${baseUrl}/auth/openai/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    updateAuthState({ logged_in: false });
    setStatus("Logged out from OpenAI on backend.", "success");
  } catch (error) {
    setStatus(error?.message || "Failed to log out.", "error");
  }
});

loadSettings()
  .then(() => refreshAuthStatus())
  .catch((error) => {
    setStatus(error?.message || "Failed to initialize settings.", "error");
  });
