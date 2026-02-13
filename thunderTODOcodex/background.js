const DEFAULT_BACKEND_URL = "http://127.0.0.1:8787";
const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";
const DEFAULT_LANGUAGE = "Polish";
const DEFAULT_LOOKBACK_HOURS = 72;
const HOURLY_REFRESH_MINUTES = 60;
const STALE_AFTER_MS = 60 * 60 * 1000;
const MAX_MESSAGES_FOR_ANALYSIS = 40;
const MAX_MESSAGES_PER_QUERY = 120;
const SNIPPET_LIMIT = 700;
const MAX_TODOS = 25;
const REFRESH_ALARM = "thundertodo-hourly-refresh";
const REQUEST_TIMEOUT_MS = 120000;
const TODO_PANEL_PAGE = "popup/popup.html?view=panel";
const TODO_PANEL_WIDTH = 340;
const TODO_PANEL_TOP_OFFSET = 76;
const TODO_PANEL_BOTTOM_MARGIN = 20;
const TODO_PANEL_MIN_HEIGHT = 420;
const TODO_PANEL_REOPEN_DELAY_MS = 900;
const MAX_STORED_TODOS = 400;
const MAX_ARCHIVED_TODOS = 800;
const DONE_TO_ARCHIVE_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_REPLY_TYPE = "replyToSender";
const TODO_STATE_SYNC_TIMEOUT_MS = 8_000;
const BACKEND_STATUS_TIMEOUT_MS = 5_000;
const BACKEND_STATUS_STALE_MS = 90_000;
const MAX_PROCESSED_MESSAGE_KEYS = 6000;

let refreshPromise = null;
let panelWindowId = null;
let panelTabId = null;
let panelWindowPromise = null;
let experimentPanelActionListenerAdded = false;
const replyTabTodoMap = new Map();

function normalizeText(value) {
  return String(value || "").replaceAll("\r\n", "\n").trim();
}

function normalizeBaseUrl(value) {
  return normalizeText(value).replace(/\/+$/, "");
}

function normalizeProcessedMessageKeys(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = [];
  const seen = new Set();
  for (const entry of value) {
    const key = normalizeText(entry).toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
    if (normalized.length >= MAX_PROCESSED_MESSAGE_KEYS) {
      break;
    }
  }
  return normalized;
}

function getMessageTrackingKeyFromHeader(header) {
  const headerMessageId = normalizeText(header?.headerMessageId).toLowerCase();
  if (headerMessageId) {
    return `h:${headerMessageId}`;
  }

  const messageId = Number(header?.id || 0);
  if (messageId) {
    return `m:${messageId}`;
  }

  return "";
}

function getMessageTrackingKeyFromSummary(summary) {
  const headerMessageId = normalizeText(summary?.headerMessageId).toLowerCase();
  if (headerMessageId) {
    return `h:${headerMessageId}`;
  }

  const messageId = Number(summary?.messageId || 0);
  if (messageId) {
    return `m:${messageId}`;
  }

  return "";
}

function getMessageTrackingKeyFromTodoItem(item) {
  const headerMessageId = normalizeText(item?.sourceHeaderMessageId).toLowerCase();
  if (headerMessageId) {
    return `h:${headerMessageId}`;
  }

  const messageId = Number(item?.sourceMessageId || 0);
  if (messageId) {
    return `m:${messageId}`;
  }

  return "";
}

function collectProcessedMessageKeysFromTodos(items, archiveItems) {
  const keys = [];

  for (const item of Array.isArray(items) ? items : []) {
    const key = getMessageTrackingKeyFromTodoItem(item);
    if (key) {
      keys.push(key);
    }
  }

  for (const item of Array.isArray(archiveItems) ? archiveItems : []) {
    const key = getMessageTrackingKeyFromTodoItem(item);
    if (key) {
      keys.push(key);
    }
  }

  return normalizeProcessedMessageKeys(keys);
}

function mergeProcessedMessageKeys(...lists) {
  const merged = [];
  const seen = new Set();

  for (const list of lists) {
    for (const key of normalizeProcessedMessageKeys(list)) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(key);
    }
  }

  if (merged.length <= MAX_PROCESSED_MESSAGE_KEYS) {
    return merged;
  }

  return merged.slice(merged.length - MAX_PROCESSED_MESSAGE_KEYS);
}

function hasTodoPanelExperimentApi() {
  return Boolean(
    messenger.todoPanelExperiment &&
    typeof messenger.todoPanelExperiment.ensurePanel === "function"
  );
}

async function ensureEmbeddedTodoPanel(options = {}) {
  if (!hasTodoPanelExperimentApi()) {
    return null;
  }

  const payload = {
    url: messenger.runtime.getURL(TODO_PANEL_PAGE),
    width: TODO_PANEL_WIDTH,
    visible: options.visible !== false,
    focus: options.focus === true
  };
  await messenger.todoPanelExperiment.ensurePanel(payload);
  panelWindowId = null;
  panelTabId = null;
  return { mode: "embedded" };
}

async function setEmbeddedTodoPanelVisible(visible) {
  if (!hasTodoPanelExperimentApi() || typeof messenger.todoPanelExperiment.setPanelVisible !== "function") {
    return false;
  }
  await messenger.todoPanelExperiment.setPanelVisible(Boolean(visible));
  return true;
}

async function syncEmbeddedTodoPanelData(state) {
  if (!hasTodoPanelExperimentApi() || typeof messenger.todoPanelExperiment.setPanelData !== "function") {
    return false;
  }

  const safeState = state && typeof state === "object" ? state : await getViewState();
  const stateWithBackendStatus = await hydrateStateWithBackendStatus(safeState);
  await messenger.todoPanelExperiment.setPanelData({
    items: Array.isArray(stateWithBackendStatus.items) ? stateWithBackendStatus.items : [],
    meta:
      stateWithBackendStatus.meta && typeof stateWithBackendStatus.meta === "object"
        ? stateWithBackendStatus.meta
        : {}
  });
  return true;
}

