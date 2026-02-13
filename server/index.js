const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (isQuoted) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, ".env"));

const HOST = String(process.env.HOST || "127.0.0.1").trim();
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || `http://${HOST}:${PORT}`).replace(
  /\/+$/,
  ""
);
const CODEX_BIN = String(process.env.CODEX_BIN || "codex").trim();
const CODEX_WORKDIR = String(process.env.CODEX_WORKDIR || os.homedir()).trim();
const LOGIN_START_TIMEOUT_MS = 15_000;
const LOGIN_POLL_TTL_MS = 15 * 60 * 1000;
const GENERATE_TIMEOUT_MS = 120_000;
const MAX_TODO_INPUT_MESSAGES = 60;
const MAX_TODO_OUTPUT_ITEMS = 25;
const MAX_STATE_TODOS = 2_000;
const TODO_STATE_DIR = path.join(__dirname, "data");
const TODO_STATE_JSON_PATH = path.join(TODO_STATE_DIR, "todo-state.json");
const TODO_STATE_MD_PATH = path.join(TODO_STATE_DIR, "todo-state.md");

const loginSessions = new Map();
const codexSchemaPath = path.join(os.tmpdir(), "thunderai-codex-email-schema.json");
const codexTodoSchemaPath = path.join(os.tmpdir(), "thunderai-codex-todo-schema.json");

function normalizeText(value) {
  return String(value || "").replaceAll("\r\n", "\n").trim();
}

function normalizeQuickStatus(value) {
  const status = normalizeText(value).toLowerCase().replaceAll("-", "_");
  if (status === "done" || status === "not_done") {
    return status;
  }
  return "";
}

function inferQuickStatusFromPrompt(prompt) {
  const text = normalizeText(prompt).toLowerCase();
  if (!text) {
    return "";
  }
  if (text.includes("nie wykonano") || text.includes("not done")) {
    return "not_done";
  }
  if (text.includes("wykonano") || text.includes("completed")) {
    return "done";
  }
  return "";
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

function parseDeviceAuthFields(outputText) {
  const text = stripAnsi(outputText);
  const urlMatch = text.match(/https:\/\/auth\.openai\.com\/codex\/device[^\s]*/i);
  const codeMatch = text.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/);
  return {
    verificationUrl: urlMatch ? urlMatch[0] : "",
    userCode: codeMatch ? codeMatch[0] : ""
  };
}

function cleanExpiredLoginSessions() {
  const now = Date.now();
  for (const [sessionId, session] of loginSessions.entries()) {
    if (session.expiresAt <= now) {
      if (session.child && !session.child.killed) {
        session.child.kill("SIGTERM");
      }
      session.status = "expired";
      loginSessions.delete(sessionId);
    }
  }
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function readRequestBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error("Request body too large."));
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readRequestBody(req);
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    throw new Error("Invalid JSON body.");
  }
}

