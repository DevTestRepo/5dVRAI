/* bridge.js
   AIHubBridge — JS-side brain (Server-Controlled)

   Key points:
   - Bootstrap config only (baseUrl, projectId, buildCredential, endpoint paths)
   - LIVE project payload controls behavior (no Unity rebuild needed)
   - Dynamic languages (no hardcoding)
   - TTS provider routing based on project.ttsMode (robust normalization):
       - any string containing "gemini" => Gemini endpoint (/api/tts-google-pro)
       - any string containing "11" or "eleven" => ElevenLabs (/api/tts-11-labs-managed)
       - any string containing "openai" => OpenAI (/api/tts-open-ai-managed)
       - otherwise => Google (/api/tts-google-managed or config endpoint)
*/

(() => {
  const Bridge = {
    config: null,
    project: null,

    token: "",
    tokenExpiresAtMs: 0,
    _renewTimer: null,

    _projectRefreshTimer: null,
    _projectRefreshMs: 0,
    _lastProjectJson: "",

    _preferredLanguage: "",

    unity: {
      instance: null,
      receiverObject: "AIHubBridge",
      onProjectMethod: "OnProjectLoaded",
      onErrorMethod: "OnBridgeError",
      onListeningStartMethod: "OnListeningStart",
      onListeningStopMethod: "OnListeningStop",
      onThinkingStartMethod: "OnThinkingStart",
      onThinkingStopMethod: "OnThinkingStop",
      onTtsStartMethod: "OnTtsStart",
      onTtsStopMethod: "OnTtsStop",
    },

    debug: true,

    _listeners: new Map(),
    on(evt, cb) {
      if (!this._listeners.has(evt)) this._listeners.set(evt, []);
      this._listeners.get(evt).push(cb);
    },
    emit(evt, payload) {
      const arr = this._listeners.get(evt);
      if (!arr) return;
      for (const fn of arr) {
        try {
          fn(payload);
        } catch (e) {
          console.warn(e);
        }
      }
    },

    log(...args) {
      if (this.debug) console.log("[AIHubBridge]", ...args);
    },

    // ---------- Helpers ----------
    _normBaseUrl(u) {
      return String(u || "")
        .trim()
        .replace(/\/+$/, "");
    },
    _normPath(p, fallback) {
      let s = String(p || "").trim();
      if (!s) s = String(fallback || "").trim();
      if (!s) return "";
      if (!s.startsWith("/")) s = "/" + s;
      return s;
    },
    _mode(s) {
      return String(s || "")
        .trim()
        .toLowerCase();
    },

    // Normalize ANY ttsMode string to one of: openai | elevenlabs | gemini | google
    _normalizeTtsProvider(modeRaw) {
      const m = this._mode(modeRaw);

      if (!m) return "google";

      // Gemini examples:
      // "gemini-2.5-pro-preview-tts"
      // "geminiPro"
      // "googlepro"
      if (m.includes("gemini")) return "gemini";
      if (m.includes("googlepro") || m.includes("pro-tts")) return "gemini"; // your endpoint is /api/tts-google-pro

      // ElevenLabs examples:
      // "11labs", "11Labs", "elevenlabs"
      if (m.includes("11") || m.includes("eleven")) return "elevenlabs";

      // OpenAI examples:
      // "OpenAI", "openai-tts"
      if (m.includes("openai")) return "openai";

      // Google examples:
      // "google", "gcp"
      if (m.includes("google") || m.includes("gcp")) return "google";

      // Default fallback
      return "google";
    },

    // ---------- Config ----------
    async loadConfig(configUrl = "StreamingAssets/AIHub/bridge_config.json") {
      if (this.config) return this.config;

      this.log("Loading config:", configUrl);
      const r = await fetch(configUrl, { cache: "no-store" });
      if (!r.ok) throw new Error(`loadConfig failed (${r.status})`);
      const cfg = await r.json();

      cfg.baseUrl = this._normBaseUrl(cfg.baseUrl);
      if (!cfg.baseUrl) throw new Error("Config baseUrl is empty");
      if (!cfg.projectId) throw new Error("Config projectId is empty");

      if (cfg.debug && typeof cfg.debug.enableDebugLogs === "boolean") {
        this.debug = !!cfg.debug.enableDebugLogs;
      }

      if (this._mode(cfg.authMode) === "buildcredential") {
        const bc = String(cfg.buildCredential || "").trim();
        if (!bc)
          throw new Error(
            "Config buildCredential is empty (authMode=BuildCredential)",
          );
      }

      cfg.endpoints = cfg.endpoints || {};
      cfg.endpoints.mintSession = this._normPath(
        cfg.endpoints.mintSession,
        "/api/webgl/mint-session",
      );
      cfg.endpoints.project = this._normPath(
        cfg.endpoints.project,
        "/api/webgl/project",
      );
      cfg.endpoints.gpt = this._normPath(cfg.endpoints.gpt, "/api/gpt-managed");
      cfg.endpoints.asr = this._normPath(
        cfg.endpoints.asr,
        "/api/transcribe-managed",
      );
      cfg.endpoints.tts = this._normPath(
        cfg.endpoints.tts,
        "/api/tts-google-managed",
      ); // Google fallback

      this.config = cfg;
      this.log("Config loaded:", {
        baseUrl: cfg.baseUrl,
        projectId: cfg.projectId,
        authMode: cfg.authMode,
      });

      await this.ensureSession("loadConfig");
      return this.config;
    },

    // ---------- Public: Language ----------
    setPreferredLanguage(langOrCode) {
      this._preferredLanguage = String(langOrCode || "").trim();
      this.emit("language:changed", { value: this._preferredLanguage });
      this.log("Preferred language set:", this._preferredLanguage);
    },

    getAvailableLanguages() {
      const p = this.project || {};
      const out = [];

      const back = p.Backstory || p.backstory;
      if (back && typeof back === "object") {
        for (const k of Object.keys(back)) {
          if (!k) continue;
          out.push(String(k).trim());
        }
      }

      const arr = p.Language || p.language;
      if (Array.isArray(arr)) {
        for (const v of arr) {
          if (!v) continue;
          const s = String(v).trim();
          if (!s) continue;
          if (!out.some((x) => x.toLowerCase() === s.toLowerCase()))
            out.push(s);
        }
      }

      return out;
    },

    // ---------- Session mint + auto-renew ----------
    _parseExpiryToMs(v) {
      if (!v) return 0;
      if (typeof v === "number") return v;
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : 0;
    },

    _extractToken(data) {
      return (
        data?.token ||
        data?.sessionToken ||
        data?.accessToken ||
        data?.data?.token ||
        data?.data?.sessionToken ||
        data?.data?.accessToken ||
        ""
      );
    },

    _extractError(data) {
      return (
        data?.error || data?.message || data?.details || data?.reason || ""
      );
    },

    async ensureSession(reason = "ensureSession") {
      await this.loadConfig();

      const now = Date.now();
      const skewMs = 25_000;

      if (
        this.token &&
        this.tokenExpiresAtMs &&
        now + skewMs < this.tokenExpiresAtMs
      ) {
        return this.token;
      }

      const url = `${this.config.baseUrl}${this.config.endpoints.mintSession}`;
      const buildCred = String(this.config.buildCredential || "").trim();

      this.log("Minting session:", {
        url,
        projectId: this.config.projectId,
        reason,
      });

      const r = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          projectid: this.config.projectId,
          "x-build-credential": buildCred,
        },
        body: JSON.stringify({ projectId: this.config.projectId, reason }),
      });

      const txt = await r.text();
      if (!r.ok) throw new Error(`mint-session failed (${r.status}): ${txt}`);

      let data;
      try {
        data = JSON.parse(txt);
      } catch {
        throw new Error(`mint-session non-json: ${txt.slice(0, 200)}`);
      }

      const token = this._extractToken(data);
      const ok = data?.ok === true || data?.success === true || !!token;

      if (!ok) {
        const err =
          this._extractError(data) ||
          `Unexpected mint-session response: ${txt}`;
        throw new Error(`mint-session error: ${err}`);
      }
      if (!token)
        throw new Error(
          `mint-session returned success but token missing: ${txt}`,
        );

      this.token = String(token);

      let expMs =
        this._parseExpiryToMs(data.expiresAtMs) ||
        this._parseExpiryToMs(data.expiresAt) ||
        (typeof data.exp === "number" ? data.exp : 0);

      if (expMs > 0 && expMs < 10_000_000_000) expMs *= 1000;
      this.tokenExpiresAtMs = expMs || Date.now() + 9 * 60 * 1000;

      this.emit("session:minted", { expiresAtMs: this.tokenExpiresAtMs });
      this.log("Session minted:", {
        expiresAtMs: this.tokenExpiresAtMs,
        tokenPreview: this.token.slice(0, 10) + "...",
      });

      clearTimeout(this._renewTimer);
      const msUntilRenew = Math.max(
        5_000,
        this.tokenExpiresAtMs - Date.now() - skewMs,
      );
      this._renewTimer = setTimeout(() => {
        this.ensureSession("autoRenew").catch((e) => this._bridgeError(e));
      }, msUntilRenew);

      return this.token;
    },

    // ---------- Project ----------
    async ensureProject() {
      await this.ensureSession("ensureProject");
      if (this.project) return this.project;
      return this.refreshProject({ reason: "ensureProject", force: true });
    },

    async refreshProject({ reason = "refreshProject", force = false } = {}) {
      await this.ensureSession(reason);

      const url = `${this.config.baseUrl}${this.config.endpoints.project || "/api/webgl/project"}`;
      this.log("Fetching project:", url);

      const r = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          projectid: this.config.projectId,
        },
      });

      const txt = await r.text();
      if (!r.ok) throw new Error(`webgl/project failed (${r.status}): ${txt}`);

      let data;
      try {
        data = JSON.parse(txt);
      } catch {
        throw new Error(`webgl/project non-json: ${txt.slice(0, 200)}`);
      }

      if (!data.ok)
        throw new Error(
          `webgl/project error: ${data.error || data.message || "unknown"}`,
        );

      const nextProject = data.project || data;
      const nextJson = JSON.stringify({ ok: true, project: nextProject });

      const first = !this.project;
      const changed = force || nextJson !== this._lastProjectJson;

      if (changed) {
        this.project = nextProject;
        this._lastProjectJson = nextJson;

        this._sendToUnity(this.unity.onProjectMethod, nextJson);

        if (first) this.emit("project:loaded", this.project);
        else this.emit("project:updated", this.project);

        this.log(first ? "Project loaded:" : "Project updated:", this.project);
      }

      return this.project;
    },

    setProjectRefreshInterval(ms) {
      const v = Math.max(0, Number(ms) || 0);
      this._projectRefreshMs = v;

      if (this._projectRefreshTimer) {
        clearInterval(this._projectRefreshTimer);
        this._projectRefreshTimer = null;
      }
      if (v > 0) {
        this._projectRefreshTimer = setInterval(() => {
          this.refreshProject({
            reason: "autoProjectRefresh",
            force: false,
          }).catch((e) => this._bridgeError(e));
        }, v);
      }

      this.log("Project refresh interval:", v);
    },

    // ---------- Unity attach ----------
    attachUnity(unityInstance, opts = {}) {
      this.unity.instance = unityInstance;

      this.unity.receiverObject =
        opts.receiverObject ?? this.unity.receiverObject;

      this.unity.onProjectMethod =
        opts.onProjectMethod ?? this.unity.onProjectMethod;

      this.unity.onErrorMethod = opts.onErrorMethod ?? this.unity.onErrorMethod;

      opts.onListeningStartMethod ?? this.unity.onListeningStartMethod;
      this.unity.onListeningStartMethod =
        opts.onListeningStartMethod ?? this.unity.onListeningStartMethod;
      this.unity.onListeningStopMethod =
        opts.onListeningStopMethod ?? this.unity.onListeningStopMethod;

      opts.onTtsStartMethod ?? this.unity.onTtsStartMethod;
      this.unity.onTtsStopMethod =
        opts.onTtsStopMethod ?? this.unity.onTtsStopMethod;

      this.unity.onThinkingStartMethod =
        opts.onThinkingStartMethod ?? "OnThinkingStart";
      this.unity.onThinkingStopMethod =
        opts.onThinkingStopMethod ?? "OnThinkingStop";

      this.log("Unity attached:", this.unity);

      if (this.project) {
        this._sendToUnity(
          this.unity.onProjectMethod,
          JSON.stringify({ ok: true, project: this.project }),
        );
      }
    },

    _sendToUnity(method, payload) {
      try {
        if (!method) return;
        if (!this.unity.instance || !this.unity.instance.SendMessage) return;
        this.unity.instance.SendMessage(
          this.unity.receiverObject,
          method,
          String(payload ?? ""),
        );
      } catch (e) {
        console.warn("[AIHubBridge] SendMessage failed:", e);
      }
    },

    _bridgeError(e) {
      const msg = e && e.message ? e.message : String(e);
      console.error("[AIHubBridge] Error:", e);
      this._sendToUnity(this.unity.onErrorMethod, msg);
      this.emit("bridge:error", msg);
    },

    // ---------- GPT ----------
    async gpt(message, opts = {}) {
      const emitChat = opts.emitChat !== false;

      await this.ensureSession("gpt");
      await this.ensureProject();

      const path =
        this.config.endpoints && this.config.endpoints.gpt
          ? this.config.endpoints.gpt
          : "/api/gpt-managed";
      const url = `${this.config.baseUrl}${path}`;

      const msg = String(message || "").trim();
      if (!msg) throw new Error("GPT message is empty");

      const language = this._getServerLanguageKey();
      const model =
        (this.project && (this.project.gptModel || this.project.GptModel)) ||
        undefined;
      const body = { message: msg, text: msg, language };
      if (model) body.gptModel = model;

      const r = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${this.token}`,
          projectid: this.config.projectId,
        },
        body: JSON.stringify(body),
      });

      const txt = await r.text();
      if (!r.ok) throw new Error(`gpt failed (${r.status}): ${txt}`);

      let data;
      try {
        data = JSON.parse(txt);
      } catch {
        data = { ok: true, text: txt };
      }

      if (emitChat) {
        this.emit("chat:user", { text: msg });
        if (data?.text)
          this.emit("chat:assistant", { text: String(data.text) });
      }

      return data;
    },

    async callGpt(text) {
      return this.gpt(text, { emitChat: true });
    },

    // ---------- TTS playback ----------
    _ttsAudio: null,
    _ttsPlaying: false,

    _notifyTtsStart() {
      this._sendToUnity(this.unity.onTtsStartMethod, "");
      this.emit("tts:start", {});
      this.emit("mic:state", { state: "speaking" });
    },

    _notifyTtsStop(reason = "ended") {
      this._sendToUnity(this.unity.onTtsStopMethod, String(reason || ""));
      this.emit("tts:stop", { reason });
      this.emit("mic:state", { state: "idle" });
    },

    stopTts(reason = "stopped") {
      try {
        if (this._ttsAudio) {
          this._ttsAudio.pause();
          this._ttsAudio.currentTime = 0;
        }
      } catch {}
      if (this._ttsPlaying) {
        this._ttsPlaying = false;
        this._notifyTtsStop(reason);
      } else {
        this._notifyTtsStop(reason);
      }
    },

    async playAudioUrl(url) {
      this.stopTts("interrupted");

      const a = new Audio();
      a.crossOrigin = "anonymous";
      a.src = url;

      this._ttsAudio = a;

      const onPlay = () => {
        if (this._ttsPlaying) return;
        this._ttsPlaying = true;
        this._notifyTtsStart();
      };

      const onEnded = () => {
        this._ttsPlaying = false;
        this._notifyTtsStop("ended");
        cleanup();
      };

      const onPause = () => {
        if (this._ttsPlaying) {
          this._ttsPlaying = false;
          this._notifyTtsStop("paused");
        }
        cleanup();
      };

      const onError = () => {
        this._ttsPlaying = false;
        this._notifyTtsStop("error");
        cleanup();
      };

      const cleanup = () => {
        a.removeEventListener("play", onPlay);
        a.removeEventListener("ended", onEnded);
        a.removeEventListener("pause", onPause);
        a.removeEventListener("error", onError);
      };

      a.addEventListener("play", onPlay);
      a.addEventListener("ended", onEnded);
      a.addEventListener("pause", onPause);
      a.addEventListener("error", onError);

      await a.play();
      return true;
    },

    // ---------- Voice pipeline: PTT + ASR + GPT + TTS ----------
    _micStream: null,
    _recorder: null,
    _recChunks: [],
    _isRecording: false,

    _pickMimeType() {
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/ogg",
      ];
      for (const t of candidates) {
        try {
          if (window.MediaRecorder && MediaRecorder.isTypeSupported(t))
            return t;
        } catch {}
      }
      return "";
    },

    async pttStart() {
      if (this._ttsPlaying) this.stopTts("barge-in");

      this._sendToUnity(this.unity.onListeningStartMethod, "");

      await this.ensureSession("pttStart");
      if (this._isRecording) return;

      this.emit("mic:state", { state: "recording" });

      try {
        if (!this._micStream) {
          this._micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
        }

        this._recChunks = [];
        const mimeType = this._pickMimeType();
        this._recorder = new MediaRecorder(
          this._micStream,
          mimeType ? { mimeType } : undefined,
        );

        this._recorder.ondataavailable = (e) => {
          if (e && e.data && e.data.size > 0) this._recChunks.push(e.data);
        };

        this._recorder.start(250);
        this._isRecording = true;
      } catch (e) {
        this._isRecording = false;
        this.emit("mic:state", { state: "idle" });
        throw e;
      }
    },

    async pttStop() {
      if (!this._isRecording || !this._recorder) return;

      this._sendToUnity(this.unity.onListeningStopMethod, "");

      const recorder = this._recorder;
      this._recorder = null;
      this._isRecording = false;

      const blob = await new Promise((resolve, reject) => {
        try {
          recorder.onstop = () => {
            try {
              const b = new Blob(this._recChunks, {
                type: recorder.mimeType || "audio/webm",
              });
              resolve(b);
            } catch (e) {
              reject(e);
            }
          };
          recorder.onerror = (e) => reject(e?.error || e);
          recorder.stop();
        } catch (e) {
          reject(e);
        }
      });

      await this.voiceTurn(blob);
    },

    // ---------- Language mapping ----------
    _languageNameToBcp47(name) {
      const n = String(name || "")
        .trim()
        .toLowerCase();
      if (!n) return "";
      const map = {
        english: "en-US",
        arabic: "ar-XA",
        danish: "da-DK",
        french: "fr-FR",
        german: "de-DE",
        spanish: "es-ES",
        italian: "it-IT",
        dutch: "nl-NL",
        portuguese: "pt-PT",
        russian: "ru-RU",
        turkish: "tr-TR",
        polish: "pl-PL",
        swedish: "sv-SE",
        norwegian: "no-NO",
        finnish: "fi-FI",
        japanese: "ja-JP",
        korean: "ko-KR",
        chinese: "cmn-CN",
        hindi: "hi-IN",
        indonesian: "id-ID",
      };
      return map[n] || "";
    },

    _bcp47ToWhisperLang(bcp47) {
      const s = String(bcp47 || "")
        .trim()
        .toLowerCase();
      if (!s) return "";
      return s.split("-")[0] || "";
    },

    _getActiveLanguageNameOrCode() {
      const p = this.project || {};
      const c = this.config || {};

      if (this._preferredLanguage) return this._preferredLanguage;

      const explicit =
        p.languageCode ||
        p.LanguageCode ||
        p.langCode ||
        p.lang ||
        c.defaults?.languageCode ||
        "";

      if (explicit) return String(explicit).trim();

      const arr = p.Language || p.language;
      if (Array.isArray(arr) && arr.length > 0)
        return String(arr[0] || "").trim();

      return "en-US";
    },

    _getServerLanguageKey() {
      // server.js expects req.body.language like: "english", "arabic", "danish", ...
      // It then uses capitalizeFirstLetter(language) to read Backstory["English"], etc.
      const v = this._getActiveLanguageNameOrCode();
      const raw = String(v || "").trim();
      const low = raw.toLowerCase();

      // 1) If matches an existing Backstory key, prefer that (case-insensitive).
      const back =
        (this.project && (this.project.Backstory || this.project.backstory)) ||
        null;
      if (back && typeof back === "object") {
        const keys = Object.keys(back);
        const match = keys.find((k) => String(k).trim().toLowerCase() === low);
        if (match) return String(match).trim().toLowerCase();
      }

      // 2) If BCP-47, map to a language name that exists in Backstory, else map common ones.
      if (/^[a-z]{2}(-[A-Z]{2})?$/.test(raw)) {
        const base = raw.split("-")[0].toLowerCase();
        const map = {
          en: "english",
          ar: "arabic",
          da: "danish",
          fr: "french",
          de: "german",
          es: "spanish",
          it: "italian",
          nl: "dutch",
          pt: "portuguese",
          ru: "russian",
          tr: "turkish",
          pl: "polish",
          sv: "swedish",
          no: "norwegian",
          fi: "finnish",
          ja: "japanese",
          ko: "korean",
          zh: "chinese",
          hi: "hindi",
          id: "indonesian",
        };

        const guess = map[base] || "english";

        if (back && typeof back === "object") {
          const keys = Object.keys(back);
          const match = keys.find(
            (k) => String(k).trim().toLowerCase() === guess,
          );
          if (match) return String(match).trim().toLowerCase();
        }

        return guess;
      }

      // 3) Otherwise treat as a plain language name (e.g., "Arabic", "English", "Danish")
      if (low) return low;

      return "english";
    },

    _guessLanguageCodeBcp47() {
      const v = this._getActiveLanguageNameOrCode();
      if (!v) return "en-US";
      if (/^[a-z]{2}(-[A-Z]{2})?$/.test(v)) return v;
      const mapped = this._languageNameToBcp47(v);
      return mapped || "en-US";
    },

    _isArabicActive() {
      const v = this._getActiveLanguageNameOrCode();
      const s = String(v || "").toLowerCase();
      // Support: BCP-47 (ar / ar-XX), English name (Arabic), or Arabic script (العربية/عرب...)
      return (
        s.startsWith("ar") ||
        s === "arabic" ||
        s.includes("arab") ||
        s.includes("عرب")
      );
    },

    // ---------- ASR ----------
    async transcribeManaged(audioBlob) {
      await this.ensureSession("asr");
      await this.ensureProject();

      const path =
        this.config.endpoints && this.config.endpoints.asr
          ? this.config.endpoints.asr
          : "/api/transcribe-managed";
      const url = `${this.config.baseUrl}${path}`;

      const fd = new FormData();
      fd.append("audio", audioBlob, "speech.webm");

      const bcp47 = this._guessLanguageCodeBcp47();
      const whisperLang = this._bcp47ToWhisperLang(bcp47);
      if (whisperLang) fd.append("lang", whisperLang);

      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          projectid: this.config.projectId,
        },
        body: fd,
      });

      const txt = await r.text();
      if (!r.ok) throw new Error(`asr failed (${r.status}): ${txt}`);

      let data;
      try {
        data = JSON.parse(txt);
      } catch {
        data = { text: txt };
      }

      const out = String(data?.text || "").trim();
      if (!out) throw new Error("ASR returned empty text");
      return out;
    },

    // ---------- TTS provider routing ----------
    _resolveTtsProvider() {
      const p = this.project || {};
      const c = this.config || {};

      // Server-controlled: developer selects the exact provider in AI Hub (ttsMode)
      const modeRaw = p.ttsMode || p.TtsMode || c.tts?.provider || "";

      return this._normalizeTtsProvider(modeRaw);
    },
    
    async ttsManaged(text) {
      await this.ensureSession("tts");
      await this.ensureProject();

      const p = this.project || {};
      const c = this.config || {};

      const provider = this._resolveTtsProvider();
      const activeLang = this._getActiveLanguageNameOrCode();
      const serverLang = this._getServerLanguageKey();
      this.log("TTS route:", {
        provider,
        activeLang,
        serverLang,
        ttsMode: p.ttsMode || p.TtsMode || "",
        ttsArabicProvider: p.ttsArabicProvider || p.TtsArabicProvider || "",
      });

      const endpointPathByProvider = {
        openai: "/api/tts-open-ai-managed",
        elevenlabs: "/api/tts-11-labs-managed",
        gemini: "/api/tts-google-pro",
        google:
          c.endpoints && c.endpoints.tts
            ? c.endpoints.tts
            : "/api/tts-google-managed",
      };

      const endpointPath =
        endpointPathByProvider[provider] || endpointPathByProvider.google;
      const url = `${this.config.baseUrl}${endpointPath}`;

      const t = String(text || "").trim();
      if (!t) throw new Error("TTS text is empty");

      let body = {};

      if (provider === "openai") {
        const voice =
          (p.openAIVoiceModel || p.OpenAIVoiceModel || "").trim() || "nova";
        const speed = Number(p.ttsSpeed ?? c.tts?.speed ?? 1.0);
        body = { text: t, voice, speed: Number.isFinite(speed) ? speed : 1.0 };
      } else if (provider === "elevenlabs") {
        const model_id = (
          p.tts_11labs_model_id ||
          p.tts11labsModelId ||
          "eleven_multilingual_v2"
        ).trim();
        const voiceId = (
          p.tts_11labs_voice_id ||
          p.tts11labsVoiceId ||
          ""
        ).trim();
        if (!voiceId)
          throw new Error(
            "ElevenLabs TTS selected but project missing tts_11labs_voice_id",
          );

        const voice_settings = {
          stability: 0.4,
          similarity_boost: 0.85,
          style: 0.0,
          use_speaker_boost: true,
        };

        body = { text: t, model_id, voiceId, voice_settings };
      } else if (provider === "gemini") {
        // { text, voiceName = "Kore" }
        const voiceName = (
          p.geminiProTTSVoice ||
          p.GeminiProTTSVoice ||
          "Kore"
        ).trim();
        body = { text: t, voiceName };
      } else {
        const languageCode = this._guessLanguageCodeBcp47();
        const voiceName =
          (
            p.googleTTSVoice ||
            p.voiceName ||
            p.ttsVoiceName ||
            c.tts?.voiceName ||
            ""
          ).trim() || `${languageCode}-Standard-B`;

        const speakingRate = Number(
          p.speakingRate ?? p.ttsSpeed ?? c.tts?.speed ?? 1.0,
        );
        body = {
          text: t,
          languageCode,
          voiceName,
          speakingRate: Number.isFinite(speakingRate) ? speakingRate : 1.0,
        };
      }

      this.log("TTS:", {
        provider,
        endpointPath,
        voice: body.voice || body.voiceName || body.voiceId || "",
      });

      const r = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${this.token}`,
          projectid: this.config.projectId,
        },
        body: JSON.stringify(body),
      });

      const txt = await r.text();
      if (!r.ok) throw new Error(`tts failed (${r.status}): ${txt}`);

      let data;
      try {
        data = JSON.parse(txt);
      } catch {
        throw new Error(`tts non-json: ${txt.slice(0, 200)}`);
      }

      const audioUrl = data?.audioURL || data?.audioUrl || data?.url || "";
      if (!audioUrl) throw new Error("TTS returned no audioURL");
      return String(audioUrl);
    },

    async voiceTurn(audioBlob) {
      try {
        this.emit("mic:state", { state: "transcribing" });
        this._sendToUnity(this.unity.onThinkingStartMethod, "");
        const userText = await this.transcribeManaged(audioBlob);
        this.emit("chat:user", { text: userText });

        this.emit("mic:state", { state: "thinking" });
        const g = await this.gpt(userText, { emitChat: false });
        
        const assistantText = String(g?.text || "").trim();
        if (assistantText) this.emit("chat:assistant", { text: assistantText });

        if (!assistantText) {
          this.emit("mic:state", { state: "idle" });
          return { ok: true, userText, assistantText: "" };
        }

        this._sendToUnity(this.unity.onThinkingStopMethod, "");

        const audioUrl = await this.ttsManaged(assistantText);
        await this.playAudioUrl(audioUrl);

        return { ok: true, userText, assistantText };
      } catch (e) {
        this.emit("mic:state", { state: "idle" });
        this._bridgeError(e);
        throw e;
      }
    },
  };

  window.AIHubBridge = Bridge;
})();