async function persistTodoStateToBackend({ items = [], archiveItems = [], meta = {} } = {}) {
  const settings = await loadSettings();
  const payload = {
    items: Array.isArray(items) ? items : [],
    archiveItems: Array.isArray(archiveItems) ? archiveItems : [],
    meta: meta && typeof meta === "object" ? meta : {},
    savedAt: new Date().toISOString()
  };
  const candidates = buildLoopbackFallbackUrls(settings.backendBaseUrl);
  let lastError = null;

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TODO_STATE_SYNC_TIMEOUT_MS);
    try {
      const response = await fetch(`${candidate}/api/todos/state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (response.ok) {
        clearTimeout(timeoutId);
        return true;
      }
      lastError = new Error(`State sync failed with HTTP ${response.status} on ${candidate}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (lastError) {
    throw lastError;
  }
  return false;
}

function normalizeImportedTodoItem(raw, index, { archived = false } = {}) {
  const sourceKey = normalizeText(raw?.sourceKey) || `IMPORTED-${index + 1}`;
  const title = truncateText(raw?.title || raw?.task || raw?.todo, 120);
  if (!title) {
    return null;
  }

  const done = archived ? true : Boolean(raw?.done);
  const normalizedDoneAt = formatDateToIso(raw?.doneAt);
  const normalizedArchivedAt = formatDateToIso(raw?.archivedAt);

  return {
    id: normalizeText(raw?.id) || buildTodoId(sourceKey, title),
    sourceKey,
    title,
    description: truncateText(raw?.description || raw?.details || "", 500),
    priority: normalizeTodoPriority(raw?.priority),
    sourceMessageId: Number(raw?.sourceMessageId || 0),
    sourceHeaderMessageId: normalizeText(raw?.sourceHeaderMessageId),
    sourceSubject: truncateText(raw?.sourceSubject || "(brak tematu)", 220),
    sourceAuthor: truncateText(raw?.sourceAuthor || "", 180),
    sourceDate: formatDateToIso(raw?.sourceDate),
    done,
    doneAt: done ? normalizedDoneAt : "",
    archivedAt: archived ? normalizedArchivedAt : ""
  };
}

function normalizeImportedTodoStatePayload(state) {
  const rawState = state && typeof state === "object" ? state : {};
  const rawItems = Array.isArray(rawState.items) ? rawState.items : [];
  const rawArchiveItems = Array.isArray(rawState.archiveItems) ? rawState.archiveItems : [];

  const items = rawItems
    .map((item, index) => normalizeImportedTodoItem(item, index, { archived: false }))
    .filter(Boolean)
    .slice(0, MAX_STORED_TODOS);

  const archiveItems = rawArchiveItems
    .map((item, index) => normalizeImportedTodoItem(item, index, { archived: true }))
    .filter(Boolean)
    .slice(0, MAX_ARCHIVED_TODOS);

  const rawMeta = rawState.meta && typeof rawState.meta === "object" ? rawState.meta : {};
  const meta = {
    ...rawMeta,
    processedMessageKeys: normalizeProcessedMessageKeys(rawMeta.processedMessageKeys)
  };
  return {
    items,
    archiveItems,
    meta
  };
}

async function fetchTodoStateFromBackend() {
  const settings = await loadSettings();
  const candidates = buildLoopbackFallbackUrls(settings.backendBaseUrl);
  let lastError = null;

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TODO_STATE_SYNC_TIMEOUT_MS);
    try {
      const response = await fetch(`${candidate}/api/todos/state`, {
        method: "GET",
        signal: controller.signal
      });

      if (!response.ok) {
        lastError = new Error(`State fetch failed with HTTP ${response.status} on ${candidate}`);
        continue;
      }

      const body = await response.json().catch(() => null);
      const remoteState = body?.state && typeof body.state === "object" ? body.state : null;
      if (!remoteState) {
        lastError = new Error("Invalid backend TODO state payload.");
        continue;
      }

      return normalizeImportedTodoStatePayload(remoteState);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("Failed to fetch TODO state from backend.");
}

async function importTodoStateFromBackendIfLocalEmpty() {
  const localState = await loadTodoState();
  const hasLocalData =
    (Array.isArray(localState.items) && localState.items.length > 0) ||
    (Array.isArray(localState.archiveItems) && localState.archiveItems.length > 0);

  if (hasLocalData) {
    return {
      imported: false,
      state: localState
    };
  }

  const remoteState = await fetchTodoStateFromBackend();
  const hasRemoteData =
    (Array.isArray(remoteState.items) && remoteState.items.length > 0) ||
    (Array.isArray(remoteState.archiveItems) && remoteState.archiveItems.length > 0);

  if (!hasRemoteData) {
    return {
      imported: false,
      state: localState
    };
  }

  const normalized = normalizeTodoCollections(remoteState.items, remoteState.archiveItems);
  const nowIso = new Date().toISOString();
  const inferredProcessedKeys = collectProcessedMessageKeysFromTodos(
    normalized.items,
    normalized.archiveItems
  );
  const mergedProcessedKeys = mergeProcessedMessageKeys(
    remoteState.meta?.processedMessageKeys,
    inferredProcessedKeys
  );
  const meta = {
    ...localState.meta,
    ...(remoteState.meta || {}),
    lastImportedFromBackendAt: nowIso,
    backendOnline: true,
    backendStatusCheckedAt: nowIso,
    processedMessageKeys: mergedProcessedKeys,
    todoCount: normalized.items.length,
    archiveCount: normalized.archiveItems.length
  };

  await saveTodoState(normalized.items, meta, normalized.archiveItems);
  return {
    imported: true,
    state: {
      items: normalized.items,
      archiveItems: normalized.archiveItems,
      meta
    }
  };
}

function buildLoopbackFallbackUrls(backendBaseUrl) {
  const urls = [];
  const pushUnique = (value) => {
    const normalized = normalizeBaseUrl(value);
    if (normalized && !urls.includes(normalized)) {
      urls.push(normalized);
    }
  };

  pushUnique(backendBaseUrl);

  let parsed;
  try {
    parsed = new URL(urls[0]);
  } catch (_error) {
    return urls;
  }

  const host = normalizeText(parsed.hostname).toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback) {
    return urls;
  }

  for (const altHost of ["127.0.0.1", "localhost", "::1"]) {
    if (altHost === host) {
      continue;
    }
    const alt = new URL(parsed.toString());
    alt.hostname = altHost;
    pushUnique(alt.toString());
  }

  return urls;
}

async function getBackendStatusByBaseUrl(backendBaseUrl) {
  const candidates = buildLoopbackFallbackUrls(backendBaseUrl);
  let lastError = null;

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_STATUS_TIMEOUT_MS);
    try {
      const response = await fetch(`${candidate}/health`, {
        method: "GET",
        signal: controller.signal
      });
      if (!response.ok) {
        lastError = new Error(`Health check HTTP ${response.status}`);
        continue;
      }

      let body = null;
      try {
        body = await response.json();
      } catch (_error) {
        body = null;
      }

      return {
        online: true,
        backendBaseUrl: candidate,
        codexAuth: body?.codex_auth === true,
        checkedAt: new Date().toISOString(),
        error: ""
      };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    online: false,
    backendBaseUrl: candidates[0] || normalizeBaseUrl(backendBaseUrl),
    codexAuth: false,
    checkedAt: new Date().toISOString(),
    error: lastError?.message || "Health check failed."
  };
}

async function getLiveBackendStatus() {
  const settings = await loadSettings();
  return getBackendStatusByBaseUrl(settings.backendBaseUrl);
}

async function startBackendService() {
  if (
    hasTodoPanelExperimentApi() &&
    typeof messenger.todoPanelExperiment.startBackendService === "function"
  ) {
    await messenger.todoPanelExperiment.startBackendService();
    const liveStatus = await getLiveBackendStatus().catch(() => ({
      online: false,
      codexAuth: false,
      checkedAt: new Date().toISOString()
    }));
    return {
      ok: true,
      online: liveStatus.online === true
    };
  }

  throw new Error(
    "Automatyczny start serwera wymaga Experiment API oraz LaunchAgent com.thunderai.server."
  );
}