function runCommand(command, args, options = {}) {
  const {
    cwd = CODEX_WORKDIR,
    timeoutMs = 30_000,
    stdin = "",
    env = process.env
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timeout = setTimeout(() => {
      if (!finished) {
        child.kill("SIGTERM");
        reject(new Error(`Command timeout: ${command} ${args.join(" ")}`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      if (!finished) {
        finished = true;
        reject(error);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (!finished) {
        finished = true;
        resolve({
          code: Number(code || 0),
          stdout: stripAnsi(stdout),
          stderr: stripAnsi(stderr)
        });
      }
    });

    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

async function getCodexLoginStatus() {
  const result = await runCommand(CODEX_BIN, ["login", "status"], {
    timeoutMs: 20_000
  });

  const text = `${result.stdout}\n${result.stderr}`.trim();
  const loggedIn = result.code === 0 && /logged in/i.test(text);
  const providerMatch = text.match(/using\s+([^\n]+)/i);
  const provider = providerMatch ? normalizeText(providerMatch[1]) : "";
  return {
    logged_in: loggedIn,
    provider: provider || "",
    details: text
  };
}

function ensureSchemaFile() {
  if (fs.existsSync(codexSchemaPath)) {
    return codexSchemaPath;
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["subject", "body_plain"],
    properties: {
      subject: { type: "string" },
      body_plain: { type: "string" }
    }
  };

  fs.writeFileSync(codexSchemaPath, JSON.stringify(schema, null, 2), "utf8");
  return codexSchemaPath;
}

function ensureTodoSchemaFile() {
  if (fs.existsSync(codexTodoSchemaPath)) {
    return codexTodoSchemaPath;
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["todos"],
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sourceKey", "title", "description", "priority"],
          properties: {
            sourceKey: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            priority: { type: "string" }
          }
        }
      }
    }
  };

  fs.writeFileSync(codexTodoSchemaPath, JSON.stringify(schema, null, 2), "utf8");
  return codexTodoSchemaPath;
}

function parseCodexJsonResponse(text, fallbackSubject) {
  const raw = normalizeText(text);
  if (!raw) {
    return { subject: fallbackSubject || "Nowa wiadomosc", body_plain: "" };
  }

  const stripped =
    raw.startsWith("```") && raw.endsWith("```")
      ? raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "")
      : raw;

  try {
    const parsed = JSON.parse(stripped);
    const subject = normalizeText(parsed.subject) || fallbackSubject || "Nowa wiadomosc";
    const bodyPlain = normalizeText(parsed.body_plain || parsed.body);
    return {
      subject,
      body_plain: bodyPlain
    };
  } catch (_error) {
    return {
      subject: fallbackSubject || "Nowa wiadomosc",
      body_plain: stripped
    };
  }
}

function parseCodexTodoResponse(text) {
  const raw = normalizeText(text);
  if (!raw) {
    return { todos: [] };
  }

  const stripped =
    raw.startsWith("```") && raw.endsWith("```")
      ? raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "")
      : raw;

  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) {
      return { todos: parsed };
    }
    if (Array.isArray(parsed?.todos)) {
      return { todos: parsed.todos };
    }
    return { todos: [] };
  } catch (_error) {
    return { todos: [] };
  }
}

function normalizeTodoPriority(value) {
  const priority = normalizeText(value).toLowerCase();
  if (priority === "high" || priority === "medium" || priority === "low") {
    return priority;
  }
  if (priority === "pilny") {
    return "high";
  }
  if (priority === "niski") {
    return "low";
  }
  return "medium";
}

function normalizeTodoItems(rawTodos, allowedSourceKeys) {
  if (!Array.isArray(rawTodos)) {
    return [];
  }

  const normalized = [];
  const dedupe = new Set();

  for (const raw of rawTodos) {
    const sourceKey = normalizeText(raw?.sourceKey || raw?.source_key);
    if (!sourceKey || !allowedSourceKeys.has(sourceKey)) {
      continue;
    }

    const title = normalizeText(raw?.title || raw?.task || raw?.todo).slice(0, 160);
    const description = normalizeText(raw?.description || raw?.details).slice(0, 800);
    if (!title) {
      continue;
    }

    const dedupeKey = `${sourceKey}::${title.toLowerCase()}`;
    if (dedupe.has(dedupeKey)) {
      continue;
    }
    dedupe.add(dedupeKey);

    normalized.push({
      sourceKey,
      title,
      description,
      priority: normalizeTodoPriority(raw?.priority)
    });
  }

  return normalized.slice(0, MAX_TODO_OUTPUT_ITEMS);
}

function ensureTodoStateDir() {
  if (!fs.existsSync(TODO_STATE_DIR)) {
    fs.mkdirSync(TODO_STATE_DIR, { recursive: true });
  }
}

function toIsoDate(value) {
  const parsed = new Date(value || "");
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString();
}

