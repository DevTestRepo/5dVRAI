// webgl-live.js — TTS→viseme streaming to Unity (PCM24k scheduler + external visemes)
// Also fixes: (1) worklet register once, (2) stop playback reliably, (3) send true/false to Unity
import { GoogleGenAI } from "https://esm.sh/@google/genai@1.7.0";

// --- Barge-in control (add near other globals) ---
let _epoch = 0;                  // increments whenever we intentionally interrupt
let muteServerAudio = false;     // drop incoming audio while true
let squelchUntil = 0;            // drop incoming audio until this AudioContext time

function nextEpoch(reason = "") {
    _epoch++;
    // Hard-stop anything already scheduled
    try { (visemeTimers || []).splice(0).forEach(id => clearTimeout(id)); } catch { }
    try { (__audioSources || []).splice(0).forEach(s => { try { s.stop(0); s.disconnect(); } catch { } }); } catch { }
    // Reset scheduling cursor
    try { playbackCursor = audioCtx.currentTime + 0.02; } catch { }
    try { playbackCursor = audioCtx.currentTime + 0.02; } catch { }
    // REMOVED unsafe suspend/resume nudge
}

/* ----------------------- DOM helpers & UI ----------------------- */
const $ = (s) => document.querySelector(s);
const qs = new URLSearchParams(location.search);
function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "style") n.style.cssText = v;
        else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v);
    }
    for (const c of children) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return n;
}

/* ----------------------- HUD/Dev (kept compact) ----------------------- */
function ensureDevPanel() {
    let panel = $("#devPanel");
    if (!panel) {
        panel = el("div", {
            id: "devPanel",
            style: "position:fixed;top:0;bottom:0;left:0;width:360px;z-index:30;padding:14px;border-right:1px solid #e5e5e5;overflow:auto;background:#fff;display:none"
        }, [
            el("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px" }, [
                el("h3", {}, ["Gemini Live (Dev)"]),
                el("span", { id: "state", class: "pill", style: "padding:4px 8px;border-radius:999px;background:#eee;font-size:12px" }, ["disconnected"]),
            ]),
            el("div", { style: "margin-top:12px" }, [
                el("label", {}, ["System instruction"]),
                el("textarea", { id: "sys", rows: "5", style: "width:100%" }, []),
            ]),
            el("div", { style: "display:flex;gap:8px;align-items:center;margin-top:8px" }, [
                el("label", { for: "voice" }, ["Voice:"]),
                el("select", { id: "voice" }, [
                    el("option", { value: "Puck" }, ["Puck"]),
                    el("option", { value: "Charis" }, ["Charis"]),
                ]),
            ]),
            el("div", { style: "display:flex;gap:8px;align-items:center;margin-top:12px" }, [
                el("button", { id: "connectBtn" }, ["Connect"]),
                el("button", { id: "disconnectBtn", disabled: "true" }, ["Disconnect"]),
            ]),
            el("hr"),
            el("div", { style: "display:flex;gap:8px;align-items:center;margin-top:6px" }, [
                el("button", { id: "pttBtn", class: "ptt", disabled: "true" }, ["🎙️ Push to Talk (hold)"]),
                el("button", { id: "stopBtn", disabled: "true" }, ["⏹️ Stop playback"]),
            ]),
            el("div", { style: "display:flex;gap:8px;align-items:center;margin-top:6px" }, [
                el("input", { id: "textInput", type: "text", placeholder: "Type text for TTS…", style: "flex:1" }),
                el("button", { id: "textBtn", disabled: "true" }, ["🔊 Speak"]),
            ]),
            el("div", { style: "margin-top:8px" }, [
                el("div", { id: "log", style: "height:240px;overflow:auto;border:1px solid #e5e5e5;padding:8px;border-radius:8px;background:#fafafa" }, []),
            ]),
        ]);
        document.body.appendChild(panel);
    }
    return panel;
}
function ensureLogOverlay() {
    let hud = $("#logOverlay");
    if (!hud) {
        hud = el("div", {
            id: "logOverlay",
            style:
                "position:fixed;bottom:2px;left:50%;transform:translateX(-50%);z-index:999;" +
                "max-width:220px;width:90%;max-height:30vh;overflow:auto;" +
                "background:rgba(0,0,0,.8);border:1px solid #e6e6e6;border-radius:10px;padding:8px 10px;font-size:12px;color:white"
        });
        document.body.appendChild(hud);
    }
    return hud;
}
function pushLog(text) {
    const hud = ensureLogOverlay();
    const msg = el("div", {}, [String(text)]);
    hud.appendChild(msg.cloneNode(true));
    if (hud.childNodes.length > 1) hud.removeChild(hud.firstChild);
    const dev = $("#log");
    if (dev) { dev.appendChild(msg); dev.scrollTop = dev.scrollHeight; }
}
function setPill(el, text, cls = "") { if (!el) return; el.className = `pill ${cls}`.trim(); el.textContent = text; }
function setState(text, cls = "") { setPill($("#hudState"), text, cls); setPill($("#state"), text, cls); }
if (qs.get("dev") === "1") ensureDevPanel();