async function hydrateStateWithBackendStatus(state, options = {}) {
  const safeState = state && typeof state === "object" ? state : {};
  const safeMeta = safeState.meta && typeof safeState.meta === "object" ? safeState.meta : {};
  const force = options?.force === true;
  const hasKnownStatus = typeof safeMeta.backendOnline === "boolean";
  const checkedAtMs = toTimestamp(safeMeta.backendStatusCheckedAt);
  const isFresh = checkedAtMs > 0 && Date.now() - checkedAtMs < BACKEND_STATUS_STALE_MS;

  if (!force && hasKnownStatus && isFresh) {
    return {
      items: Array.isArray(safeState.items) ? safeState.items : [],
      archiveItems: Array.isArray(safeState.archiveItems) ? safeState.archiveItems : [],
      meta: safeMeta
    };
  }

  try {
    const live = await getLiveBackendStatus();
    return {
      items: Array.isArray(safeState.items) ? safeState.items : [],
      archiveItems: Array.isArray(safeState.archiveItems) ? safeState.archiveItems : [],
      meta: {
        ...safeMeta,
        backendOnline: live.online === true,
        backendCodexAuth: live.codexAuth === true,
        backendStatusCheckedAt: live.checkedAt || new Date().toISOString()
      }
    };
  } catch (_error) {
    return {
      items: Array.isArray(safeState.items) ? safeState.items : [],
      archiveItems: Array.isArray(safeState.archiveItems) ? safeState.archiveItems : [],
      meta: hasKnownStatus
        ? safeMeta
        : {
            ...safeMeta,
            backendOnline: false,
            backendCodexAuth: false,
            backendStatusCheckedAt: new Date().toISOString()
          }
    };
  }
}

