const DEFAULTS = {
  todoBackendBaseUrl: "http://127.0.0.1:8787",
  todoCodexModel: "gpt-5.3-codex",
  todoLanguage: "Polish",
  todoKeepPanelOpen: true
};

const form = document.getElementById("settings-form");
const backendUrlInput = document.getElementById("backend-url");
const modelInput = document.getElementById("codex-model");
const languageInput = document.getElementById("language");
const keepPanelOpenInput = document.getElementById("keep-panel-open");
const openPanelNowButton = document.getElementById("open-panel-now");
const refreshNowButton = document.getElementById("refresh-now");
const statusEl = document.getElementById("status");
const addonVersionEl = document.getElementById("addon-version");
const serverHealthEl = document.getElementById("server-health");
const serverHealthTextEl = document.getElementById("server-health-text");
const startServerButton = document.getElementById("start-server");
let backendStatusTimerId = null;

function normalizeText(value) {
  return String(value || "").replaceAll("\r\n", "\n").trim();
}

function normalizeBaseUrl(value) {
  return normalizeText(value).replace(/\/+$/, "");
}

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = type || "";
}

function renderAddonVersion() {
  const version = messenger.runtime?.getManifest?.().version || "";
  addonVersionEl.textContent = version ? `Addon version: ${version}` : "";
}

function renderBackendHealth(status) {
  const online = status?.online === true;
  const offline = status?.online === false;
  serverHealthEl.className = `server-health ${online ? "online" : offline ? "offline" : "unknown"}`;
  serverHealthTextEl.textContent = online ? "Serwer online" : offline ? "Serwer offline" : "Status serwera nieznany";
}

async function refreshBackendHealth() {
  try {
    const status = await messenger.runtime.sendMessage({
      type: "GET_BACKEND_STATUS"
    });
    renderBackendHealth(status);
    return status;
  } catch (_error) {
    const fallback = {
      online: false
    };
    renderBackendHealth(fallback);
    return fallback;
  }
}

function startBackendHealthPolling() {
  if (backendStatusTimerId) {
    clearInterval(backendStatusTimerId);
  }
  refreshBackendHealth().catch(() => {});
  backendStatusTimerId = setInterval(() => {
    refreshBackendHealth().catch(() => {});
  }, 30_000);
}

async function loadSettings() {
  const data = await messenger.storage.local.get(DEFAULTS);
  backendUrlInput.value = normalizeBaseUrl(data.todoBackendBaseUrl) || DEFAULTS.todoBackendBaseUrl;
  modelInput.value = normalizeText(data.todoCodexModel) || DEFAULTS.todoCodexModel;
  languageInput.value = normalizeText(data.todoLanguage) || DEFAULTS.todoLanguage;
  keepPanelOpenInput.checked = data.todoKeepPanelOpen !== false;
}

async function saveSettings() {
  const backendBaseUrl = normalizeBaseUrl(backendUrlInput.value);
  const model = normalizeText(modelInput.value);
  const language = normalizeText(languageInput.value) || DEFAULTS.todoLanguage;
  const keepPanelOpen = Boolean(keepPanelOpenInput.checked);

  if (!backendBaseUrl) {
    throw new Error("Backend URL nie moze byc puste.");
  }
  if (!model) {
    throw new Error("Model nie moze byc pusty.");
  }

  await messenger.storage.local.set({
    todoBackendBaseUrl: backendBaseUrl,
    todoCodexModel: model,
    todoLanguage: language,
    todoKeepPanelOpen: keepPanelOpen
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("", "");

  try {
    await saveSettings();
    await messenger.runtime.sendMessage({
      type: "APPLY_TODO_PANEL_POLICY"
    });
    await refreshBackendHealth();
    setStatus("Ustawienia zapisane.", "success");
  } catch (error) {
    setStatus(error?.message || "Nie udalo sie zapisac ustawien.", "error");
  }
});

refreshNowButton.addEventListener("click", async () => {
  refreshNowButton.disabled = true;
  setStatus("Wymuszam odswiezenie TODO...", "");

  try {
    await saveSettings();
    const state = await messenger.runtime.sendMessage({
      type: "REFRESH_TODOS",
      reason: "options_manual"
    });
    await refreshBackendHealth();
    const count = Array.isArray(state?.items) ? state.items.length : 0;
    setStatus(`TODO odswiezone. Liczba pozycji: ${count}.`, "success");
  } catch (error) {
    setStatus(error?.message || "Nie udalo sie odswiezyc TODO.", "error");
  } finally {
    refreshNowButton.disabled = false;
  }
});

openPanelNowButton.addEventListener("click", async () => {
  openPanelNowButton.disabled = true;
  setStatus("Otwieram panel TODO...", "");

  try {
    await saveSettings();
    await messenger.runtime.sendMessage({
      type: "OPEN_TODO_PANEL"
    });
    await refreshBackendHealth();
    setStatus("Panel TODO otwarty.", "success");
  } catch (error) {
    setStatus(error?.message || "Nie udalo sie otworzyc panelu TODO.", "error");
  } finally {
    openPanelNowButton.disabled = false;
  }
});

startServerButton.addEventListener("click", async () => {
  startServerButton.disabled = true;
  setStatus("Uruchamiam serwer...", "");
  try {
    await messenger.runtime.sendMessage({
      type: "START_BACKEND_SERVICE"
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const status = await refreshBackendHealth();
    if (status?.online === true) {
      setStatus("Serwer uruchomiony.", "success");
    } else {
      setStatus("Wyslano polecenie startu, serwer jeszcze odpowiada offline.", "error");
    }
  } catch (error) {
    setStatus(error?.message || "Nie udalo sie uruchomic serwera.", "error");
  } finally {
    startServerButton.disabled = false;
  }
});

loadSettings().catch((error) => {
  setStatus(error?.message || "Nie udalo sie wczytac ustawien.", "error");
});

renderAddonVersion();
startBackendHealthPolling();

window.addEventListener("unload", () => {
  if (backendStatusTimerId) {
    clearInterval(backendStatusTimerId);
    backendStatusTimerId = null;
  }
});