/* ----------------------- Unity bridge ----------------------- */
function sendUnity(evt, val) {
    const go = window.__unityReceiver || "WebGLBridge";
    try { window.unityInstance?.SendMessage(go, evt, String(val)); } catch { }
}
function setListening(on) { sendUnity("OnListening", on ? "true" : "false"); }
function setThinking(on) { sendUnity("OnThinking", on ? "true" : "false"); }
function setTalking(on) { sendUnity("OnTalking", on ? "true" : "false"); }
function sendViseme(o, f, p) { // compact JSON: {o,f,p}
    const payload = JSON.stringify({ o: Math.max(0, Math.min(1, o)), f: Math.max(0, Math.min(1, f)), p: Math.max(0, Math.min(1, p)) });
    sendUnity("OnViseme", payload);
}

/* ----------------------- Audio playback (PCM16@24k) ----------------------- */
const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
let playbackCursor = audioCtx.currentTime + 0.02;
const __audioSources = [];      // track sources so clearPlayback() can stop them
let visemeTimers = [];          // timers per scheduled viseme frame

function i16ToF32(i16) {
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = Math.max(-1, Math.min(1, i16[i] / 32768));
    return f32;
}

// Simple analysis per ~20ms: RMS (open) + zero-crossing (funnel/pucker proxy)
function analyzeVisemes(i16, sr = 24000, frameMs = 20) {
    const frameSamples = Math.floor(sr * frameMs / 1000);
    const hop = frameSamples; // 20ms hop = ~50 fps
    const C_LO = 0.12, C_HI = 0.15; // crude ZCR thresholds
    const frames = [];
    for (let i = 0; i + frameSamples <= i16.length; i += hop) {
        let sum = 0, zc = 0;
        let prev = i16[i];
        for (let j = 0; j < frameSamples; j++) {
            const v = i16[i + j];
            sum += (v * v);
            const s0 = prev >= 0, s1 = v < 0;
            if ((prev >= 0 && v < 0) || (prev < 0 && v >= 0)) zc++;
            prev = v;
        }
        const rms = Math.sqrt(sum / frameSamples) / 32768;           // 0..~1
        const open = Math.min(1, rms * 3.5);                          // gain
        const zcr = zc / frameSamples;                                 // ~0..0.5
        const funnel = Math.max(0, (zcr - C_LO) * 7.0) * open;         // "s/ʃ/ts" ish
        const pucker = Math.max(0, (C_HI - zcr) * 8.0) * open;         // rounded vowels
        frames.push({ o: open, f: funnel, p: pucker });
    }
    return frames;
}

function scheduleVisemes(i16, startAt) {
    const frames = analyzeVisemes(i16, 24000, 20);
    for (let i = 0; i < frames.length; i++) {
        const when = startAt + (i * 0.020); // 20ms/frame
        const delayMs = Math.max(0, (when - audioCtx.currentTime) * 1000);
        const { o, f, p } = frames[i];
        const t = setTimeout(() => sendViseme(o, f, p), delayMs | 0);
        visemeTimers.push(t);
    }
}