function truncateText(value, maxLength) {
  const text = normalizeText(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n\n[...truncated...]`;
}

function stripHtml(value) {
  return String(value || "")
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

function formatDateToIso(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString();
}

function buildTodoId(sourceKey, title) {
  const stamp = Date.now().toString(36);
  const safeTitle = normalizeText(title).slice(0, 24).replace(/[^a-z0-9]+/gi, "-");
  return `${sourceKey}-${safeTitle || "todo"}-${stamp}`;
}

async function loadSettings() {
  const data = await messenger.storage.local.get({
    todoBackendBaseUrl: DEFAULT_BACKEND_URL,
    todoCodexModel: DEFAULT_CODEX_MODEL,
    todoLanguage: DEFAULT_LANGUAGE,
    todoKeepPanelOpen: true
  });

  return {
    backendBaseUrl: normalizeBaseUrl(data.todoBackendBaseUrl) || DEFAULT_BACKEND_URL,
    model: normalizeText(data.todoCodexModel) || DEFAULT_CODEX_MODEL,
    language: normalizeText(data.todoLanguage) || DEFAULT_LANGUAGE,
    keepPanelOpen: data.todoKeepPanelOpen !== false
  };
}

async function loadTodoState() {
  const data = await messenger.storage.local.get({
    todoItems: [],
    todoArchiveItems: [],
    todoMeta: {
      lastGeneratedAt: "",
      lastAttemptAt: "",
      lastError: "",
      lastReason: "",
      sourceMessageCount: 0,
      archiveCount: 0,
      processedMessageKeys: []
    }
  });

  const rawMeta = data.todoMeta && typeof data.todoMeta === "object" ? data.todoMeta : {};
  const processedFromMeta = normalizeProcessedMessageKeys(rawMeta.processedMessageKeys);
  const inferredProcessed = collectProcessedMessageKeysFromTodos(data.todoItems, data.todoArchiveItems);
  const mergedProcessed = mergeProcessedMessageKeys(processedFromMeta, inferredProcessed);

  return {
    items: Array.isArray(data.todoItems) ? data.todoItems : [],
    archiveItems: Array.isArray(data.todoArchiveItems) ? data.todoArchiveItems : [],
    meta: {
      ...rawMeta,
      processedMessageKeys: mergedProcessed
    }
  };
}

async function saveTodoState(items, meta, archiveItems = []) {
  const inferredProcessedKeys = collectProcessedMessageKeysFromTodos(items, archiveItems);
  const normalizedMeta = {
    ...(meta && typeof meta === "object" ? meta : {}),
    processedMessageKeys: mergeProcessedMessageKeys(meta?.processedMessageKeys, inferredProcessedKeys),
    todoCount: Array.isArray(items) ? items.length : 0,
    archiveCount: Array.isArray(archiveItems) ? archiveItems.length : 0
  };

  await messenger.storage.local.set({
    todoItems: items,
    todoArchiveItems: archiveItems,
    todoMeta: normalizedMeta
  });

  persistTodoStateToBackend({
    items,
    archiveItems,
    meta: normalizedMeta
  }).catch((error) => {
    console.warn("[thunderTODOcodex] backend file sync skipped:", error?.message || error);
  });
}

function toSafeInteger(value, fallback = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.round(value);
}

function computePanelBounds(hostWindow) {
  if (!hostWindow) {
    return {
      width: TODO_PANEL_WIDTH,
      height: TODO_PANEL_MIN_HEIGHT
    };
  }

  const hostLeft = toSafeInteger(hostWindow?.left, 0);
  const hostTop = toSafeInteger(hostWindow?.top, 0);
  const hostWidth = Math.max(toSafeInteger(hostWindow?.width, TODO_PANEL_WIDTH + 820), TODO_PANEL_WIDTH + 120);
  const hostHeight = Math.max(
    toSafeInteger(hostWindow?.height, TODO_PANEL_MIN_HEIGHT + TODO_PANEL_TOP_OFFSET + TODO_PANEL_BOTTOM_MARGIN),
    TODO_PANEL_MIN_HEIGHT
  );
  const top = hostTop + TODO_PANEL_TOP_OFFSET;
  const left = hostLeft + hostWidth - TODO_PANEL_WIDTH;
  const height = Math.max(hostHeight - TODO_PANEL_TOP_OFFSET - TODO_PANEL_BOTTOM_MARGIN, TODO_PANEL_MIN_HEIGHT);

  return {
    left,
    top,
    width: TODO_PANEL_WIDTH,
    height
  };
}

async function getHostWindowForPanel() {
  if (!messenger.windows) {
    return null;
  }

  try {
    const focused = await messenger.windows.getLastFocused();
    if (focused?.type === "normal") {
      return focused;
    }
  } catch (_error) {
    // Fallback below.
  }

  try {
    const allWindows = await messenger.windows.getAll();
    return allWindows.find((windowInfo) => windowInfo?.type === "normal") || null;
  } catch (_error) {
    return null;
  }
}

async function openTodoPanelTabFallback(focus = false) {
  if (!messenger.tabs || typeof messenger.tabs.create !== "function") {
    return null;
  }

  const panelUrl = messenger.runtime.getURL(TODO_PANEL_PAGE);

  try {
    if (typeof messenger.tabs.query === "function") {
      const existingTabs = await messenger.tabs.query({ url: panelUrl });
      const existing = Array.isArray(existingTabs) ? existingTabs[0] : null;
      if (existing?.id && typeof messenger.tabs.update === "function") {
        await messenger.tabs.update(existing.id, { active: Boolean(focus) });
        panelTabId = existing.id;
        return existing;
      }
    }
  } catch (_error) {
    // Fallback below.
  }

  const created = await messenger.tabs.create({
    url: panelUrl,
    active: Boolean(focus)
  });
  if (created?.id) {
    panelTabId = created.id;
  }
  return created;
}

async function ensureTodoPanelWindow(options = {}) {
  const focus = Boolean(options?.focus);
  const visible = options?.visible !== false;

  if (hasTodoPanelExperimentApi()) {
    try {
      return await ensureEmbeddedTodoPanel({
        focus,
        visible
      });
    } catch (error) {
      console.error("[thunderTODOcodex] embedded panel failed, fallback to window/tab:", error);
    }
  }

  if (!messenger.windows || typeof messenger.windows.create !== "function") {
    return openTodoPanelTabFallback(focus);
  }

  if (panelWindowPromise) {
    return panelWindowPromise;
  }

  panelWindowPromise = (async () => {
    if (panelWindowId) {
      try {
        let existing = await messenger.windows.get(panelWindowId);
        if (focus && typeof messenger.windows.update === "function") {
          existing = await messenger.windows.update(panelWindowId, { focused: true });
        }
        panelTabId = null;
        return existing;
      } catch (_error) {
        panelWindowId = null;
      }
    }

    const hostWindow = await getHostWindowForPanel();
    const panelBounds = computePanelBounds(hostWindow);
    try {
      const panelWindow = await messenger.windows.create({
        type: "popup",
        url: messenger.runtime.getURL(TODO_PANEL_PAGE),
        focused: focus,
        ...panelBounds
      });
      panelWindowId = panelWindow.id;
      panelTabId = null;
      return panelWindow;
    } catch (_error) {
      return openTodoPanelTabFallback(focus);
    }
  })().catch((error) => {
    console.error("[thunderTODOcodex] panel open failed:", error);
    return null;
  }).finally(() => {
    panelWindowPromise = null;
  });

  return panelWindowPromise;
}

async function shouldKeepPanelOpen() {
  const data = await messenger.storage.local.get({
    todoKeepPanelOpen: true
  });
  return data.todoKeepPanelOpen !== false;
}

async function applyTodoPanelPolicy({ focus = false } = {}) {
  const keepPanelOpen = await shouldKeepPanelOpen();

  if (hasTodoPanelExperimentApi()) {
    if (keepPanelOpen) {
      await ensureEmbeddedTodoPanel({
        focus,
        visible: true
      });
      await syncEmbeddedTodoPanelData().catch((error) => {
        console.error("[thunderTODOcodex] embedded panel data sync failed:", error);
      });
      return { keepPanelOpen, mode: "embedded-visible" };
    }

    await setEmbeddedTodoPanelVisible(false);
    return { keepPanelOpen, mode: "embedded-hidden" };
  }

  if (keepPanelOpen) {
    await ensureTodoPanelWindow({ focus });
    return { keepPanelOpen, mode: "fallback-visible" };
  }

  return { keepPanelOpen, mode: "fallback-hidden" };
}

async function ensureRefreshAlarm() {
  await messenger.alarms.create(REFRESH_ALARM, {
    periodInMinutes: HOURLY_REFRESH_MINUTES
  });
}

async function queryMessagesLimited(queryInfo, maxCount) {
  const safeMax = Math.max(1, Math.min(maxCount || MAX_MESSAGES_PER_QUERY, 250));
  let list = null;
  const all = [];

  try {
    list = await messenger.messages.query({
      ...queryInfo,
      messagesPerPage: Math.min(100, safeMax)
    });

    if (Array.isArray(list?.messages)) {
      all.push(...list.messages);
    }

    while (list?.id && all.length < safeMax) {
      list = await messenger.messages.continueList(list.id);
      if (!Array.isArray(list?.messages) || !list.messages.length) {
        break;
      }
      all.push(...list.messages);
    }
  } finally {
    if (list?.id) {
      try {
        await messenger.messages.abortList(list.id);
      } catch (_error) {
        // Ignore abort errors.
      }
    }
  }

  return all.slice(0, safeMax);
}

function extractTextFromMessagePart(part, collector) {
  if (!part) {
    return;
  }

  if (part.body && typeof part.body === "string") {
    const contentType = normalizeText(part.contentType).toLowerCase();
    if (contentType.startsWith("text/plain")) {
      collector.plain.push(part.body);
    } else if (contentType.startsWith("text/html")) {
      collector.html.push(part.body);
    }
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      extractTextFromMessagePart(child, collector);
    }
  }
}

function collectInlineParts(parts) {
  const plain = [];
  const html = [];

  if (!Array.isArray(parts)) {
    return "";
  }

  for (const part of parts) {
    const contentType = normalizeText(part?.contentType).toLowerCase();
    const content = typeof part?.content === "string" ? part.content : "";
    if (!content) {
      continue;
    }
    if (contentType.startsWith("text/plain")) {
      plain.push(content);
    } else if (contentType.startsWith("text/html")) {
      html.push(content);
    }
  }

  if (plain.length) {
    return plain.join("\n\n");
  }
  if (html.length) {
    return stripHtml(html.join("\n\n"));
  }
  return "";
}

async function extractMessageSnippet(messageId) {
  try {
    if (typeof messenger.messages.listInlineTextParts === "function") {
      const parts = await messenger.messages.listInlineTextParts(messageId);
      const inlineText = collectInlineParts(parts);
      if (inlineText) {
        return truncateText(inlineText, SNIPPET_LIMIT);
      }
    }
  } catch (_error) {
    // Fallback below.
  }

  try {
    const full = await messenger.messages.getFull(messageId, {
      decodeContent: true,
      decrypt: true
    });
    const collector = { plain: [], html: [] };
    extractTextFromMessagePart(full, collector);

    const text = collector.plain.length
      ? collector.plain.join("\n\n")
      : collector.html.length
        ? stripHtml(collector.html.join("\n\n"))
        : "";

    return truncateText(text, SNIPPET_LIMIT);
  } catch (_error) {
    return "";
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const safeConcurrency = Math.max(1, Math.min(concurrency || 4, 8));
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const currentIndex = cursor;
      cursor += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = [];
  for (let index = 0; index < safeConcurrency; index += 1) {
    workers.push(runWorker());
  }
  await Promise.all(workers);

  return results;
}

async function collectCandidateHeaders(lastGeneratedAt, processedMessageKeys = []) {
  const now = Date.now();
  const lookbackStart = new Date(now - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000);
  const recentStart = lastGeneratedAt
    ? new Date(new Date(lastGeneratedAt).getTime() - 15 * 60 * 1000)
    : lookbackStart;
  const processedSet = new Set(normalizeProcessedMessageKeys(processedMessageKeys));

  const safeQuery = async (queryInfo, maxCount) => {
    try {
      return await queryMessagesLimited(queryInfo, maxCount);
    } catch (_error) {
      return [];
    }
  };

  const [unreadHeaders, flaggedHeaders, recentHeaders] = await Promise.all([
    safeQuery(
      {
        fromDate: lookbackStart,
        unread: true
      },
      MAX_MESSAGES_PER_QUERY
    ),
    safeQuery(
      {
        fromDate: lookbackStart,
        flagged: true
      },
      MAX_MESSAGES_PER_QUERY
    ),
    safeQuery(
      {
        fromDate: recentStart
      },
      MAX_MESSAGES_PER_QUERY
    )
  ]);

  const byKey = new Map();
  const merged = [...recentHeaders, ...unreadHeaders, ...flaggedHeaders];
  for (const header of merged) {
    const trackingKey = getMessageTrackingKeyFromHeader(header);
    if (trackingKey && processedSet.has(trackingKey)) {
      continue;
    }

    const headerMessageId = normalizeText(header?.headerMessageId);
    const key = headerMessageId || String(header?.id || "");
    if (!key || byKey.has(key)) {
      continue;
    }
    byKey.set(key, header);
  }

  return Array.from(byKey.values())
    .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
    .slice(0, MAX_MESSAGES_FOR_ANALYSIS);
}

async function buildMessageSummaries(headers) {
  const summaries = await mapWithConcurrency(headers, 4, async (header, index) => {
    const snippet = await extractMessageSnippet(header.id);
    const sourceKey = `M${index + 1}`;

    return {
      sourceKey,
      messageId: Number(header.id),
      headerMessageId: normalizeText(header.headerMessageId),
      subject: normalizeText(header.subject) || "(no subject)",
      author: normalizeText(header.author) || "(unknown sender)",
      date: formatDateToIso(header.date),
      folderPath: normalizeText(header?.folder?.path || header?.folder?.name || ""),
      snippet
    };
  });

  return summaries.filter((entry) => entry && (entry.subject || entry.snippet));
}

async function callTodoBackend({ backendBaseUrl, payload }) {
  const candidates = buildLoopbackFallbackUrls(backendBaseUrl);
  const primaryBaseUrl = normalizeBaseUrl(backendBaseUrl);
  let lastNetworkError = null;

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      let response;
      try {
        response = await fetch(`${candidate}/api/todos/generate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      } catch (error) {
        const wrapped = new Error(`Cannot reach backend at ${candidate}.`);
        wrapped.isNetworkError = true;
        wrapped.originalErrorName = error?.name || "";
        throw wrapped;
      }

      const text = await response.text();
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (_error) {
          body = null;
        }
      }

      if (!response.ok) {
        const details = body?.error || text || `Backend error ${response.status}.`;
        throw new Error(details);
      }

      if (!body || typeof body !== "object") {
        throw new Error("Invalid backend response format.");
      }

      if (candidate !== primaryBaseUrl) {
        await messenger.storage.local.set({
          todoBackendBaseUrl: candidate
        });
      }

      return body;
    } catch (error) {
      if (!error?.isNetworkError) {
        throw error;
      }
      lastNetworkError = error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const attempts = candidates.join(", ");
  const timeoutHint = lastNetworkError?.originalErrorName === "AbortError"
    ? " Request timed out."
    : "";
  throw new Error(
    `Cannot reach backend. Tried: ${attempts}.${timeoutHint} Start it with: cd server && node index.js`
  );
}

