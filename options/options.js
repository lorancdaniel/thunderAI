const form = document.getElementById("settings-form");
const apiKeyInput = document.getElementById("openai-api-key");
const modelInput = document.getElementById("openai-model");
const languageInput = document.getElementById("preferred-language");
const statusEl = document.getElementById("status");

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = type || "";
}

async function loadSettings() {
  const data = await messenger.storage.local.get({
    openaiApiKey: "",
    openaiModel: "gpt-4o-mini",
    preferredLanguage: "Polish"
  });

  apiKeyInput.value = data.openaiApiKey || "";
  modelInput.value = data.openaiModel || "gpt-4o-mini";
  languageInput.value = data.preferredLanguage || "Polish";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("", "");

  const model = modelInput.value.trim();
  if (!model) {
    setStatus("Model cannot be empty.", "error");
    return;
  }

  try {
    await messenger.storage.local.set({
      openaiApiKey: apiKeyInput.value.trim(),
      openaiModel: model,
      preferredLanguage: languageInput.value.trim() || "Polish"
    });
    setStatus("Settings saved.", "success");
  } catch (error) {
    setStatus(error?.message || "Failed to save settings.", "error");
  }
});

loadSettings().catch((error) => {
  setStatus(error?.message || "Failed to load settings.", "error");
});