function schedulePCM24k(i16) {
    if (!i16?.length) return;
    if (!schedulePCM24k._started) { schedulePCM24k._started = true; setThinking(false); setTalking(true); }
    const f32 = i16ToF32(i16);
    const buf = audioCtx.createBuffer(1, f32.length, 24000); buf.copyToChannel(f32, 0);
    const src = audioCtx.createBufferSource(); src.buffer = buf; src.connect(audioCtx.destination);
    const startAt = Math.max(playbackCursor, audioCtx.currentTime + 0.02);
    src.start(startAt);
    __audioSources.push(src);
    scheduleVisemes(i16, startAt); // stream visemes in sync with playback

    playbackCursor = startAt + buf.duration;
    src.onended = () => {
        clearTimeout(schedulePCM24k._endT);
        schedulePCM24k._endT = setTimeout(() => {
            if (audioCtx.currentTime >= playbackCursor - 0.05) {
                schedulePCM24k._started = false; setTalking(false);
            }
        }, 150);
    };
}

function clearPlayback() {
    return;
    // --- ensure globals exist (won't overwrite if already defined) ---
    if (typeof window._epoch !== "number") window._epoch = 0;
    if (typeof window.muteServerAudio === "undefined") window.muteServerAudio = false;

    // bump epoch so any late packets are ignored by your schedulers
    window._epoch++;

    // stop all viseme timers + audio sources
    try {
        if (Array.isArray(visemeTimers)) visemeTimers.splice(0).forEach(id => clearTimeout(id));
        if (Array.isArray(__audioSources)) __audioSources.splice(0).forEach(s => { try { s.stop(0); s.disconnect(); } catch { } });
    } catch { }

    // swallow stragglers for a short guard window
    window.muteServerAudio = true;
    setTimeout(() => { window.muteServerAudio = false; }, 200);

    // nudge context (clears any tail), reset scheduler cursor
    // REMOVED unsafe suspend/resume nudge
    try { playbackCursor = audioCtx.currentTime + 0.02; } catch { playbackCursor = 0; }

    // reset talk flag / internal started flag
    try { schedulePCM24k._started = false; } catch { }
    try { setTalking(false); } catch { }
}