function normalizeTodoPriority(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  return "medium";
}

function normalizeTodos(rawTodos, sourceByKey) {
  if (!Array.isArray(rawTodos)) {
    return [];
  }

  const dedupe = new Set();
  const normalized = [];

  for (const raw of rawTodos) {
    const sourceKey = normalizeText(raw?.sourceKey || raw?.source_key);
    if (!sourceKey || !sourceByKey.has(sourceKey)) {
      continue;
    }

    const title = truncateText(raw?.title || raw?.task || raw?.todo, 120);
    const description = truncateText(raw?.description || raw?.details || "", 500);
    if (!title) {
      continue;
    }

    const dedupeKey = `${sourceKey}::${title.toLowerCase()}`;
    if (dedupe.has(dedupeKey)) {
      continue;
    }
    dedupe.add(dedupeKey);

    const source = sourceByKey.get(sourceKey);
    normalized.push({
      id: buildTodoId(sourceKey, title),
      sourceKey,
      title,
      description,
      priority: normalizeTodoPriority(raw?.priority),
      sourceMessageId: source.messageId,
      sourceHeaderMessageId: source.headerMessageId,
      sourceSubject: source.subject,
      sourceAuthor: source.author,
      sourceDate: source.date
    });
  }

  return normalized.slice(0, MAX_TODOS);
}

function normalizeTodoMergePart(value) {
  return normalizeText(value).toLowerCase().replace(/\s+/g, " ");
}

function getTodoMergeKey(item) {
  const headerMessageId = normalizeTodoMergePart(item?.sourceHeaderMessageId);
  const messageId = Number(item?.sourceMessageId || 0);
  const sourceIdentity = headerMessageId || (messageId ? `mid:${messageId}` : normalizeTodoMergePart(item?.sourceKey));
  const title = normalizeTodoMergePart(item?.title);
  const description = normalizeTodoMergePart(item?.description);
  return `${sourceIdentity}::${title}::${description}`;
}

function toTimestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortTodoItemsByStatus(items) {
  const pending = [];
  const completed = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (item?.done) {
      completed.push(item);
    } else {
      pending.push(item);
    }
  }

  completed.sort((a, b) => toTimestamp(b?.doneAt) - toTimestamp(a?.doneAt));
  return [...pending, ...completed];
}

function createArchivedTodoItem(item, archivedAtIso) {
  const doneAt = normalizeText(item?.doneAt) || archivedAtIso;
  return {
    ...item,
    done: true,
    doneAt,
    archivedAt: archivedAtIso
  };
}

function mergeArchiveItems(existingArchive, incomingArchive) {
  const merged = [];
  const seen = new Set();

  for (const item of [...(incomingArchive || []), ...(existingArchive || [])]) {
    const key = getTodoMergeKey(item) || normalizeText(item?.id);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
    if (merged.length >= MAX_ARCHIVED_TODOS) {
      break;
    }
  }

  return merged;
}

function normalizeTodoCollections(items, archiveItems, nowMs = Date.now()) {
  const archive = Array.isArray(archiveItems) ? archiveItems : [];
  const ordered = sortTodoItemsByStatus(items);
  const visible = [];
  const movedToArchive = [];
  const archivedAtIso = new Date(nowMs).toISOString();

  for (const item of ordered) {
    if (!item?.done) {
      visible.push(item);
      continue;
    }

    const doneAtMs = toTimestamp(item?.doneAt);
    if (!doneAtMs || nowMs - doneAtMs < DONE_TO_ARCHIVE_MS) {
      visible.push(item);
      continue;
    }

    movedToArchive.push(createArchivedTodoItem(item, archivedAtIso));
  }

  return {
    items: visible.slice(0, MAX_STORED_TODOS),
    archiveItems: mergeArchiveItems(archive, movedToArchive),
    movedToArchiveCount: movedToArchive.length
  };
}

function areTodoListsEquivalent(left, right) {
  const leftList = Array.isArray(left) ? left : [];
  const rightList = Array.isArray(right) ? right : [];
  if (leftList.length !== rightList.length) {
    return false;
  }

  for (let index = 0; index < leftList.length; index += 1) {
    const leftItem = leftList[index] || {};
    const rightItem = rightList[index] || {};
    if (normalizeText(leftItem.id) !== normalizeText(rightItem.id)) {
      return false;
    }
    if (Boolean(leftItem.done) !== Boolean(rightItem.done)) {
      return false;
    }
    if (normalizeText(leftItem.doneAt) !== normalizeText(rightItem.doneAt)) {
      return false;
    }
  }

  return true;
}

