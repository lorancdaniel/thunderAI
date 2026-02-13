const statusEl = document.getElementById("status");
const subtitleEl = document.getElementById("subtitle");
const todoListEl = document.getElementById("todo-list");
const emptyStateEl = document.getElementById("empty-state");
const refreshButton = document.getElementById("refresh-button");
const optionsButton = document.getElementById("open-options");
const startServerButton = document.getElementById("start-server");
const serverHealthEl = document.getElementById("server-health");
const serverHealthTextEl = document.getElementById("server-health-text");
let backendStatusTimerId = null;
let todoStateTimerId = null;

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = type || "";
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

function startTodoStatePolling() {
  if (todoStateTimerId) {
    clearInterval(todoStateTimerId);
  }
  todoStateTimerId = setInterval(() => {
    loadState().catch(() => {});
  }, 15_000);
}

function formatLocalDate(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderTodoList(items) {
  todoListEl.innerHTML = "";
  emptyStateEl.hidden = Boolean(items.length);

  for (const item of items) {
    const li = document.createElement("li");
    li.className = `todo-item${item.done ? " is-done" : ""}`;
    li.dataset.todoId = item.id || "";
    li.dataset.messageId = String(item.sourceMessageId || "");
    li.dataset.headerMessageId = item.sourceHeaderMessageId || "";

    const priority = escapeHtml(item.priority || "medium");
    li.innerHTML = `
      <div class="todo-top-row">
        <label class="todo-done">
          <input class="todo-done-checkbox" type="checkbox" ${item.done ? "checked" : ""} />
          <span>Wykonane</span>
        </label>
        <span class="priority ${priority}">${priority}</span>
      </div>
      <p class="todo-title">${escapeHtml(item.title)}</p>
      ${
        item.description
          ? `<p class="todo-description">${escapeHtml(item.description)}</p>`
          : ""
      }
      <p class="todo-meta">${escapeHtml(item.sourceSubject || "(brak tematu)")}</p>
      <p class="todo-meta">${escapeHtml(item.sourceAuthor || "")} ${escapeHtml(
      item.sourceDate ? `| ${formatLocalDate(item.sourceDate)}` : ""
    )}</p>
      <div class="todo-actions">
        <button type="button" class="todo-action todo-reply" ${item.sourceMessageId ? "" : "disabled"}>Odpowiedz</button>
        <button type="button" class="todo-action todo-open">Mail</button>
      </div>
    `;

    todoListEl.appendChild(li);
  }
}

function updateSubtitle(meta, isRefreshing) {
  const parts = [];
  if (meta?.lastGeneratedAt) {
    parts.push(`Ostatnia generacja: ${formatLocalDate(meta.lastGeneratedAt)}`);
  }
  if (isRefreshing) {
    parts.push("Trwa odswiezanie...");
  } else if (meta?.nextRefreshAt) {
    parts.push(`Nastepne auto: ${formatLocalDate(meta.nextRefreshAt)}`);
  } else {
    parts.push("Auto odswiezanie co 60 min");
  }
  subtitleEl.textContent = parts.join(" | ");
}

async function loadState() {
  const state = await messenger.runtime.sendMessage({
    type: "GET_TODO_STATE"
  });
  const items = Array.isArray(state?.items) ? state.items : [];
  const meta = state?.meta || {};

  renderTodoList(items);
  updateSubtitle(meta, Boolean(state?.isRefreshing));

  if (meta.lastError) {
    setStatus(meta.lastError, "error");
  } else if (meta.lastGeneratedAt) {
    setStatus(`TODO: ${items.length} | Mails used: ${meta.sourceMessageCount || 0}`, "success");
  } else {
    setStatus("", "");
  }
}

async function refreshNow() {
  refreshButton.disabled = true;
  setStatus("Odswiezanie TODO...", "");
  try {
    await messenger.runtime.sendMessage({
      type: "REFRESH_TODOS",
      reason: "popup_manual"
    });
    await refreshBackendHealth();
    await loadState();
    setStatus("Lista TODO odswiezona.", "success");
  } catch (error) {
    setStatus(error?.message || "Nie udalo sie odswiezyc listy TODO.", "error");
  } finally {
    refreshButton.disabled = false;
  }
}

async function openTodoSource(target) {
  const messageId = Number(target.dataset.messageId || 0);
  const headerMessageId = target.dataset.headerMessageId || "";

  await messenger.runtime.sendMessage({
    type: "OPEN_TODO_SOURCE",
    messageId,
    headerMessageId
  });
}

async function openTodoReply(target) {
  const todoId = target.dataset.todoId || "";
  const messageId = Number(target.dataset.messageId || 0);

  await messenger.runtime.sendMessage({
    type: "OPEN_TODO_REPLY",
    todoId,
    messageId
  });
}

async function setTodoDone(target, done) {
  const todoId = target.dataset.todoId || "";
  await messenger.runtime.sendMessage({
    type: "SET_TODO_DONE",
    todoId,
    done: Boolean(done)
  });
}

todoListEl.addEventListener("click", async (event) => {
  const item = event.target.closest("li.todo-item");
  if (!item) {
    return;
  }

  try {
    if (event.target.closest("button.todo-reply")) {
      await openTodoReply(item);
      setStatus("Otworzono odpowiedz do maila.", "success");
      return;
    }

    if (event.target.closest("button.todo-open")) {
      await openTodoSource(item);
      setStatus("Otworzono mail zrodlowy.", "success");
    }
  } catch (error) {
    setStatus(error?.message || "Nie udalo sie wykonac akcji TODO.", "error");
  }
});

todoListEl.addEventListener("change", async (event) => {
  const checkbox = event.target.closest("input.todo-done-checkbox");
  if (!checkbox) {
    return;
  }

  const item = checkbox.closest("li.todo-item");
  if (!item) {
    return;
  }

  try {
    await setTodoDone(item, checkbox.checked);
    await loadState();
    setStatus("Zmieniono status TODO.", "success");
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    setStatus(error?.message || "Nie udalo sie zmienic statusu TODO.", "error");
  }
});

refreshButton.addEventListener("click", () => {
  refreshNow();
});

optionsButton.addEventListener("click", () => {
  messenger.runtime.openOptionsPage();
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

window.addEventListener("message", (event) => {
  const payload = event?.data;
  if (payload?.type !== "thundertodo-panel-data") {
    return;
  }
  loadState().catch(() => {});
});

loadState().catch((error) => {
  setStatus(error?.message || "Nie udalo sie pobrac listy TODO.", "error");
});
startBackendHealthPolling();
startTodoStatePolling();

window.addEventListener("unload", () => {
  if (backendStatusTimerId) {
    clearInterval(backendStatusTimerId);
    backendStatusTimerId = null;
  }
  if (todoStateTimerId) {
    clearInterval(todoStateTimerId);
    todoStateTimerId = null;
  }
});