function sanitizeStoredTodoItem(raw) {
  return {
    id: normalizeText(raw?.id).slice(0, 120),
    title: normalizeText(raw?.title).slice(0, 240),
    description: normalizeText(raw?.description).slice(0, 1200),
    priority: normalizeTodoPriority(raw?.priority),
    done: Boolean(raw?.done),
    doneAt: toIsoDate(raw?.doneAt),
    archivedAt: toIsoDate(raw?.archivedAt),
    sourceKey: normalizeText(raw?.sourceKey).slice(0, 60),
    sourceMessageId: Number(raw?.sourceMessageId || 0) || 0,
    sourceHeaderMessageId: normalizeText(raw?.sourceHeaderMessageId).slice(0, 300),
    sourceSubject: normalizeText(raw?.sourceSubject).slice(0, 300),
    sourceAuthor: normalizeText(raw?.sourceAuthor).slice(0, 200),
    sourceDate: toIsoDate(raw?.sourceDate)
  };
}

function sanitizeStoredMeta(raw) {
  const meta = raw && typeof raw === "object" ? raw : {};
  const processedMessageKeysRaw = Array.isArray(meta.processedMessageKeys)
    ? meta.processedMessageKeys
    : [];
  const processedMessageKeys = [];
  const seen = new Set();
  for (const value of processedMessageKeysRaw) {
    const key = normalizeText(value).toLowerCase().slice(0, 420);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    processedMessageKeys.push(key);
    if (processedMessageKeys.length >= 6000) {
      break;
    }
  }

  return {
    lastGeneratedAt: toIsoDate(meta.lastGeneratedAt),
    lastAttemptAt: toIsoDate(meta.lastAttemptAt),
    lastReason: normalizeText(meta.lastReason).slice(0, 80),
    sourceMessageCount: Number(meta.sourceMessageCount || 0) || 0,
    todoCount: Number(meta.todoCount || 0) || 0,
    archiveCount: Number(meta.archiveCount || 0) || 0,
    addedTodoCount: Number(meta.addedTodoCount || 0) || 0,
    nextRefreshAt: toIsoDate(meta.nextRefreshAt),
    lastError: normalizeText(meta.lastError).slice(0, 800),
    lastManualUpdateAt: toIsoDate(meta.lastManualUpdateAt),
    lastArchivedAt: toIsoDate(meta.lastArchivedAt),
    processedMessageKeys
  };
}

function sanitizeTodoStatePayload(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const items = Array.isArray(body.items) ? body.items : [];
  const archiveItems = Array.isArray(body.archiveItems) ? body.archiveItems : [];
  const savedAt = toIsoDate(body.savedAt) || new Date().toISOString();
  const normalizedItems = items.slice(0, MAX_STATE_TODOS).map(sanitizeStoredTodoItem);
  const normalizedArchiveItems = archiveItems
    .slice(0, MAX_STATE_TODOS)
    .map((item) => ({ ...sanitizeStoredTodoItem(item), archivedAt: toIsoDate(item?.archivedAt) }));
  const meta = sanitizeStoredMeta({
    ...body.meta,
    todoCount: normalizedItems.length,
    archiveCount: normalizedArchiveItems.length
  });

  return {
    version: 1,
    savedAt,
    meta,
    items: normalizedItems,
    archiveItems: normalizedArchiveItems
  };
}