function areArchiveListsEquivalent(left, right) {
  const leftList = Array.isArray(left) ? left : [];
  const rightList = Array.isArray(right) ? right : [];
  if (leftList.length !== rightList.length) {
    return false;
  }

  for (let index = 0; index < leftList.length; index += 1) {
    const leftItem = leftList[index] || {};
    const rightItem = rightList[index] || {};
    if (normalizeText(leftItem.id) !== normalizeText(rightItem.id)) {
      return false;
    }
    if (normalizeText(leftItem.doneAt) !== normalizeText(rightItem.doneAt)) {
      return false;
    }
    if (normalizeText(leftItem.archivedAt) !== normalizeText(rightItem.archivedAt)) {
      return false;
    }
  }

  return true;
}

function mergeTodoItems(existingItems, newItems, archiveItems = []) {
  const existing = Array.isArray(existingItems) ? existingItems : [];
  const incoming = Array.isArray(newItems) ? newItems : [];
  const archive = Array.isArray(archiveItems) ? archiveItems : [];
  const merged = [];
  const seen = new Set();
  const existingByKey = new Map();
  const archivedKeys = new Set();
  let addedCount = 0;

  for (const item of archive) {
    const key = getTodoMergeKey(item);
    if (key) {
      archivedKeys.add(key);
    }
  }

  for (const item of existing) {
    const key = getTodoMergeKey(item);
    if (!key || existingByKey.has(key)) {
      continue;
    }
    existingByKey.set(key, item);
  }

  for (const item of incoming) {
    const key = getTodoMergeKey(item);
    if (!key || seen.has(key)) {
      continue;
    }
    if (archivedKeys.has(key)) {
      continue;
    }
    seen.add(key);
    const existingItem = existingByKey.get(key);
    if (existingItem?.done) {
      merged.push({
        ...item,
        done: true,
        doneAt: existingItem.doneAt || ""
      });
    } else {
      merged.push(item);
    }
    if (!existingItem) {
      addedCount += 1;
    }
  }

  for (const item of existing) {
    const key = getTodoMergeKey(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }

  return {
    items: merged.slice(0, MAX_STORED_TODOS),
    addedCount
  };
}

async function openTodoSourceMessage({ messageId, headerMessageId }) {
  const safeMessageId = Number(messageId || 0);
  const safeHeaderMessageId = normalizeText(headerMessageId);

  const getPreferredMailTabId = async () => {
    if (!messenger.mailTabs || typeof messenger.mailTabs.query !== "function") {
      return 0;
    }

    try {
      const activeTabs = await messenger.mailTabs.query({
        active: true,
        currentWindow: true
      });
      const activeTab = Array.isArray(activeTabs)
        ? activeTabs.find((tab) => Number(tab?.id || 0))
        : null;
      if (activeTab?.id) {
        return Number(activeTab.id);
      }
    } catch (_error) {
      // Fallback below.
    }

    try {
      const allTabs = await messenger.mailTabs.query({});
      const firstTab = Array.isArray(allTabs)
        ? allTabs.find((tab) => Number(tab?.id || 0))
        : null;
      return Number(firstTab?.id || 0);
    } catch (_error) {
      return 0;
    }
  };

  const openInMailTab = async (targetMessageId) => {
    if (
      !messenger.mailTabs ||
      typeof messenger.mailTabs.setSelectedMessages !== "function"
    ) {
      return false;
    }

    const mailTabId = await getPreferredMailTabId();
    if (!mailTabId) {
      return false;
    }

    await messenger.mailTabs.setSelectedMessages(mailTabId, [Number(targetMessageId)]);
    if (messenger.tabs?.update) {
      await messenger.tabs.update(mailTabId, { active: true }).catch(() => {});
    }
    return true;
  };

  if (safeMessageId) {
    try {
      const openedInMailTab = await openInMailTab(safeMessageId);
      if (openedInMailTab) {
        return;
      }
    } catch (_error) {
      // Fallback below.
    }

    try {
      await messenger.messageDisplay.open({
        location: "tab",
        messageId: safeMessageId
      });
      return;
    } catch (_error) {
      // Fallback below.
    }
  }

  if (safeHeaderMessageId) {
    try {
      const headers = await queryMessagesLimited(
        {
          headerMessageId: safeHeaderMessageId
        },
        1
      );
      const resolvedMessageId = Number(headers?.[0]?.id || 0);
      if (resolvedMessageId) {
        const openedInMailTab = await openInMailTab(resolvedMessageId);
        if (openedInMailTab) {
          return;
        }
      }
    } catch (_error) {
      // Keep fallback below.
    }

    await messenger.messageDisplay.open({
      location: "tab",
      headerMessageId: safeHeaderMessageId
    });
    return;
  }

  throw new Error("Cannot open source email: missing message reference.");
}

async function setTodoDoneState({ todoId, done }) {
  const safeTodoId = normalizeText(todoId);
  if (!safeTodoId) {
    throw new Error("Missing TODO id.");
  }

  const state = await loadTodoState();
  const doneValue = Boolean(done);
  const nowIso = new Date().toISOString();
  let changed = false;

  const nextItems = state.items.map((item) => {
    if (normalizeText(item?.id) !== safeTodoId) {
      return item;
    }

    changed = true;
    return {
      ...item,
      done: doneValue,
      doneAt: doneValue ? nowIso : ""
    };
  });

  if (!changed) {
    throw new Error("TODO not found.");
  }

  const normalized = normalizeTodoCollections(nextItems, state.archiveItems);
  const nextMeta = {
    ...state.meta,
    lastManualUpdateAt: nowIso,
    lastArchivedAt: normalized.movedToArchiveCount ? nowIso : (state.meta?.lastArchivedAt || ""),
    todoCount: normalized.items.length,
    archiveCount: normalized.archiveItems.length
  };
  await saveTodoState(normalized.items, nextMeta, normalized.archiveItems);

  const nextState = {
    items: normalized.items,
    archiveItems: normalized.archiveItems,
    meta: nextMeta
  };
  if (hasTodoPanelExperimentApi()) {
    await syncEmbeddedTodoPanelData(nextState).catch((error) => {
      console.error("[thunderTODOcodex] embedded panel data sync failed:", error);
    });
  }

  return nextState;
}

async function beginReplyForTodo({ todoId, messageId }) {
  const safeTodoId = normalizeText(todoId);
  const safeMessageId = Number(messageId || 0);
  if (!safeMessageId) {
    throw new Error("Cannot reply: missing source message id.");
  }
  if (!messenger.compose || typeof messenger.compose.beginReply !== "function") {
    throw new Error("Compose API is unavailable.");
  }

  let composeTab = null;
  try {
    composeTab = await messenger.compose.beginReply(safeMessageId, DEFAULT_REPLY_TYPE);
  } catch (_error) {
    composeTab = await messenger.compose.beginReply(safeMessageId);
  }

  const composeTabId = Number(composeTab?.id || 0);
  if (composeTabId && safeTodoId) {
    replyTabTodoMap.set(composeTabId, safeTodoId);
  }

  return {
    ok: true,
    composeTabId: composeTabId || null
  };
}

async function refreshTodos({ reason = "manual", force = false } = {}) {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const state = await loadTodoState();
    const normalizedState = normalizeTodoCollections(state.items, state.archiveItems);
    const normalizedNowIso = new Date().toISOString();
    const inferredProcessedKeys = collectProcessedMessageKeysFromTodos(
      normalizedState.items,
      normalizedState.archiveItems
    );
    const processedMessageKeys = mergeProcessedMessageKeys(
      state.meta?.processedMessageKeys,
      inferredProcessedKeys
    );
    const stateMeta = {
      ...state.meta,
      processedMessageKeys,
      todoCount: normalizedState.items.length,
      archiveCount: normalizedState.archiveItems.length,
      lastArchivedAt: normalizedState.movedToArchiveCount
        ? normalizedNowIso
        : (state.meta?.lastArchivedAt || "")
    };
    const normalizedChanged =
      !areTodoListsEquivalent(state.items, normalizedState.items) ||
      !areArchiveListsEquivalent(state.archiveItems, normalizedState.archiveItems) ||
      normalizeProcessedMessageKeys(state.meta?.processedMessageKeys).join("|") !==
        processedMessageKeys.join("|") ||
      toSafeInteger(state.meta?.archiveCount, -1) !== normalizedState.archiveItems.length;

    if (normalizedChanged) {
      await saveTodoState(normalizedState.items, stateMeta, normalizedState.archiveItems);
    }

    const currentState = {
      items: normalizedState.items,
      archiveItems: normalizedState.archiveItems,
      meta: stateMeta
    };

    const now = Date.now();
    const lastGeneratedAt = currentState.meta?.lastGeneratedAt
      ? new Date(currentState.meta.lastGeneratedAt).getTime()
      : 0;

    if (!force && lastGeneratedAt && now - lastGeneratedAt < STALE_AFTER_MS && reason === "startup") {
      return currentState;
    }

    const settings = await loadSettings();
    const backendStatus = await getBackendStatusByBaseUrl(settings.backendBaseUrl);
    const headers = await collectCandidateHeaders(
      currentState.meta?.lastGeneratedAt,
      currentState.meta?.processedMessageKeys
    );
    const summaries = await buildMessageSummaries(headers);

    let generatedItems = [];
    let backendError = "";

    if (summaries.length) {
      const payload = {
        model: settings.model,
        language: settings.language,
        messages: summaries
      };

      const response = await callTodoBackend({
        backendBaseUrl: settings.backendBaseUrl,
        payload
      });

      const sourceByKey = new Map(summaries.map((message) => [message.sourceKey, message]));
      generatedItems = normalizeTodos(response.todos, sourceByKey);
    }

    const merged = mergeTodoItems(currentState.items, generatedItems, currentState.archiveItems);
    const normalizedMerged = normalizeTodoCollections(merged.items, currentState.archiveItems);
    const todoItems = normalizedMerged.items;
    const archiveItems = normalizedMerged.archiveItems;
    const nowIso = new Date().toISOString();
    const processedFromThisRun = summaries
      .map((summary) => getMessageTrackingKeyFromSummary(summary))
      .filter(Boolean);
    const nextProcessedMessageKeys = mergeProcessedMessageKeys(
      currentState.meta?.processedMessageKeys,
      processedFromThisRun
    );

    const meta = {
      ...currentState.meta,
      lastGeneratedAt: nowIso,
      lastAttemptAt: nowIso,
      lastReason: reason,
      sourceMessageCount: summaries.length,
      todoCount: todoItems.length,
      archiveCount: archiveItems.length,
      addedTodoCount: merged.addedCount,
      backendOnline: backendStatus.online,
      backendCodexAuth: backendStatus.codexAuth,
      backendStatusCheckedAt: backendStatus.checkedAt,
      processedMessageKeys: nextProcessedMessageKeys,
      lastArchivedAt: normalizedMerged.movedToArchiveCount
        ? nowIso
        : (currentState.meta?.lastArchivedAt || ""),
      nextRefreshAt: new Date(Date.now() + HOURLY_REFRESH_MINUTES * 60 * 1000).toISOString(),
      lastError: backendError
    };

    await saveTodoState(todoItems, meta, archiveItems);
    const nextState = {
      items: todoItems,
      archiveItems,
      meta
    };
    if (hasTodoPanelExperimentApi()) {
      await syncEmbeddedTodoPanelData(nextState).catch((error) => {
        console.error("[thunderTODOcodex] embedded panel data sync failed:", error);
      });
    }
    return nextState;
  })().catch(async (error) => {
    const current = await loadTodoState();
    const backendStatus = await getLiveBackendStatus().catch(() => ({
      online: false,
      codexAuth: false,
      checkedAt: new Date().toISOString()
    }));
    const meta = {
      ...current.meta,
      lastAttemptAt: new Date().toISOString(),
      lastReason: reason,
      backendOnline: backendStatus.online,
      backendCodexAuth: backendStatus.codexAuth,
      backendStatusCheckedAt: backendStatus.checkedAt,
      lastError: error?.message || "TODO refresh failed."
    };
    await saveTodoState(current.items, meta, current.archiveItems);
    throw error;
  }).finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