/* ----------------------- Binary & resample helpers ----------------------- */
const b64ToBytes = (b) => Uint8Array.from(atob(b), c => c.charCodeAt(0));
const bytesToB64 = (u) => { let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
function float32ToPCM16LE(f32) { const i16 = new Int16Array(f32.length); for (let i = 0; i < f32.length; i++) { let v = Math.max(-1, Math.min(1, f32[i])); i16[i] = v < 0 ? v * 0x8000 : v * 0x7FFF; } return i16; }
function resampleLinearFloat32(input, inRate, outRate) {
    if (inRate === outRate) return input;
    const ratio = inRate / outRate, outLen = Math.floor(input.length / ratio), out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) { const idx = i * ratio, i0 = Math.floor(idx), i1 = Math.min(i0 + 1, input.length - 1), t = idx - i0; out[i] = (1 - t) * input[i0] + t * input[i1]; }
    return out;
}
function normalizeRMS(f32, targetRMS = 0.25) {
    if (!f32.length) return f32;
    let sum = 0, peak = 0; for (let i = 0; i < f32.length; i++) { const v = f32[i]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
    const rms = Math.sqrt(sum / f32.length) || 0;
    if (rms <= 1e-6) return f32;
    let g = targetRMS / rms;
    if (peak * g > 0.99) g = 0.99 / peak;
    g = Math.min(g, 6);
    const out = new Float32Array(f32.length);
    for (let i = 0; i < f32.length; i++) out[i] = Math.max(-1, Math.min(1, f32[i] * g));
    return out;
}

/* ----------------------- Live session + handlers ----------------------- */
let genAI = null, session = null, connected = false, connecting = false, serverReady = false;

function captureAudioFromObject(msg) {
    const pushInline = (inline) => {
        if (!inline) return;
        const mt = inline.mimeType || inline.mime_type || '';
        if (inline.data && mt.startsWith('audio/')) {
            const u8 = b64ToBytes(inline.data);
            if (!u8.byteLength) return;
            const i16 = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
            schedulePCM24k(i16);
        }
    };
    const pushData = (data) => {
        if (typeof data === 'string' && data) {
            const u8 = b64ToBytes(data);
            if (!u8.byteLength) return;
            const i16 = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
            schedulePCM24k(i16);
        }
    };

    const ro = msg?.realtimeOutput;
    if (ro) {
        pushInline(ro.outputAudio?.inlineData);
        if (Array.isArray(ro.modelTurn?.parts)) for (const p of ro.modelTurn.parts) pushInline(p?.inlineData || p?.inline_data);
        if (ro.audio?.data) pushData(ro.audio.data);
    }
    const m = msg?.message;
    if (typeof m?.data === 'string') pushData(m.data);
    else if (Array.isArray(m?.data)) for (const p of m.data) {
        if (typeof p === 'string') pushData(p);
        else { pushInline(p?.inlineData || p?.inline_data); if (p?.data && !p?.inlineData && !p?.inline_data) pushData(p.data); }
    }
    if (typeof msg?.data === 'string') pushData(msg.data);
    else if (Array.isArray(msg?.data)) for (const p of msg.data) {
        if (typeof p === 'string') pushData(p);
        else { pushInline(p?.inlineData || p?.inline_data); if (p?.data && !p?.inlineData && !p?.inline_data) pushData(p.data); }
    }
    const sc = msg?.serverContent || msg?.server_message;
    if (Array.isArray(sc?.modelTurn?.parts)) for (const p of sc.modelTurn.parts) pushInline(p?.inlineData || p?.inline_data);
    pushInline(msg?.outputAudio?.inlineData);
}

function handleIncoming(payload) {
    // Guard #1: drop everything while muted (PTT held or immediate aftermath)
    if (muteServerAudio) return;

    const now = audioCtx?.currentTime || 0;
    // Guard #2: drop stragglers during the post-PTT squelch window
    if (now < squelchUntil) return;

    // Helper to push audio with current epoch tag
    const tag = _epoch;
    const pushInline = (inline) => {
        if (!inline) return;
        const mt = inline.mimeType || inline.mime_type || '';
        if (inline.data && mt.startsWith('audio/')) {
            const u8 = Uint8Array.from(atob(inline.data), c => c.charCodeAt(0));
            if (!u8.byteLength) return;
            const i16 = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
            if (tag !== _epoch) return;         // epoch changed while parsing
            schedulePCM24k(i16);                // will be cleared on nextEpoch()
        }
    };

    const pushData = (data) => {
        if (typeof data !== 'string' || !data) return;
        const u8 = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        if (!u8.byteLength) return;
        const i16 = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
        if (tag !== _epoch) return;
        schedulePCM24k(i16);
    };

    // Existing branches (unchanged except they call pushInline/pushData)
    try {
        if (typeof payload === "string") {
            try { const obj = JSON.parse(payload); captureAudioFromObject(obj); }
            catch { pushData(payload); }
            return;
        }
        if (payload instanceof Blob) {
            payload.arrayBuffer().then(buf => {
                try {
                    const txt = new TextDecoder().decode(buf);
                    try { const obj = JSON.parse(txt); captureAudioFromObject(obj); }
                    catch { pushData(txt); }
                } catch { }
            });
            return;
        }
        if (payload instanceof ArrayBuffer) {
            try {
                const txt = new TextDecoder().decode(payload);
                try { const obj = JSON.parse(txt); captureAudioFromObject(obj); }
                catch { pushData(txt); }
            } catch { }
            return;
        }

        // Generic object (Gemini live JSON shapes)
        const ro = payload?.realtimeOutput;
        if (ro) {
            pushInline(ro.outputAudio?.inlineData);
            if (Array.isArray(ro.modelTurn?.parts)) for (const p of ro.modelTurn.parts) pushInline(p?.inlineData || p?.inline_data);
            if (ro.audio?.data) pushData(ro.audio.data);
        }
        const m = payload?.message;
        if (typeof m?.data === 'string') pushData(m.data);
        else if (Array.isArray(m?.data)) for (const p of m.data) {
            if (typeof p === 'string') pushData(p);
            else { pushInline(p?.inlineData || p?.inline_data); if (p?.data && !p?.inlineData && !p?.inline_data) pushData(p.data); }
        }
        if (typeof payload?.data === 'string') pushData(payload.data);
        else if (Array.isArray(payload?.data)) for (const p of payload.data) {
            if (typeof p === 'string') pushData(p);
            else { pushInline(p?.inlineData || p?.inline_data); if (p?.data && !p?.inlineData && !p?.inline_data) pushData(p.data); }
        }
        const sc = payload?.serverContent || payload?.server_message;
        if (Array.isArray(sc?.modelTurn?.parts)) for (const p of sc.modelTurn.parts) pushInline(p?.inlineData || p?.inline_data);
        pushInline(payload?.outputAudio?.inlineData);
    } catch (e) {
        // swallow malformed frames
    }
}

/* ----------------------- Mic capture (streaming 16k) ----------------------- */
let mediaStream = null, workletNode = null, mediaSource = null, micRate = 48000;
let streamBuffer = []; // Array of Float32Arrays (incoming chunks)
let streamBufferFrames = 0;
const STREAM_INTERVAL_MS = 200; // Emit approx every 200ms
let pttDown = false;
window.__micWorkletLoaded = window.__micWorkletLoaded || false;

async function prepareMicPCM() {
    micRate = audioCtx.sampleRate;
    if (!mediaStream) {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
        });
    }
    if (!window.__micWorkletLoaded) {
        const workletCode = `
      class MicCaptureProcessor extends AudioWorkletProcessor {
        process(inputs){ const i=inputs[0]; if (i && i[0]?.length) this.port.postMessage(i[0]); return true; }
      } registerProcessor('mic-capture', MicCaptureProcessor);
    `;
        const url = URL.createObjectURL(new Blob([workletCode], { type: 'text/javascript' }));
        await audioCtx.audioWorklet.addModule(url);
        window.__micWorkletLoaded = true;
    }
    mediaSource = audioCtx.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioCtx, 'mic-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    mediaSource.connect(workletNode);
    workletNode.port.onmessage = (e) => {
        if (!pttDown) return;
        const f32 = e.data;
        if (f32 && f32.length) {
            streamBuffer.push(f32);
            streamBufferFrames += f32.length;
            // Rough check: if we have ~200ms of data, emit
            // micRate is e.g. 48000, so 200ms = 9600 frames
            if (streamBufferFrames >= (micRate * STREAM_INTERVAL_MS / 1000)) {
                flushMicStream();
            }
        }
    };
}

