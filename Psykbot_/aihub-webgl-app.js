// aihub-webgl-app.js
// Loads ui.html then runs the app logic.

(() => {
  // ===== Unity build filenames (EDIT if yours differ) =====
  const UNITY_LOADER_URL = "Build/Build.loader.js";
  const BUILD_NAME = "Build"; // Build/Build.data, Build/Build.framework.js, Build/Build.wasm

  document.documentElement.dataset.theme = "light"; // dark | light | ocean | violet | sunset

  // Will be set after UI injection
  let statusEl, progressBar, loadingEl, canvas;
  let chatBody, btnChatCollapse, chatCollapsedBtn;
  let langWrap, langSelect;
  let micWrap, micBtn, micHint;

  if (!window.AIHubBridge) {
    throw new Error("AIHubBridge not found. Make sure bridge.js is loaded before aihub-webgl-app.js");
  }

  function qs(sel) {
    const el = document.querySelector(sel);
    if (!el) throw new Error("Missing element: " + sel);
    return el;
  }

  async function injectUI() {
    const root = document.getElementById("ui-root");
    if (!root) throw new Error("Missing #ui-root in index.html");

    try {
      const res = await fetch("ui.html", { cache: "no-store" });
      if (!res.ok) throw new Error(`ui.html fetch failed: ${res.status}`);
      root.innerHTML = await res.text();
    } catch (e) {
      // Fallback (keeps page usable even if ui.html isn't served)
      root.innerHTML = `
        <div id="langWrap" title="Language"><select id="langSelect" aria-label="Language"></select></div>
        <div id="chat"><div id="chatHeader"><div class="title">Chat History</div><div class="spacer"></div><button id="btnChatCollapse">Hide</button></div><div id="chatBody"></div></div>
        <button id="chatCollapsedBtn">💬 Chat</button>
        <div id="micWrap" data-state="idle">
          <div id="micBtn" title="Press & hold to talk" aria-label="Hold to talk">
            <img src="icons/mic.svg" alt="" aria-hidden="true" />
          </div>
          <div id="micHint">Hold to talk</div>
        </div>
      `;
      console.warn("UI fallback used. Reason:", e);
    }
  }

  function bindElements() {
    // Unity
    statusEl = qs("#unity-status");
    progressBar = qs("#unity-progress-bar");
    loadingEl = qs("#unity-loading");
    canvas = qs("#unity-canvas");

    // Chat
    chatBody = qs("#chatBody");
    btnChatCollapse = qs("#btnChatCollapse");
    chatCollapsedBtn = qs("#chatCollapsedBtn");

    // Language
    langWrap = qs("#langWrap");
    langSelect = qs("#langSelect");

    // Mic
    micWrap = qs("#micWrap");
    micBtn = qs("#micBtn");
    micHint = qs("#micHint");
  }

  // ===== Chat =====
  const LS_CHAT = "AIHubBridge.chatCollapsed";

  function setChatCollapsed(v) {
    document.body.classList.toggle("chat-collapsed", !!v);
    try { localStorage.setItem(LS_CHAT, v ? "1" : "0"); } catch { }
  }

  function getChatCollapsed() {
    try {
      const v = localStorage.getItem(LS_CHAT);
      // Default: collapsed (clean UI)
      if (v === null) return true;
      return v === "1";
    } catch { return true; }
  }

  // function addMsg(role, text) {
  //   const div = document.createElement("div");
  //   div.className = "msg " + role;
  //   div.textContent = text;
  //   chatBody.appendChild(div);
  //   chatBody.scrollTop = chatBody.scrollHeight;
  // }

  function addMsg(role, text) {
    const div = document.createElement("div");
    div.className = "msg " + role;

    // 1. Process the text through the PDF Viewer manager
    // This detects "||PDF:filename||", opens the viewer, and returns clickable HTML.
    const processedText = PDFViewer.processText(text);

    // 2. Use innerHTML so the clickable <span> renders correctly
    div.innerHTML = processedText;

    chatBody.appendChild(div);
    chatBody.scrollTop = chatBody.scrollHeight;
  }
  
  // ===== Language dropdown =====
  const LS_LANG = "AIHubBridge.preferredLanguage";

  function readStoredLang() {
    try { return localStorage.getItem(LS_LANG) || ""; } catch { return ""; }
  }

  function writeStoredLang(v) {
    try { localStorage.setItem(LS_LANG, String(v || "")); } catch { }
  }

  function getProjectLanguages(project) {
    if (!project) return [];

    // Prefer explicit Language array from AI Hub
    let arr = project.Language || project.language;
    let out = [];

    if (Array.isArray(arr)) out = arr.map(x => String(x || "").trim()).filter(Boolean);
    else if (typeof arr === "string") out = [arr.trim()].filter(Boolean);

    // Fallback: derive languages from Backstory keys if Language isn't present
    if (out.length === 0) {
      const back = project.Backstory || project.backstory;
      if (back && typeof back === "object") {
        out = Object.keys(back).map(k => String(k || "").trim()).filter(Boolean);
      }
    }

    // De-duplicate (case-insensitive) while keeping original labels
    const seen = new Set();
    const unique = [];
    for (const l of out) {
      const key = l.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(l);
    }
    return unique;
  }

  function pickInitialLanguage(langs) {
    const stored = readStoredLang();
    if (stored) {
      const match = langs.find(x => x.toLowerCase() === stored.toLowerCase());
      if (match) return match;
    }
    return langs[0] || "";
  }

  function refreshLanguageUI(project) {
    const langs = getProjectLanguages(project);

    // Hide if 0 or 1 language
    if (!langs || langs.length <= 1) {
      langWrap.style.display = "none";
      const only = langs[0] || "";
      if (only) {
        window.AIHubBridge.setPreferredLanguage(only);
        writeStoredLang(only);
      }
      return;
    }

    // Show + populate
    langWrap.style.display = "flex";
    langSelect.innerHTML = "";
    for (const l of langs) {
      const opt = document.createElement("option");
      opt.value = l;
      opt.textContent = l;
      langSelect.appendChild(opt);
    }

    const initial = pickInitialLanguage(langs);
    if (initial) {
      langSelect.value = initial;
      window.AIHubBridge.setPreferredLanguage(initial);
      writeStoredLang(initial);
    }
  }

  // ===== Mic wiring =====
  function setMicEnabled(enabled) {
    const on = !!enabled;
    micBtn.style.pointerEvents = on ? "auto" : "none";
    micBtn.style.opacity = on ? "1" : "0.45";
    micBtn.setAttribute("aria-disabled", on ? "false" : "true");

    if (!on) micHint.textContent = "Loading…";
    else if (micWrap.dataset.state === "idle") micHint.textContent = "Hold to talk";
  }

  let micDown = false;

  function setMicState(state) {
    micWrap.dataset.state = state || "idle";
    switch (state) {
      case "recording": micHint.textContent = "Recording… release to send"; break;
      case "transcribing": micHint.textContent = "Transcribing…"; break;
      case "thinking": micHint.textContent = "Thinking…"; break;
      case "speaking": micHint.textContent = "Speaking… (press to interrupt)"; break;
      default: micHint.textContent = "Hold to talk"; break;
    }
  }

  async function micPressStart(ev) {
    ev.preventDefault();
    if (micDown) return;
    micDown = true;
    try { await window.AIHubBridge.pttStart(); }
    catch (e) {
      micDown = false;
      setMicState("idle");
      window.AIHubBridge.emit("bridge:error", "Mic start failed: " + String(e));
    }
  }

  async function micPressEnd(ev) {
    ev.preventDefault();
    if (!micDown) return;
    micDown = false;
    try { await window.AIHubBridge.pttStop(); }
    catch (e) {
      setMicState("idle");
      window.AIHubBridge.emit("bridge:error", "Mic stop failed: " + String(e));
    }
  }

  // ===== AUTO: load Config + Project on page load =====
  async function autoInit() {
    try {
      await window.AIHubBridge.loadConfig();
      addMsg("system", "Config loaded (auto)");
      await window.AIHubBridge.ensureProject();
      addMsg("system", "Project loaded (auto)");
    } catch (e) {
      addMsg("assistant", "Auto init: " + String(e));
      setChatCollapsed(false);
    }
  }

  // ===== Unity Boot =====
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load: " + src));
      document.head.appendChild(s);
    });
  }

  async function bootUnity() {
    try {
      autoInit();

      statusEl.textContent = "Loading Unity loader…";
      await loadScript(UNITY_LOADER_URL);

      if (typeof createUnityInstance !== "function") {
        throw new Error("createUnityInstance not found. Check UNITY_LOADER_URL.");
      }

      statusEl.textContent = "Starting Unity…";

      const buildUrl = "Build";
      const config = {
        dataUrl: buildUrl + `/${BUILD_NAME}.data`,
        frameworkUrl: buildUrl + `/${BUILD_NAME}.framework.js`,
        codeUrl: buildUrl + `/${BUILD_NAME}.wasm`,
        streamingAssetsUrl: "StreamingAssets",
        companyName: "5D AI Hub",
        productName: "AIHubBridge",
        productVersion: "1.0"
      };

      const unityInstance = await createUnityInstance(canvas, config, (p) => {
        const pct = Math.round(p * 100);
        progressBar.style.width = pct + "%";
        statusEl.textContent = "Loading World… " + pct + "%";
      });

      window.unityInstance = unityInstance;
      loadingEl.style.display = "none";
      statusEl.textContent = "Unity ready.";

      // Unity receives ONLY TTS start/stop
      window.AIHubBridge.attachUnity(unityInstance, {
        receiverObject: "AIHubBridge",
        onProjectMethod: "",
        onErrorMethod: "",
        onTtsStartMethod: "OnTtsStart",
        onTtsStopMethod: "OnTtsStop"
      });

      setMicEnabled(true);

    } catch (e) {
      addMsg("assistant", "Unity failed: " + String(e));
      setChatCollapsed(false);
    }
  }

  async function main() {
    await injectUI();
    bindElements();

    // Apply saved chat state after UI exists
    setChatCollapsed(getChatCollapsed());

    btnChatCollapse.onclick = () => setChatCollapsed(true);
    chatCollapsedBtn.onclick = () => setChatCollapsed(false);

    // Bridge → chat
    window.AIHubBridge.on("chat:user", m => addMsg("user", m.text || ""));
    window.AIHubBridge.on("chat:assistant", m => addMsg("assistant", m.text || ""));
    window.AIHubBridge.on("bridge:error", m => {
      addMsg("system", "⚠️ " + m);
      setChatCollapsed(false);
    });
    window.AIHubBridge.on("session:minted", () => addMsg("system", "Session minted (auto)."));
    window.AIHubBridge.on("project:loaded", () => addMsg("system", "Project loaded (auto)."));

    // Language events
    langSelect.addEventListener("change", () => {
      const v = String(langSelect.value || "").trim();
      if (!v) return;
      window.AIHubBridge.setPreferredLanguage(v);
      writeStoredLang(v);
      addMsg("system", "Language: " + v);
    });

    window.AIHubBridge.on("project:loaded", (p) => refreshLanguageUI(p));
    window.AIHubBridge.on("project:updated", (p) => refreshLanguageUI(p));

    // Mic
    setMicEnabled(false);
    window.AIHubBridge.on("mic:state", (m) => setMicState(m?.state || "idle"));

    micBtn.addEventListener("pointerdown", micPressStart);
    micBtn.addEventListener("pointerup", micPressEnd);
    micBtn.addEventListener("pointercancel", micPressEnd);
    micBtn.addEventListener("pointerleave", (ev) => { if (micDown) micPressEnd(ev); });
    micBtn.addEventListener("contextmenu", (e) => e.preventDefault());

    // Start Unity
    bootUnity();
  }

  main();
})();