async function getViewState() {
  const state = await loadTodoState();
  const normalized = normalizeTodoCollections(state.items, state.archiveItems);
  const nowIso = new Date().toISOString();
  const inferredProcessedKeys = collectProcessedMessageKeysFromTodos(
    normalized.items,
    normalized.archiveItems
  );
  const processedMessageKeys = mergeProcessedMessageKeys(
    state.meta?.processedMessageKeys,
    inferredProcessedKeys
  );
  const nextMeta = {
    ...state.meta,
    processedMessageKeys,
    todoCount: normalized.items.length,
    archiveCount: normalized.archiveItems.length,
    lastArchivedAt: normalized.movedToArchiveCount
      ? nowIso
      : (state.meta?.lastArchivedAt || "")
  };

  const changed =
    !areTodoListsEquivalent(state.items, normalized.items) ||
    !areArchiveListsEquivalent(state.archiveItems, normalized.archiveItems) ||
    normalizeProcessedMessageKeys(state.meta?.processedMessageKeys).join("|") !==
      processedMessageKeys.join("|") ||
    toSafeInteger(state.meta?.archiveCount, -1) !== normalized.archiveItems.length;

  if (changed) {
    await saveTodoState(normalized.items, nextMeta, normalized.archiveItems);
  }

  const enrichedState = await hydrateStateWithBackendStatus({
    items: normalized.items,
    archiveItems: normalized.archiveItems,
    meta: nextMeta
  });

  return {
    items: enrichedState.items,
    archiveItems: enrichedState.archiveItems,
    meta: enrichedState.meta,
    isRefreshing: Boolean(refreshPromise)
  };
}

async function openTodoPanelAfterDelay(delayMs = 1200) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await ensureTodoPanelWindow();
}

