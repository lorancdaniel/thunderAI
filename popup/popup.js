const form = document.getElementById("generate-form");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const optionsButton = document.getElementById("open-options");
const generateButton = document.getElementById("generate-button");
const quickDoneButton = document.getElementById("quick-done");
const quickNotDoneButton = document.getElementById("quick-not-done");
const promptInput = document.getElementById("prompt");
const toneInput = document.getElementById("tone");
const languageInput = document.getElementById("language");

const QUICK_PROMPTS = {
  done:
    "Napisz krotka odpowiedz, ze zadanie zostalo wykonane, na podstawie kontekstu wiadomosci.",
  not_done:
    "Napisz krotka odpowiedz, ze zadanie nie zostalo jeszcze wykonane, na podstawie kontekstu wiadomosci."
};

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

function toggleLoading(loading, source) {
  generateButton.disabled = loading;
  quickDoneButton.disabled = loading;
  quickNotDoneButton.disabled = loading;

  if (loading && source === "quick_done") {
    quickDoneButton.textContent = "Generowanie...";
  } else if (loading && source === "quick_not_done") {
    quickNotDoneButton.textContent = "Generowanie...";
  } else if (loading) {
    generateButton.textContent = "Generowanie...";
  }

  if (!loading) {
    generateButton.textContent = "Generuj i wstaw";
    quickDoneButton.textContent = "Wykonano";
    quickNotDoneButton.textContent = "Nie wykonano";
  }
}

async function runGeneration({ prompt, quickStatus, source }) {
  optionsButton.hidden = true;
  previewEl.hidden = true;
  setStatus("", "");

  toggleLoading(true, source);
  try {
    const tabId = await getComposeTabId();
    const result = await messenger.runtime.sendMessage({
      type: "GENERATE_EMAIL",
      tabId,
      prompt,
      tone: toneInput.value,
      language: languageInput.value.trim(),
      quickStatus
    });

    setStatus("Wiadomosc wygenerowana i wstawiona.", "success");
    showPreview(result.subject, result.body);
  } catch (error) {
    const message = error?.message || "Unexpected error.";
    setStatus(message, "error");

    if (
      message.includes("Not signed in") ||
      message.includes("Session expired") ||
      message.includes("Missing backend URL") ||
      message.includes("Cannot reach backend")
    ) {
      optionsButton.hidden = false;
    }
  } finally {
    toggleLoading(false);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt) {
    setStatus("Prompt jest wymagany dla wlasnej odpowiedzi.", "error");
    return;
  }
  await runGeneration({
    prompt,
    quickStatus: "",
    source: "form"
  });
});

quickDoneButton.addEventListener("click", async () => {
  await runGeneration({
    prompt: QUICK_PROMPTS.done,
    quickStatus: "done",
    source: "quick_done"
  });
});

quickNotDoneButton.addEventListener("click", async () => {
  await runGeneration({
    prompt: QUICK_PROMPTS.not_done,
    quickStatus: "not_done",
    source: "quick_not_done"
  });
});

optionsButton.addEventListener("click", () => {
  messenger.runtime.openOptionsPage();
});