function formatTodoStateMarkdown(state) {
  const lines = [];
  lines.push("# thunderTODO state");
  lines.push("");
  lines.push(`Saved at: ${state.savedAt || ""}`);
  lines.push(`Last generated: ${state.meta?.lastGeneratedAt || ""}`);
  lines.push(`Visible TODO count: ${state.items.length}`);
  lines.push(`Archive count: ${state.archiveItems.length}`);
  lines.push("");
  lines.push("## Active TODO");
  lines.push("");

  if (!state.items.length) {
    lines.push("- (empty)");
  } else {
    for (const item of state.items) {
      const marker = item.done ? "x" : " ";
      lines.push(`- [${marker}] ${item.title}`);
      if (item.description) {
        lines.push(`  - Description: ${item.description}`);
      }
      lines.push(`  - Priority: ${item.priority}`);
      if (item.doneAt) {
        lines.push(`  - Done at: ${item.doneAt}`);
      }
      if (item.sourceSubject || item.sourceAuthor || item.sourceDate) {
        lines.push(
          `  - Source: ${item.sourceSubject || "(brak tematu)"} | ${item.sourceAuthor || ""} | ${item.sourceDate || ""}`
        );
      }
      lines.push("");
    }
  }

  lines.push("");
  lines.push("## Archive");
  lines.push("");

  if (!state.archiveItems.length) {
    lines.push("- (empty)");
  } else {
    for (const item of state.archiveItems) {
      lines.push(`- [x] ${item.title}`);
      if (item.doneAt) {
        lines.push(`  - Done at: ${item.doneAt}`);
      }
      if (item.archivedAt) {
        lines.push(`  - Archived at: ${item.archivedAt}`);
      }
      if (item.sourceSubject || item.sourceAuthor || item.sourceDate) {
        lines.push(
          `  - Source: ${item.sourceSubject || "(brak tematu)"} | ${item.sourceAuthor || ""} | ${item.sourceDate || ""}`
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function saveTodoStateFiles(payload) {
  const state = sanitizeTodoStatePayload(payload);
  ensureTodoStateDir();
  fs.writeFileSync(TODO_STATE_JSON_PATH, JSON.stringify(state, null, 2), "utf8");
  fs.writeFileSync(TODO_STATE_MD_PATH, formatTodoStateMarkdown(state), "utf8");
  return state;
}

function readTodoStateFiles() {
  if (!fs.existsSync(TODO_STATE_JSON_PATH)) {
    return {
      version: 1,
      savedAt: "",
      meta: sanitizeStoredMeta({}),
      items: [],
      archiveItems: []
    };
  }

  try {
    const raw = fs.readFileSync(TODO_STATE_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return sanitizeTodoStatePayload(parsed);
  } catch (_error) {
    return {
      version: 1,
      savedAt: "",
      meta: sanitizeStoredMeta({}),
      items: [],
      archiveItems: []
    };
  }
}

function ensureQuickStatusSentence(bodyPlain, quickStatus) {
  const body = normalizeText(bodyPlain);
  if (!body) {
    return body;
  }

  if (quickStatus === "done") {
    const doneRegex = /zadanie\s+zosta(?:ł|l)o\s+wykonane\./i;
    if (!doneRegex.test(body)) {
      return `Zadanie zostalo wykonane.\n\n${body}`;
    }
  }

  if (quickStatus === "not_done") {
    const notDoneRegex = /zadanie\s+nie\s+zosta(?:ł|l)o\s+jeszcze\s+wykonane\./i;
    if (!notDoneRegex.test(body)) {
      return `Zadanie nie zostalo jeszcze wykonane.\n\n${body}`;
    }
  }

  return body;
}

async function runCodexGenerate(payload) {
  const schemaPath = ensureSchemaFile();
  const outputFile = path.join(os.tmpdir(), `thunderai-codex-output-${randomId(8)}.txt`);

  const currentSubject = normalizeText(payload.currentSubject);
  const prompt = normalizeText(payload.prompt);
  const tone = normalizeText(payload.tone) || "professional";
  const language = normalizeText(payload.language) || "Polish";
  const model = normalizeText(payload.model) || "gpt-5.3-codex";
  const quickStatus = normalizeQuickStatus(payload.quickStatus) || inferQuickStatusFromPrompt(prompt);
  const to = normalizeText(payload.to);
  const cc = normalizeText(payload.cc);
  const currentBody = normalizeText(payload.currentBody);

  const quickModeInstructions =
    quickStatus === "done"
      ? [
          "Quick mode selected: DONE.",
          "This is mandatory: clearly state that the task is completed.",
          'Include this exact sentence in Polish: "Zadanie zostalo wykonane."',
          "Do not suggest that work is still in progress.",
          "Keep it concise and action-oriented."
        ]
      : quickStatus === "not_done"
        ? [
            "Quick mode selected: NOT_DONE.",
            "This is mandatory: clearly state that the task is not completed yet.",
            'Include this exact sentence in Polish: "Zadanie nie zostalo jeszcze wykonane."',
            "Include a polite next step or expected update timing."
          ]
        : [];

  const instructions = [
    "Generate an email draft and return ONLY JSON.",
    'JSON keys: "subject", "body_plain".',
    "body_plain must be plain text (no markdown).",
    "Use the email context below to keep the reply coherent with the thread.",
    "",
    `Goal: ${prompt}`,
    `Tone: ${tone}`,
    `Language: ${language}`,
    `Current subject: ${currentSubject || "(empty)"}`,
    `To: ${to || "(empty)"}`,
    `Cc: ${cc || "(empty)"}`,
    "",
    "Current draft/thread context:",
    currentBody || "(empty)",
    "",
    ...quickModeInstructions
  ].join("\n");

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--cd",
    CODEX_WORKDIR,
    "--sandbox",
    "read-only",
    "--output-last-message",
    outputFile,
    "--output-schema",
    schemaPath,
    "--model",
    model,
    "-"
  ];

  const result = await runCommand(CODEX_BIN, args, {
    timeoutMs: GENERATE_TIMEOUT_MS,
    stdin: instructions
  });

  if (result.code !== 0) {
    throw new Error(`codex exec failed: ${normalizeText(result.stderr || result.stdout)}`);
  }

  let output = "";
  try {
    output = fs.readFileSync(outputFile, "utf8");
  } finally {
    try {
      fs.unlinkSync(outputFile);
    } catch (_error) {
      // Ignore cleanup failure.
    }
  }

  const parsed = parseCodexJsonResponse(output, currentSubject || "Nowa wiadomosc");
  parsed.body_plain = ensureQuickStatusSentence(parsed.body_plain, quickStatus);

  if (!normalizeText(parsed.body_plain)) {
    throw new Error("Codex returned an empty body.");
  }

  return parsed;
}

async function runCodexGenerateTodos(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (!messages.length) {
    return [];
  }

  const todoSchemaPath = ensureTodoSchemaFile();
  const outputFile = path.join(os.tmpdir(), `thunderai-codex-todos-${randomId(8)}.txt`);

  const model = normalizeText(payload.model) || "gpt-5.3-codex";
  const language = normalizeText(payload.language) || "Polish";
  const sourceMessages = messages
    .slice(0, MAX_TODO_INPUT_MESSAGES)
    .map((message, index) => ({
      sourceKey: normalizeText(message?.sourceKey) || `M${index + 1}`,
      subject: normalizeText(message?.subject) || "(no subject)",
      author: normalizeText(message?.author) || "(unknown sender)",
      date: normalizeText(message?.date) || "",
      snippet: normalizeText(message?.snippet) || "(no snippet)"
    }))
    .filter((message) => message.sourceKey);

  if (!sourceMessages.length) {
    return [];
  }

  const allowedSourceKeys = new Set(sourceMessages.map((message) => message.sourceKey));
  const sourceList = Array.from(allowedSourceKeys).join(", ");

  const messagesBlock = sourceMessages
    .map((message) =>
      [
        `[${message.sourceKey}]`,
        `From: ${message.author}`,
        `Subject: ${message.subject}`,
        `Date: ${message.date || "(unknown)"}`,
        `Snippet: ${message.snippet}`
      ].join("\n")
    )
    .join("\n\n");

  const instructions = [
    "Analyze incoming emails and create an actionable TODO list.",
    "Return ONLY valid JSON.",
    'Use root object with key "todos".',
    'Each todo item must contain: "sourceKey", "title", "description", "priority".',
    "priority must be one of: low, medium, high.",
    `sourceKey must be one of: ${sourceList}.`,
    "Do not invent source keys or tasks unrelated to the provided messages.",
    "Ignore obvious newsletters or automated notifications unless they contain an action request.",
    `Output language: ${language}.`,
    `Maximum items: ${MAX_TODO_OUTPUT_ITEMS}.`,
    "",
    "Email context:",
    messagesBlock
  ].join("\n");

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--cd",
    CODEX_WORKDIR,
    "--sandbox",
    "read-only",
    "--output-last-message",
    outputFile,
    "--output-schema",
    todoSchemaPath,
    "--model",
    model,
    "-"
  ];

  const result = await runCommand(CODEX_BIN, args, {
    timeoutMs: GENERATE_TIMEOUT_MS,
    stdin: instructions
  });

  if (result.code !== 0) {
    throw new Error(`codex exec failed: ${normalizeText(result.stderr || result.stdout)}`);
  }

  let output = "";
  try {
    output = fs.readFileSync(outputFile, "utf8");
  } finally {
    try {
      fs.unlinkSync(outputFile);
    } catch (_error) {
      // Ignore cleanup failure.
    }
  }

  const parsed = parseCodexTodoResponse(output);
  return normalizeTodoItems(parsed.todos, allowedSourceKeys);
}

async function startOpenAiDeviceLogin() {
  const currentStatus = await getCodexLoginStatus();
  if (currentStatus.logged_in) {
    return {
      status: "already_logged_in",
      provider: currentStatus.provider || "ChatGPT"
    };
  }

  const sessionId = randomId(16);
  const session = {
    id: sessionId,
    status: "starting",
    createdAt: Date.now(),
    expiresAt: Date.now() + LOGIN_POLL_TTL_MS,
    verificationUrl: "",
    userCode: "",
    error: "",
    output: "",
    child: null
  };
  loginSessions.set(sessionId, session);

  const child = spawn(CODEX_BIN, ["login", "--device-auth"], {
    cwd: CODEX_WORKDIR,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  session.child = child;

  const onChunk = (chunk) => {
    session.output += stripAnsi(chunk.toString());
    const parsed = parseDeviceAuthFields(session.output);
    if (parsed.verificationUrl) {
      session.verificationUrl = parsed.verificationUrl;
    }
    if (parsed.userCode) {
      session.userCode = parsed.userCode;
    }
    if (session.status === "starting" && session.verificationUrl) {
      session.status = "pending";
    }
  };

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  child.on("close", async () => {
    try {
      const status = await getCodexLoginStatus();
      if (status.logged_in) {
        session.status = "approved";
        session.error = "";
      } else if (session.status !== "expired") {
        session.status = "failed";
        session.error = "OpenAI login was not completed.";
      }
    } catch (error) {
      session.status = "failed";
      session.error = error?.message || "Failed to check login status.";
    } finally {
      session.child = null;
    }
  });

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (session.status === "starting") {
        session.status = "failed";
        session.error = "Could not initialize OpenAI device login.";
        if (session.child && !session.child.killed) {
          session.child.kill("SIGTERM");
        }
      }
      reject(new Error(session.error || "Login start timeout."));
    }, LOGIN_START_TIMEOUT_MS);

    const waitForReady = () => {
      if (session.status === "pending" && session.verificationUrl) {
        clearTimeout(timeout);
        resolve({
          status: "pending",
          session_id: session.id,
          verification_url: session.verificationUrl,
          user_code: session.userCode,
          expires_in: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000))
        });
        return;
      }

      if (session.status === "failed") {
        clearTimeout(timeout);
        reject(new Error(session.error || "Failed to start login."));
        return;
      }

      setTimeout(waitForReady, 100);
    };

    waitForReady();
  });
}