function safeEnsureTodoPanelWindow(contextLabel, options = {}) {
  ensureTodoPanelWindow(options).catch((error) => {
    console.error(`[thunderTODOcodex] panel open failed (${contextLabel}):`, error);
  });
}

function safeOpenTodoPanelAfterDelay(contextLabel) {
  openTodoPanelAfterDelay().catch((error) => {
    console.error(`[thunderTODOcodex] delayed panel open failed (${contextLabel}):`, error);
  });
}

function safeReopenTodoPanel(contextLabel, delayMs = TODO_PANEL_REOPEN_DELAY_MS) {
  openTodoPanelAfterDelay(delayMs).catch((error) => {
    console.error(`[thunderTODOcodex] panel reopen failed (${contextLabel}):`, error);
  });
}

async function handleEmbeddedPanelAction(action) {
  if (!action || typeof action !== "object") {
    return;
  }

  const actionType = normalizeText(action.type).toLowerCase();
  if (actionType === "reply") {
    await beginReplyForTodo({
      todoId: action.todoId,
      messageId: action.sourceMessageId
    });
    return;
  }

  if (actionType === "opensource") {
    await openTodoSourceMessage({
      messageId: action.sourceMessageId,
      headerMessageId: action.sourceHeaderMessageId
    });
    return;
  }

  if (actionType === "toggledone") {
    await setTodoDoneState({
      todoId: action.todoId,
      done: action.done
    });
    return;
  }

  if (actionType === "startbackendservice") {
    await startBackendService();
    const nextState = await getViewState();
    if (hasTodoPanelExperimentApi()) {
      await syncEmbeddedTodoPanelData(nextState).catch((error) => {
        console.error("[thunderTODOcodex] embedded panel data sync failed:", error);
      });
    }
  }
}

function ensureEmbeddedPanelActionListener() {
  if (experimentPanelActionListenerAdded) {
    return;
  }
  if (!hasTodoPanelExperimentApi()) {
    return;
  }
  if (typeof messenger.todoPanelExperiment.onPanelAction?.addListener !== "function") {
    return;
  }

  messenger.todoPanelExperiment.onPanelAction.addListener((action) => {
    handleEmbeddedPanelAction(action).catch((error) => {
      console.error("[thunderTODOcodex] embedded panel action failed:", error);
    });
  });
  experimentPanelActionListenerAdded = true;
}

async function initializeAddon() {
  await ensureRefreshAlarm();
  ensureEmbeddedPanelActionListener();
  await importTodoStateFromBackendIfLocalEmpty().catch((error) => {
    console.warn("[thunderTODOcodex] backend TODO import skipped:", error?.message || error);
  });
  const panelPolicy = await applyTodoPanelPolicy({ focus: false });
  if (panelPolicy.keepPanelOpen && panelPolicy.mode === "fallback-visible") {
    safeOpenTodoPanelAfterDelay("startup");
  }
  await refreshTodos({ reason: "startup", force: false }).catch((error) => {
    console.error("[thunderTODOcodex] startup refresh failed:", error);
  });
}

messenger.runtime.onInstalled.addListener(() => {
  initializeAddon().catch((error) => {
    console.error("[thunderTODOcodex] init onInstalled failed:", error);
  });
});

messenger.runtime.onStartup.addListener(() => {
  initializeAddon().catch((error) => {
    console.error("[thunderTODOcodex] init onStartup failed:", error);
  });
});

messenger.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== REFRESH_ALARM) {
    return;
  }

  refreshTodos({ reason: "hourly", force: true }).catch((error) => {
    console.error("[thunderTODOcodex] hourly refresh failed:", error);
  });
});

if (messenger.windows?.onCreated?.addListener) {
  messenger.windows.onCreated.addListener(async (windowInfo) => {
    if (hasTodoPanelExperimentApi()) {
      return;
    }
    if (windowInfo?.type === "normal") {
      const keepPanelOpen = await shouldKeepPanelOpen().catch(() => true);
      if (keepPanelOpen) {
        safeEnsureTodoPanelWindow("onWindowCreated");
      }
    }
  });
}

if (messenger.windows?.onRemoved?.addListener) {
  messenger.windows.onRemoved.addListener(async (windowId) => {
    if (hasTodoPanelExperimentApi()) {
      return;
    }
    if (windowId === panelWindowId) {
      panelWindowId = null;
      const keepPanelOpen = await shouldKeepPanelOpen().catch(() => true);
      if (keepPanelOpen) {
        safeReopenTodoPanel("onWindowRemoved");
      }
    }
  });
}

if (messenger.tabs?.onRemoved?.addListener) {
  messenger.tabs.onRemoved.addListener(async (tabId) => {
    if (replyTabTodoMap.has(tabId)) {
      replyTabTodoMap.delete(tabId);
    }

    if (hasTodoPanelExperimentApi()) {
      return;
    }
    if (tabId === panelTabId) {
      panelTabId = null;
      const keepPanelOpen = await shouldKeepPanelOpen().catch(() => true);
      if (keepPanelOpen) {
        safeReopenTodoPanel("onTabRemoved");
      }
    }
  });
}

if (messenger.compose?.onAfterSend?.addListener) {
  messenger.compose.onAfterSend.addListener((tab, _details) => {
    const tabId = Number(tab?.id || 0);
    if (!tabId) {
      return;
    }

    const todoId = replyTabTodoMap.get(tabId);
    if (!todoId) {
      return;
    }

    replyTabTodoMap.delete(tabId);
    setTodoDoneState({
      todoId,
      done: true
    }).catch((error) => {
      console.error("[thunderTODOcodex] auto-complete after reply failed:", error);
    });
  });
}

messenger.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.type === "GET_TODO_STATE") {
    return getViewState();
  }

  if (message.type === "GET_BACKEND_STATUS") {
    return getLiveBackendStatus();
  }

  if (message.type === "START_BACKEND_SERVICE") {
    return startBackendService();
  }

  if (message.type === "REFRESH_TODOS") {
    return refreshTodos({
      reason: normalizeText(message.reason) || "manual",
      force: true
    }).then(() => getViewState());
  }

  if (message.type === "OPEN_TODO_SOURCE") {
    return openTodoSourceMessage({
      messageId: message.messageId,
      headerMessageId: message.headerMessageId
    }).then(() => ({ ok: true }));
  }

  if (message.type === "OPEN_TODO_REPLY") {
    return beginReplyForTodo({
      todoId: message.todoId,
      messageId: message.messageId
    });
  }

  if (message.type === "SET_TODO_DONE") {
    return setTodoDoneState({
      todoId: message.todoId,
      done: message.done
    }).then(() => getViewState());
  }

  if (message.type === "OPEN_TODO_PANEL") {
    return ensureTodoPanelWindow({ focus: true }).then(() => ({ ok: true }));
  }

  if (message.type === "APPLY_TODO_PANEL_POLICY") {
    return applyTodoPanelPolicy({ focus: false }).then((result) => ({
      ok: true,
      ...result
    }));
  }

  return undefined;
});

initializeAddon().catch((error) => {
  console.error("[thunderTODOcodex] init failed:", error);
});
