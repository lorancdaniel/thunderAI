/* global ExtensionAPI, Services, ChromeUtils */

const { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { classes: Cc, interfaces: Ci } = Components;

const PANEL_CONTAINER_ID = "thundertodo-embedded-panel";
const PANEL_SPLITTER_ID = "thundertodo-embedded-panel-splitter";
const PANEL_CONTENT_ID = "thundertodo-embedded-panel-content";
const PANEL_HOST_ID = "tabmail-container";
const PANEL_MIN_WIDTH = 260;
const PANEL_MAX_WIDTH = 640;
const MAX_RENDERED_ITEMS = 80;
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const LAUNCH_AGENT_LABEL = "com.thunderai.server";

this.todoPanelExperiment = class extends ExtensionAPI {
  constructor(extension) {
    super(extension);
    this.panelVisible = true;
    this.panelWidth = 340;
    this.addonVersion = extension?.manifest?.version || "";
    this.panelData = {
      items: [],
      meta: {}
    };
    this.windowListener = null;
    this.listenerRegistered = false;
    this.panelActionFire = null;
  }

  _isMailWindow(window) {
    const doc = window?.document;
    const root = doc?.documentElement;
    return Boolean(root && root.getAttribute("windowtype") === "mail:3pane");
  }

  _forEachMailWindow(callback) {
    const enumerator = Services.wm.getEnumerator("mail:3pane");
    while (enumerator.hasMoreElements()) {
      const window = enumerator.getNext();
      if (this._isMailWindow(window)) {
        callback(window);
      }
    }
  }

  _normalizeWidth(width) {
    const numeric = Number(width);
    if (!Number.isFinite(numeric)) {
      return this.panelWidth;
    }
    return Math.max(PANEL_MIN_WIDTH, Math.min(Math.round(numeric), PANEL_MAX_WIDTH));
  }

  _safeText(value) {
    return String(value || "").trim();
  }

  _formatDate(value) {
    if (!value) {
      return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleString();
  }

  _queryAllById(doc, id) {
    return Array.from(doc.querySelectorAll(`[id="${id}"]`));
  }

  _dedupeById(doc, id) {
    const nodes = this._queryAllById(doc, id);
    if (!nodes.length) {
      return null;
    }
    for (const node of nodes.slice(1)) {
      node.remove();
    }
    return nodes[0];
  }

  _removeAllPanelNodes(doc) {
    for (const id of [PANEL_CONTENT_ID, PANEL_CONTAINER_ID, PANEL_SPLITTER_ID]) {
      for (const node of this._queryAllById(doc, id)) {
        node.remove();
      }
    }
  }

  _createHtml(doc, tagName) {
    return doc.createElementNS(XHTML_NS, tagName);
  }

  _emitPanelAction(action) {
    if (!this.panelActionFire) {
      return;
    }
    try {
      this.panelActionFire.async(action);
    } catch (_error) {
      // Ignore panel event errors.
    }
  }

  _bindWheelScroll(viewport) {
    if (!viewport || viewport.dataset?.thundertodoWheelBound === "1") {
      return;
    }

    viewport.addEventListener(
      "wheel",
      (event) => {
        const target = event.currentTarget;
        if (!target) {
          return;
        }

        const maxScrollTop = target.scrollHeight - target.clientHeight;
        if (maxScrollTop <= 0) {
          return;
        }

        target.scrollTop += event.deltaY;
        event.preventDefault();
        event.stopPropagation();
      },
      { passive: false }
    );

    viewport.dataset.thundertodoWheelBound = "1";
  }

  _setWindowPanelVisibility(window, visible) {
    const doc = window.document;
    const container = doc.getElementById(PANEL_CONTAINER_ID);
    const splitter = doc.getElementById(PANEL_SPLITTER_ID);
    if (!container || !splitter) {
      return;
    }

    container.hidden = !visible;
    splitter.hidden = !visible;
  }

  _runShellCommand(shellCommand) {
    return new Promise((resolve, reject) => {
      try {
        const shellFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        shellFile.initWithPath("/bin/zsh");
        if (!shellFile.exists()) {
          reject(new Error("Brak /bin/zsh."));
          return;
        }

        const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
        process.init(shellFile);

        process.runAsync(
          ["-lc", shellCommand],
          2,
          {
            observe: (_subject, topic) => {
              if (topic === "process-finished") {
                if (process.exitValue === 0) {
                  resolve(true);
                } else {
                  reject(new Error(`Command failed with exit code ${process.exitValue}.`));
                }
                return;
              }

              reject(new Error("Shell command failed."));
            }
          },
          false
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  async _startBackendService() {
    const command =
      `/bin/launchctl kickstart -k gui/$(id -u)/${LAUNCH_AGENT_LABEL}` +
      ` || /bin/launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"`;
    await this._runShellCommand(command);
    return {
      ok: true,
      label: LAUNCH_AGENT_LABEL
    };
  }

  _renderPanel(window) {
    const doc = window.document;
    const content = doc.getElementById(PANEL_CONTENT_ID);
    if (!content) {
      return;
    }

    while (content.firstChild) {
      content.firstChild.remove();
    }

    const root = this._createHtml(doc, "div");
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.flex = "1 1 auto";
    root.style.gap = "8px";
    root.style.height = "100%";
    root.style.minHeight = "0";
    root.style.padding = "10px";
    root.style.boxSizing = "border-box";
    root.style.background = "#eef3fb";
    root.style.color = "#1a2438";
    root.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    root.style.fontSize = "12px";

    const title = this._createHtml(doc, "h2");
    title.textContent = "thunderTODOcodex";
    title.style.margin = "0";
    title.style.fontSize = "16px";
    root.appendChild(title);

    if (this.addonVersion) {
      const version = this._createHtml(doc, "div");
      version.textContent = `Wersja dodatku: ${this.addonVersion}`;
      version.style.fontSize = "10px";
      version.style.color = "#4b5a79";
      root.appendChild(version);
    }

    const subtitle = this._createHtml(doc, "div");
    const lastGeneratedAt = this._formatDate(this.panelData?.meta?.lastGeneratedAt);
    subtitle.textContent = lastGeneratedAt
      ? `Ostatnia generacja: ${lastGeneratedAt}`
      : "Brak wygenerowanej listy TODO";
    subtitle.style.color = "#4b5a79";
    root.appendChild(subtitle);

    const backendOnline = typeof this.panelData?.meta?.backendOnline === "boolean"
      ? this.panelData.meta.backendOnline
      : null;
    const backendStatusRow = this._createHtml(doc, "div");
    backendStatusRow.style.display = "flex";
    backendStatusRow.style.alignItems = "center";
    backendStatusRow.style.justifyContent = "space-between";
    backendStatusRow.style.gap = "6px";
    backendStatusRow.style.fontSize = "11px";
    backendStatusRow.style.color = "#4b5a79";

    const backendStatusLeft = this._createHtml(doc, "div");
    backendStatusLeft.style.display = "inline-flex";
    backendStatusLeft.style.alignItems = "center";
    backendStatusLeft.style.gap = "6px";

    const backendDot = this._createHtml(doc, "span");
    backendDot.style.width = "8px";
    backendDot.style.height = "8px";
    backendDot.style.borderRadius = "999px";
    backendDot.style.display = "inline-block";
    backendDot.style.background =
      backendOnline === true ? "#12b76a" : backendOnline === false ? "#f04438" : "#98a2b3";
    backendStatusLeft.appendChild(backendDot);

    const backendLabel = this._createHtml(doc, "span");
    backendLabel.textContent =
      backendOnline === true
        ? "Serwer online"
        : backendOnline === false
          ? "Serwer offline"
          : "Status serwera nieznany";
    backendStatusLeft.appendChild(backendLabel);
    backendStatusRow.appendChild(backendStatusLeft);

    const startServerButton = this._createHtml(doc, "button");
    startServerButton.type = "button";
    startServerButton.textContent = "Uruchom";
    startServerButton.style.border = "none";
    startServerButton.style.borderRadius = "6px";
    startServerButton.style.padding = "4px 8px";
    startServerButton.style.background = "#4f5968";
    startServerButton.style.color = "#ffffff";
    startServerButton.style.fontWeight = "700";
    startServerButton.style.cursor = "pointer";
    startServerButton.style.fontSize = "11px";
    startServerButton.addEventListener("click", () => {
      this._emitPanelAction({
        type: "startBackendService"
      });
    });
    backendStatusRow.appendChild(startServerButton);
    root.appendChild(backendStatusRow);

    if (this._safeText(this.panelData?.meta?.lastError)) {
      const errorEl = this._createHtml(doc, "div");
      errorEl.textContent = this._safeText(this.panelData.meta.lastError);
      errorEl.style.color = "#b42318";
      root.appendChild(errorEl);
    }

    const items = Array.isArray(this.panelData?.items) ? this.panelData.items : [];
    if (!items.length) {
      const empty = this._createHtml(doc, "div");
      empty.textContent = "Brak TODO. Kliknij \"Wymus odswiezenie teraz\" w ustawieniach.";
      empty.style.marginTop = "4px";
      empty.style.padding = "8px";
      empty.style.border = "1px dashed #d7dfec";
      empty.style.borderRadius = "8px";
      empty.style.background = "#ffffff";
      empty.style.color = "#4b5a79";
      root.appendChild(empty);
      content.appendChild(root);
      return;
    }

    const listViewport = this._createHtml(doc, "div");
    listViewport.style.flex = "1 1 auto";
    listViewport.style.minHeight = "220px";
    listViewport.style.maxHeight = "calc(100vh - 180px)";
    listViewport.style.overflowY = "auto";
    listViewport.style.overflowX = "hidden";
    listViewport.style.paddingRight = "2px";
    listViewport.style.overscrollBehavior = "contain";
    listViewport.style.scrollbarWidth = "thin";
    this._bindWheelScroll(listViewport);

    const list = this._createHtml(doc, "div");
    list.style.display = "grid";
    list.style.gap = "8px";
    list.style.paddingBottom = "8px";

    for (const item of items.slice(0, MAX_RENDERED_ITEMS)) {
      const itemId = this._safeText(item?.id);
      const isDone = Boolean(item?.done);
      const sourceMessageId = Number(item?.sourceMessageId || 0);
      const sourceHeaderMessageId = this._safeText(item?.sourceHeaderMessageId);

      const card = this._createHtml(doc, "article");
      card.style.border = "1px solid #d7dfec";
      card.style.borderRadius = "8px";
      card.style.padding = "8px";
      card.style.background = "#ffffff";
      card.style.display = "grid";
      card.style.gap = "5px";
      if (isDone) {
        card.style.opacity = "0.75";
      }

      const cardTitle = this._createHtml(doc, "div");
      cardTitle.textContent = this._safeText(item?.title) || "(brak tytulu)";
      cardTitle.style.fontWeight = "700";
      if (isDone) {
        cardTitle.style.textDecoration = "line-through";
      }
      card.appendChild(cardTitle);

      if (this._safeText(item?.description)) {
        const description = this._createHtml(doc, "div");
        description.textContent = this._safeText(item.description);
        description.style.color = "#304061";
        card.appendChild(description);
      }

      const sourceSubject = this._safeText(item?.sourceSubject) || "(brak tematu)";
      const sourceAuthor = this._safeText(item?.sourceAuthor);
      const sourceDate = this._formatDate(item?.sourceDate);
      const meta = this._createHtml(doc, "div");
      meta.textContent = [sourceSubject, sourceAuthor, sourceDate].filter(Boolean).join(" | ");
      meta.style.fontSize = "11px";
      meta.style.color = "#4b5a79";
      card.appendChild(meta);

      const actions = this._createHtml(doc, "div");
      actions.style.display = "flex";
      actions.style.alignItems = "center";
      actions.style.gap = "6px";
      actions.style.flexWrap = "wrap";

      const replyButton = this._createHtml(doc, "button");
      replyButton.type = "button";
      replyButton.textContent = "Odpowiedz";
      replyButton.style.border = "none";
      replyButton.style.borderRadius = "6px";
      replyButton.style.padding = "4px 8px";
      replyButton.style.background = "#0f62fe";
      replyButton.style.color = "#ffffff";
      replyButton.style.fontWeight = "700";
      replyButton.style.cursor = "pointer";
      replyButton.disabled = !sourceMessageId;
      replyButton.addEventListener("click", () => {
        this._emitPanelAction({
          type: "reply",
          todoId: itemId,
          sourceMessageId,
          sourceHeaderMessageId
        });
      });
      actions.appendChild(replyButton);

      const openButton = this._createHtml(doc, "button");
      openButton.type = "button";
      openButton.textContent = "Mail";
      openButton.style.border = "none";
      openButton.style.borderRadius = "6px";
      openButton.style.padding = "4px 8px";
      openButton.style.background = "#4f5968";
      openButton.style.color = "#ffffff";
      openButton.style.fontWeight = "700";
      openButton.style.cursor = "pointer";
      openButton.addEventListener("click", () => {
        this._emitPanelAction({
          type: "openSource",
          todoId: itemId,
          sourceMessageId,
          sourceHeaderMessageId
        });
      });
      actions.appendChild(openButton);

      const doneLabel = this._createHtml(doc, "label");
      doneLabel.style.display = "inline-flex";
      doneLabel.style.alignItems = "center";
      doneLabel.style.gap = "4px";
      doneLabel.style.marginLeft = "2px";

      const doneInput = this._createHtml(doc, "input");
      doneInput.type = "checkbox";
      doneInput.checked = isDone;
      doneInput.addEventListener("change", () => {
        this._emitPanelAction({
          type: "toggleDone",
          todoId: itemId,
          done: Boolean(doneInput.checked)
        });
      });
      doneLabel.appendChild(doneInput);

      const doneText = this._createHtml(doc, "span");
      doneText.textContent = "Wykonane";
      doneLabel.appendChild(doneText);

      actions.appendChild(doneLabel);
      card.appendChild(actions);
      list.appendChild(card);
    }

    listViewport.appendChild(list);
    root.appendChild(listViewport);
    content.appendChild(root);
  }

  _getHost(doc) {
    return doc.getElementById(PANEL_HOST_ID) || doc.getElementById("messengerBody") || null;
  }

  _injectPanel(window, options = {}) {
    if (!this._isMailWindow(window)) {
      return;
    }

    const doc = window.document;
    const host = this._getHost(doc);
    if (!host) {
      return;
    }

    let splitter = this._dedupeById(doc, PANEL_SPLITTER_ID);
    let container = this._dedupeById(doc, PANEL_CONTAINER_ID);
    let content = this._dedupeById(doc, PANEL_CONTENT_ID);

    const invalidStructure =
      (splitter && !container) ||
      (!splitter && container) ||
      (container && !content);

    if (invalidStructure) {
      this._removeAllPanelNodes(doc);
      splitter = null;
      container = null;
      content = null;
    }

    if (!splitter || !container || !content) {
      splitter = doc.createXULElement("splitter");
      splitter.id = PANEL_SPLITTER_ID;
      splitter.setAttribute("resizebefore", "closest");
      splitter.setAttribute("resizeafter", "closest");
      splitter.setAttribute("collapse", "before");

      container = doc.createXULElement("vbox");
      container.id = PANEL_CONTAINER_ID;
      container.setAttribute("width", String(this.panelWidth));
      container.setAttribute("orient", "vertical");
      container.setAttribute(
        "style",
        [
          `min-width: ${PANEL_MIN_WIDTH}px;`,
          `max-width: ${PANEL_MAX_WIDTH}px;`,
          "border-left: 1px solid var(--splitter-color, #c8d0dc);",
          "background: #eef3fb;",
          "overflow: hidden;",
          "display: flex;",
          "flex-direction: column;"
        ].join(" ")
      );

      content = this._createHtml(doc, "div");
      content.id = PANEL_CONTENT_ID;
      content.style.width = "100%";
      content.style.flex = "1 1 auto";
      content.style.minHeight = "0";
      content.style.overflow = "auto";
      content.style.display = "flex";
      content.style.flexDirection = "column";
      content.style.overscrollBehavior = "contain";

      container.appendChild(content);
      host.appendChild(splitter);
      host.appendChild(container);
    }

    container.setAttribute("width", String(this.panelWidth));
    this._setWindowPanelVisibility(window, this.panelVisible);
    this._renderPanel(window);

    if (options.focus) {
      try {
        window.focus();
      } catch (_error) {
        // Ignore focus errors.
      }
    }
  }

  _removePanel(window) {
    if (!this._isMailWindow(window)) {
      return;
    }
    this._removeAllPanelNodes(window.document);
  }

  _registerWindowListener() {
    if (this.listenerRegistered) {
      return;
    }

    this.windowListener = {
      onOpenWindow: (xulWindow) => {
        let domWindow = null;
        try {
          domWindow = xulWindow.docShell?.domWindow || null;
        } catch (_error) {
          domWindow = null;
        }
        if (!domWindow) {
          return;
        }

        domWindow.addEventListener(
          "load",
          () => {
            if (this._isMailWindow(domWindow)) {
              this._injectPanel(domWindow, { focus: false });
            }
          },
          { once: true }
        );
      },
      onCloseWindow: (_xulWindow) => {},
      onWindowTitleChange: (_xulWindow, _newTitle) => {}
    };

    Services.wm.addListener(this.windowListener);
    this.listenerRegistered = true;
  }

  _unregisterWindowListener() {
    if (!this.listenerRegistered || !this.windowListener) {
      return;
    }

    try {
      Services.wm.removeListener(this.windowListener);
    } catch (_error) {
      // Ignore remove listener errors.
    }

    this.listenerRegistered = false;
    this.windowListener = null;
  }

  _normalizePanelData(raw) {
    const data = raw && typeof raw === "object" ? raw : {};
    return {
      items: Array.isArray(data.items) ? data.items : [],
      meta: data.meta && typeof data.meta === "object" ? data.meta : {}
    };
  }

  async _ensurePanel(options = {}) {
    if (typeof options.visible === "boolean") {
      this.panelVisible = options.visible;
    }
    if (typeof options.width !== "undefined") {
      this.panelWidth = this._normalizeWidth(options.width);
    }

    this._registerWindowListener();
    this._forEachMailWindow((window) => {
      this._injectPanel(window, { focus: options.focus === true });
    });
    return true;
  }

  async _setPanelVisible(visible) {
    this.panelVisible = Boolean(visible);
    this._registerWindowListener();
    this._forEachMailWindow((window) => {
      this._setWindowPanelVisibility(window, this.panelVisible);
    });
    return true;
  }

  async _setPanelData(data) {
    this.panelData = this._normalizePanelData(data);
    this._registerWindowListener();
    this._forEachMailWindow((window) => {
      this._renderPanel(window);
    });
    return true;
  }

  onShutdown(isAppShutdown) {
    this._forEachMailWindow((window) => {
      this._removePanel(window);
    });
    this._unregisterWindowListener();
    this.panelActionFire = null;

    if (!isAppShutdown) {
      Services.obs.notifyObservers(null, "startupcache-invalidate");
    }
  }

  getAPI(context) {
    return {
      todoPanelExperiment: {
        ensurePanel: async (options = {}) => this._ensurePanel(options),
        setPanelVisible: async (visible) => this._setPanelVisible(visible),
        setPanelData: async (data = {}) => this._setPanelData(data),
        startBackendService: async () => this._startBackendService(),
        onPanelAction: new ExtensionCommon.EventManager({
          context,
          name: "todoPanelExperiment.onPanelAction",
          register: (fire) => {
            this.panelActionFire = fire;
            return () => {
              if (this.panelActionFire === fire) {
                this.panelActionFire = null;
              }
            };
          }
        }).api()
      }
    };
  }
};