/* ----------------------- Streaming Helpers ----------------------- */
async function flushMicStream(isLast = false) {
    // Case 1: Buffer is empty.
    if (streamBufferFrames === 0) {
        // If this was supposed to be the "End of Turn", we still MUST send the signal.
        if (isLast) {
            try {
                await session.sendRealtimeInput({ turnComplete: true });
                pushLog("✅ turn complete (no pending audio)");
            } catch (e) {
                pushLog("⚠️ send turnComplete error: " + (e?.message || e));
            }
        }
        return;
    }

    // 1. Merge all buffered worklet chunks
    const totalLen = streamBufferFrames;
    const raw = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of streamBuffer) {
        raw.set(chunk, offset);
        offset += chunk.length;
    }
    // Clear buffer immediately
    streamBuffer = [];
    streamBufferFrames = 0;

    // 2. Process (Resample -> Normalize -> B64) within a try-block
    try {
        let mono16k = resampleLinearFloat32(raw, micRate, 16000);
        // Mild normalization per chunk
        mono16k = normalizeRMS(mono16k, 0.25);

        const i16 = float32ToPCM16LE(mono16k);
        const u8 = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);
        const b64 = bytesToB64(u8);

        // 3. Send audio AND turnComplete in the same payload if isLast is true
        const payload = {
            audio: { data: b64, mimeType: "audio/pcm;rate=16000" }
        };

        if (isLast) {
            payload.turnComplete = true;
        }

        await session.sendRealtimeInput(payload);

        if (isLast) pushLog("✅ turn complete (with audio)");

    } catch (e) {
        pushLog("⚠️ stream chunk failed: " + (e?.message || e));
        // Fallback: If audio processing failed but this was the end, try to force turn completion
        if (isLast) {
            try { await session.sendRealtimeInput({ turnComplete: true }); } catch { }
        }
    }
}

async function runTextTurn(text) {
    try {
        await session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
    } catch (e) {
        pushLog("⚠️ text turn failed: " + (e?.message || e));
    }
}