async function handleRoute(req, res) {
  cleanExpiredLoginSessions();

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "GET" && pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/auth/openai/status") {
    try {
      const status = await getCodexLoginStatus();
      sendJson(res, 200, status);
    } catch (error) {
      sendJson(res, 500, { error: error?.message || "Failed to read login status." });
    }
    return;
  }

  if (method === "POST" && pathname === "/auth/openai/start") {
    await parseJsonBody(req);
    try {
      const started = await startOpenAiDeviceLogin();
      sendJson(res, 200, started);
    } catch (error) {
      sendJson(res, 500, { error: error?.message || "Failed to start OpenAI login." });
    }
    return;
  }

  if (method === "GET" && pathname === "/auth/openai/poll") {
    const sessionId = normalizeText(requestUrl.searchParams.get("session_id"));
    if (!sessionId) {
      sendJson(res, 400, { error: "session_id is required." });
      return;
    }

    const session = loginSessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { status: "expired", error: "Login session not found or expired." });
      return;
    }

    const expiresIn = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
    sendJson(res, 200, {
      status: session.status,
      expires_in: expiresIn,
      error: session.error || ""
    });
    return;
  }

  if (method === "POST" && pathname === "/auth/openai/logout") {
    await parseJsonBody(req);
    try {
      const result = await runCommand(CODEX_BIN, ["logout"], { timeoutMs: 20_000 });
      if (result.code !== 0) {
        throw new Error(normalizeText(result.stderr || result.stdout) || "codex logout failed.");
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { error: error?.message || "Failed to log out from Codex." });
    }
    return;
  }

  if (method === "POST" && pathname === "/api/generate") {
    const body = await parseJsonBody(req);
    if (!normalizeText(body.prompt)) {
      sendJson(res, 400, { error: "prompt is required." });
      return;
    }

    let status;
    try {
      status = await getCodexLoginStatus();
    } catch (error) {
      sendJson(res, 500, { error: error?.message || "Failed to verify OpenAI login status." });
      return;
    }

    if (!status.logged_in) {
      sendJson(res, 401, { error: "Not logged in to OpenAI/Codex. Open add-on settings and connect." });
      return;
    }

    try {
      const generated = await runCodexGenerate(body);
      sendJson(res, 200, generated);
    } catch (error) {
      sendJson(res, 502, { error: error?.message || "Failed to generate email via Codex." });
    }
    return;
  }

  if (method === "POST" && pathname === "/api/todos/generate") {
    const body = await parseJsonBody(req);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (!messages.length) {
      sendJson(res, 200, {
        todos: [],
        generated_at: new Date().toISOString()
      });
      return;
    }

    let status;
    try {
      status = await getCodexLoginStatus();
    } catch (error) {
      sendJson(res, 500, { error: error?.message || "Failed to verify OpenAI login status." });
      return;
    }

    if (!status.logged_in) {
      sendJson(res, 401, { error: "Not logged in to OpenAI/Codex. Open add-on settings and connect." });
      return;
    }

    try {
      const todos = await runCodexGenerateTodos(body);
      sendJson(res, 200, {
        todos,
        generated_at: new Date().toISOString()
      });
    } catch (error) {
      sendJson(res, 502, { error: error?.message || "Failed to generate TODO list via Codex." });
    }
    return;
  }

  if (method === "GET" && pathname === "/api/todos/state") {
    try {
      const state = readTodoStateFiles();
      sendJson(res, 200, {
        ok: true,
        state,
        files: {
          json: TODO_STATE_JSON_PATH,
          md: TODO_STATE_MD_PATH
        }
      });
    } catch (error) {
      sendJson(res, 500, { error: error?.message || "Failed to read TODO state file." });
    }
    return;
  }

  if ((method === "POST" || method === "PUT") && pathname === "/api/todos/state") {
    const body = await parseJsonBody(req);
    try {
      const state = saveTodoStateFiles(body);
      sendJson(res, 200, {
        ok: true,
        saved_at: state.savedAt,
        todo_count: state.items.length,
        archive_count: state.archiveItems.length,
        files: {
          json: TODO_STATE_JSON_PATH,
          md: TODO_STATE_MD_PATH
        }
      });
    } catch (error) {
      sendJson(res, 500, { error: error?.message || "Failed to save TODO state file." });
    }
    return;
  }

  if (pathname.startsWith("/auth/") || pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  sendHtml(
    res,
    200,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ThunderAI Backend</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f4f5f7; margin: 0; padding: 24px; color: #111827; }
      main { max-width: 640px; margin: 20px auto; background: #fff; border: 1px solid #d0d7de; border-radius: 10px; padding: 20px; }
      h1 { margin-top: 0; }
      code { background: #f3f4f6; padding: 2px 5px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>ThunderAI Backend</h1>
      <p>Backend is running on <code>${PUBLIC_BASE_URL}</code>.</p>
      <p>Use add-on settings to connect OpenAI via <code>codex login --device-auth</code>.</p>
    </main>
  </body>
</html>`
  );
}

const server = http.createServer((req, res) => {
  handleRoute(req, res).catch((error) => {
    console.error("[error]", error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error." });
    } else {
      res.end();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[thunderai-backend] listening on ${PUBLIC_BASE_URL}`);
});
