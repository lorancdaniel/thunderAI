const form = document.getElementById("generate-form");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const optionsButton = document.getElementById("open-options");
const generateButton = document.getElementById("generate-button");
const promptInput = document.getElementById("prompt");
const toneInput = document.getElementById("tone");
const languageInput = document.getElementById("language");

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = type || "";
}

function showPreview(subject, body) {
  previewEl.hidden = false;
  previewEl.textContent = `Subject: ${subject}\n\n${body}`;
}

async function getComposeTabId() {
  const tabs = await messenger.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) {
    throw new Error("No active compose tab found.");
  }
  return tabs[0].id;
}

function toggleLoading(loading) {
  generateButton.disabled = loading;
  generateButton.textContent = loading ? "Generating..." : "Generate and insert";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  optionsButton.hidden = true;
  previewEl.hidden = true;
  setStatus("", "");

  const prompt = promptInput.value.trim();
  if (!prompt) {
    setStatus("Prompt is required.", "error");
    return;
  }

  toggleLoading(true);
  try {
    const tabId = await getComposeTabId();
    const result = await messenger.runtime.sendMessage({
      type: "GENERATE_EMAIL",
      tabId,
      prompt,
      tone: toneInput.value,
      language: languageInput.value.trim()
    });

    setStatus("Draft generated and inserted.", "success");
    showPreview(result.subject, result.body);
  } catch (error) {
    const message = error?.message || "Unexpected error.";
    setStatus(message, "error");

    if (message.includes("Missing OpenAI API key")) {
      optionsButton.hidden = false;
    }
  } finally {
    toggleLoading(false);
  }
});

optionsButton.addEventListener("click", () => {
  messenger.runtime.openOptionsPage();
});