/* ----------------------- Connect / Disconnect & controls ----------------------- */
window.GL_Connect = async function () {
    if (connecting || connected) return;
    try {
        connecting = true;
        setState("auth…", "warn");
        pushLog("🔐 getting ephemeral token…");

        const sysEl = $("#sys");
        const sysText = (sysEl?.value || "You are a friendly, concise assistant for realtime avatars. Keep answers short unless asked.").trim();
        const voiceEl = $("#voice");
        const voiceName = (voiceEl?.value || "Puck");

        await audioCtx.resume();

        const r = await fetch("/api/gemini-live-ephemeral", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ voiceName, mode: "pcm-burst" })
        });
        if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`ephemeral endpoint HTTP ${r.status} ${r.statusText} ${t ? ("- " + t) : ""}`); }
        const { client_secret, model } = await r.json();

        // ---- Keep-Alive: Force context to stay running with a silent oscillator ----
        try {
            if (!window._keepAliveOsc) {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'triangle';
                osc.frequency.value = 100; // arbitrary
                gain.gain.value = 0.001; // nearly silent, but non-zero to prevent optimizations? 
                // actually, 0 gain is often optimized out. let's use 0.0001
                gain.gain.value = 0.0; // safest silent
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start();
                window._keepAliveOsc = osc;
            }
        } catch { }

        await prepareMicPCM();

        const modelName = model || "gemini-2.5-flash-native-audio-preview-09-2025";
        pushLog(`🔌 connecting live session (${modelName})…`);

        genAI = new GoogleGenAI({ apiKey: client_secret, apiVersion: "v1alpha" });

        session = await genAI.live.connect({
            model: modelName,
            config: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
                inputAudioFormat: { mimeType: "audio/pcm;rate=16000", sampleRateHertz: 16000, channelCount: 1 },
                outputAudioFormat: { mimeType: "audio/pcm", sampleRateHertz: 24000, channelCount: 1 },
                systemInstruction: sysText,
                turnDetection: { type: "none" }
            },
            callbacks: {
                onopen: () => {
                    connected = true;
                    setState("connected", "ok");
                    pushLog("🟢 websocket open");
                    $("#disconnectBtn")?.removeAttribute("disabled");
                    $("#pttBtn")?.removeAttribute("disabled");
                    $("#textBtn")?.removeAttribute("disabled");
                    $("#stopBtn")?.removeAttribute("disabled");
                },
                onerror: (e) => { setState("error", "err"); pushLog("❌ live error " + (e?.message || "")); },
                onclose: (ev) => {
                    setState("disconnected");
                    const code = ev?.code ?? ""; const reason = ev?.reason || "";
                    pushLog(`🔒 websocket closed (code=${code}${reason ? ` reason=${reason}` : ""})`);
                    connected = false; serverReady = false; setListening(false); setThinking(false); setTalking(false);
                },
                onmessage: (ev) => {
                    const payload = (ev && 'data' in ev) ? ev.data : ev;
                    handleIncoming(payload);
                    if (!serverReady) {
                        serverReady = true;
                        pushLog("🟢 server ready");
                    }
                }
            }
        });

        pushLog("🟢 connected — low-latency streaming");
    } catch (e) {
        pushLog("❌ connect failed: " + (e?.message || e));
        setState("disconnected");
    } finally {
        connecting = false;
    }
};

window.GL_Disconnect = async function () {
    try {
        visemeTimers.splice(0).forEach(id => clearTimeout(id));
        __audioSources.splice(0).forEach(s => { try { s.stop(0); s.disconnect(); } catch { } });
        if (workletNode) { workletNode.port.onmessage = null; try { workletNode.disconnect(); } catch { } workletNode = null; }
        if (mediaSource) { try { mediaSource.disconnect(); } catch { } mediaSource = null; }
        if (mediaStream) { try { mediaStream.getTracks().forEach(t => t.stop()); } catch { } mediaStream = null; }
        if (session?.close) await session.close();
    } finally {
        connected = false; serverReady = false; pttDown = false;
        $("#disconnectBtn")?.setAttribute("disabled", "true");
        $("#pttBtn")?.setAttribute("disabled", "true");
        $("#textBtn")?.setAttribute("disabled", "true");
        $("#stopBtn")?.setAttribute("disabled", "true");
        setState("disconnected");
        pushLog("🔌 disconnected");
    }
};

window.GL_StartPTT = async function () {
    if (!connected) return;
    await audioCtx.resume();

    // ---- BARGE-IN: kill any ongoing playback + visemes, and gate server audio ----
    // bump epoch so any late chunks from previous turn are ignored
    window._epoch = (typeof window._epoch === "number" ? window._epoch : 0) + 1;

    // stop scheduled visemes + audio sources
    try {
        if (Array.isArray(visemeTimers)) visemeTimers.splice(0).forEach(id => clearTimeout(id));
        if (Array.isArray(__audioSources)) __audioSources.splice(0).forEach(s => { try { s.stop(0); s.disconnect(); } catch { } });
    } catch { }

    // reset scheduler state (and nudge context to clear residual tail)
    // reset scheduler state (and nudge context to clear residual tail)
    try { schedulePCM24k._started = false; } catch { }
    // REMOVED: audioCtx.suspend() hack - it can leave the context stalled.
    // Ensure we are running instead:
    try { if (audioCtx.state === 'suspended') audioCtx.resume(); } catch { }

    try { playbackCursor = audioCtx.currentTime + 0.02; } catch { }

    // gate incoming server audio while PTT is down
    window.muteServerAudio = true;
    window.squelchUntil = Number.POSITIVE_INFINITY; // stay squelched until GL_EndPTT opens it

    // best-effort server-side cancel (safe no-ops if not supported)
    try { session?.sendClientEvent?.({ event: "response.cancel" }); } catch { }
    try { session?.cancelResponse?.(); } catch { }
    try { session?.stop?.(); } catch { }

    // ---- Mic state ----
    pttDown = true;
    streamBuffer = []; streamBufferFrames = 0; // reset streamer


    setListening(true);
    setThinking(false);
    setTalking(false);

    pushLog("🎙️ speaking… (PTT)");
};

window.GL_EndPTT = async function () {
    if (!pttDown || !connected) return;

    pttDown = false;
    setListening(false);
    setThinking(true);

    // Unmute immediately so we don't miss the start of the response
    muteServerAudio = false;
    squelchUntil = 0;

    // Flush remaining audio AND signal "Turn Complete" in a single atomic message
    await flushMicStream(true);

    pushLog("🛑 mic idle");
};

window.GL_SpeakText = function (t) {
    if (!connected) return;
    const text = String(t || "").trim() || "Hello, how are you?";
    setThinking(true); setTalking(false);
    visemeTimers.splice(0).forEach(id => clearTimeout(id));
    __audioSources.splice(0).forEach(s => { try { s.stop(0); s.disconnect(); } catch { } });
    //pushLog('📝 sending text turn: "' + text + '"');
    runTextTurn(text);
};

/* Dev controls mirror */
function bindUiButtons() {
    $("#connectBtn")?.addEventListener("click", () => window.GL_Connect());
    $("#disconnectBtn")?.addEventListener("click", () => window.GL_Disconnect());
    $("#pttBtn")?.addEventListener("pointerdown", () => window.GL_StartPTT());
    $("#pttBtn")?.addEventListener("pointerup", () => window.GL_EndPTT());
    $("#stopBtn")?.addEventListener("click", () => { clearPlayback(); pushLog("⏹️ cleared"); });
    $("#textBtn")?.addEventListener("click", () => { const t = $("#textInput")?.value?.trim(); if (!t) return; window.GL_SpeakText(t); });
}
bindUiButtons();

/* ExternalEval helpers for Unity */
window.GL_Setup = function (systemInstruction, voice) {
    const p = ensureDevPanel();
    p.style.display = qs.get("dev") === "1" ? "block" : p.style.display;
    if (typeof systemInstruction === "string") { const sys = $("#sys"); if (sys) sys.value = systemInstruction; }
    if (typeof voice === "string") { const v = $("#voice"); if (v) v.value = voice; }
};
window.GL_ShowDev = function (show) { const p = ensureDevPanel(); p.style.display = show ? "block" : "none"; };

/* Unlock AudioContext on first gesture */
window.addEventListener("click", () => audioCtx.resume(), { once: true });
window.addEventListener("touchstart", () => audioCtx.resume(), { once: true });

/* Boot log */
if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", () => pushLog("WebGL live bridge ready."));
} else {
    pushLog("WebGL live bridge ready.");
}
