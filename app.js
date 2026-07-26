import { SESSION, sampleLatency, mulberry32 } from './session.js';
import { VAD, LatencyBudget, FlowControl } from './vad.js';

const $ = (s) => document.querySelector(s);
const FRAME_MS = 20;

let running = false;
let t = 0;                 // stream time, seconds
let raf = null;
let lastTick = 0;
let rng = mulberry32(7);
let budget = new LatencyBudget();
let flow = new FlowControl();
let vad = new VAD();
let wire = [];
let finals = [];
let interim = '';
let speaking = false;
let frames = 0;
let frameAcc = 0;   // sub-frame remainder carried across animation ticks
let bytes = 0;
let micStream = null;
let audioCtx = null;
let liveDb = -80;
let mode = 'replay';
let rate = 1.0;

// ------------------------------------------------------------------ wire log
function emit(msg) {
  wire.unshift({ ...msg, t: t.toFixed(2) });
  if (wire.length > 60) wire.pop();
}

function metadataFrame() {
  return {
    type: 'Metadata',
    request_id: 'e3a1c9f4-7b02-4d51-9c88-2f0a5b6d1e77',
    model_info: { name: SESSION.model, arch: 'nova' },
    sample_rate: SESSION.sampleRate,
    encoding: SESSION.encoding,
    channels: SESSION.channels,
  };
}

function resultsFrame({ transcript, words, isFinal, speechFinal, latencyMs }) {
  return {
    type: 'Results',
    is_final: isFinal,
    speech_final: !!speechFinal,
    duration: +(t).toFixed(2),
    latency_ms: Math.round(latencyMs),
    channel: {
      alternatives: [
        {
          transcript,
          confidence: words && words.length
            ? +(words.reduce((s, w) => s + w.c, 0) / words.length).toFixed(3)
            : 0.0,
          words: words ? words.map((w) => ({ word: w.w, start: w.s, end: w.e, confidence: w.c })) : [],
        },
      ],
    },
  };
}

// ------------------------------------------------------------------ replay tick
function stepReplay(dt) {
  const prev = t;
  t += dt;

  // 20ms frames of "audio" arrive; each costs a decoder latency sample.
  // A rAF delta is ~16ms, shorter than one frame, so the remainder has to carry
  // across ticks — flooring each delta on its own drops nearly every frame.
  frameAcc += (t - prev) * 1000;
  const newFrames = Math.floor(frameAcc / FRAME_MS);
  frameAcc -= newFrames * FRAME_MS;
  for (let i = 0; i < newFrames; i++) {
    frames++;
    bytes += (SESSION.sampleRate * 2 * FRAME_MS) / 1000; // linear16 = 2 bytes/sample
    budget.add(sampleLatency(rng));
    // Streaming faster than realtime fills the decode queue.
    flow.enqueue(rate > 1.05 ? 1 : 0);
    if (rng() < 0.55) flow.drain(1);
  }

  for (const u of SESSION.utterances) {
    // speech start
    if (prev < u.start && t >= u.start) {
      speaking = true;
      emit({ type: 'SpeechStarted', channel: [0], timestamp: +u.start.toFixed(2) });
    }
    // interim hypotheses
    for (const it of u.interims) {
      if (prev < it.at && t >= it.at) {
        interim = it.text;
        const partialWords = u.words.filter((w) => w.e <= it.at);
        emit(resultsFrame({ transcript: it.text, words: partialWords, isFinal: false, latencyMs: budget.pct(50) }));
      }
    }
    // endpoint -> final
    if (prev < u.endpointAt && t >= u.endpointAt) {
      speaking = false;
      interim = '';
      finals.push({ text: u.final, words: u.words, start: u.start, end: u.endpointAt });
      emit(resultsFrame({ transcript: u.final, words: u.words, isFinal: true, speechFinal: true, latencyMs: budget.pct(95) }));
      emit({ type: 'UtteranceEnd', channel: [0], last_word_end: +u.words[u.words.length - 1].e.toFixed(2) });
    }
  }

  const last = SESSION.utterances[SESSION.utterances.length - 1];
  if (t > last.endpointAt + 1.4) {
    emit({ type: 'Metadata', request_id: 'e3a1c9f4', duration: +t.toFixed(2), channels: 1, models: [SESSION.model] });
    stop();
  }
}

// ------------------------------------------------------------------ live mic
async function startMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    $('#micNote').textContent = 'Microphone unavailable (' + e.name + ') — staying on the canned session.';
    mode = 'replay';
    renderControls();
    return;
  }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  const src = audioCtx.createMediaStreamSource(micStream);
  const proc = audioCtx.createScriptProcessor(1024, 1, 1);
  const buf = [];
  proc.onaudioprocess = (e) => {
    if (!running || mode !== 'live') return;
    const ch = e.inputBuffer.getChannelData(0);
    const per = Math.floor((audioCtx.sampleRate * FRAME_MS) / 1000);
    for (let i = 0; i < ch.length; i++) buf.push(ch[i]);
    while (buf.length >= per) {
      const frame = buf.splice(0, per);
      const r = vad.push(frame);
      liveDb = r.db;
      frames++;
      bytes += per * 2;
      budget.add(sampleLatency(rng));
      if (r.event === 'speech_start') {
        speaking = true;
        emit({ type: 'SpeechStarted', channel: [0], timestamp: +t.toFixed(2), rms_db: +r.db.toFixed(1), noise_floor_db: +r.noiseFloor.toFixed(1) });
      }
      if (r.event === 'speech_end') {
        speaking = false;
        emit({ type: 'UtteranceEnd', channel: [0], timestamp: +t.toFixed(2), hangover_ms: vad.hangoverMs });
      }
    }
  };
  src.connect(proc);
  proc.connect(audioCtx.destination);
  $('#micNote').textContent = 'Live capture: the VAD, noise floor and endpointing below are running on your actual microphone.';
}

function stopMic() {
  if (micStream) micStream.getTracks().forEach((tr) => tr.stop());
  if (audioCtx) audioCtx.close();
  micStream = null; audioCtx = null;
}

// ------------------------------------------------------------------ loop
function tick(now) {
  if (!running) return;
  const dt = Math.min(0.1, (now - lastTick) / 1000) * (mode === 'replay' ? rate : 1);
  lastTick = now;
  if (mode === 'replay') stepReplay(dt);
  else t += dt;
  render();
  raf = requestAnimationFrame(tick);
}

function start() {
  reset();
  running = true;
  emit(metadataFrame());
  if (mode === 'live') startMic();
  lastTick = performance.now();
  raf = requestAnimationFrame(tick);
  renderControls();
}

function stop() {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  stopMic();
  renderControls();
  render();
}

function reset() {
  t = 0; frames = 0; frameAcc = 0; bytes = 0; wire = []; finals = []; interim = ''; speaking = false;
  rng = mulberry32(7);
  budget = new LatencyBudget();
  flow = new FlowControl();
  vad = new VAD();
  liveDb = -80;
}

// ------------------------------------------------------------------ render
function renderControls() {
  $('#controls').innerHTML = `
    <button class="primary" id="btnRun">${running ? 'Stop stream' : 'Open stream'}</button>
    <select id="mMode" ${running ? 'disabled' : ''}>
      <option value="replay" ${mode === 'replay' ? 'selected' : ''}>Canned session (deterministic)</option>
      <option value="live" ${mode === 'live' ? 'selected' : ''}>Live microphone (real VAD)</option>
    </select>
    ${mode === 'replay' ? `<label class="fld" style="flex-direction:row;align-items:center;gap:8px;text-transform:none;letter-spacing:0">
      <span>stream rate</span>
      <input type="range" id="mRate" min="0.5" max="3" step="0.1" value="${rate}" style="width:110px">
      <span class="mono" style="color:var(--ink)">${rate.toFixed(1)}x</span>
    </label>` : ''}`;

  $('#btnRun').addEventListener('click', () => (running ? stop() : start()));
  const ms = $('#mMode');
  if (ms) ms.addEventListener('change', (e) => { mode = e.target.value; $('#micNote').textContent = ''; reset(); render(); renderControls(); });
  const mr = $('#mRate');
  if (mr) mr.addEventListener('input', (e) => { rate = parseFloat(e.target.value); renderControls(); });
}

function renderMetrics() {
  const p50 = budget.pct(50), p95 = budget.pct(95), p99 = budget.pct(99);
  const tiles = [
    { k: 'Stream time', v: t.toFixed(2) + 's', sub: `${frames} frames @ ${FRAME_MS}ms`, cls: '' },
    { k: 'Audio in', v: (bytes / 1024).toFixed(0) + ' KiB', sub: `${SESSION.encoding} ${SESSION.sampleRate}Hz`, cls: '' },
    { k: 'p50 latency', v: p50.toFixed(0) + 'ms', sub: `mean ${budget.mean.toFixed(0)}ms`, cls: 'good' },
    { k: 'p95 latency', v: p95.toFixed(0) + 'ms', sub: 'budget 150ms', cls: p95 > 150 ? 'bad' : 'good' },
    { k: 'p99 latency', v: p99.toFixed(0) + 'ms', sub: 'budget 300ms', cls: p99 > 300 ? 'bad' : 'warn' },
    { k: 'Decode queue', v: String(flow.queue), sub: flow.paused ? 'BACKPRESSURE ON' : `peak ${flow.maxDepth}`, cls: flow.paused ? 'bad' : '' },
  ];
  $('#metrics').innerHTML = tiles
    .map((x) => `<div class="metric ${x.cls}"><div class="k">${x.k}</div><div class="v">${x.v}</div><div class="sub">${x.sub}</div></div>`)
    .join('');
}

function renderTranscript() {
  const finalHtml = finals
    .map((f) => `<div style="margin-bottom:12px">
        <div style="font-size:15px;line-height:1.55">${f.words
          .map((w) => {
            const a = w.c > 0.97 ? 1 : w.c > 0.93 ? 0.8 : 0.58;
            const under = w.c < 0.93 ? 'border-bottom:1.5px solid var(--amber)' : '';
            return `<span title="confidence ${w.c}" style="opacity:${a};${under}">${w.w}</span>`;
          })
          .join(' ')}</div>
        <div class="mono" style="font-size:10.5px;color:var(--ink-3);margin-top:3px">
          final · ${f.start.toFixed(2)}s–${f.end.toFixed(2)}s · avg conf ${(f.words.reduce((s, w) => s + w.c, 0) / f.words.length).toFixed(3)}
        </div>
      </div>`)
    .join('');

  const interimHtml = interim
    ? `<div style="font-size:15px;line-height:1.55;color:var(--ink-3);font-style:italic">${interim}<span class="caret">▌</span>
       <div class="mono" style="font-size:10.5px;color:var(--amber);margin-top:3px;font-style:normal">interim · not committed · may be revised</div></div>`
    : '';

  $('#transcript').innerHTML = finalHtml + interimHtml ||
    `<div class="empty">Open the stream to see interim hypotheses resolve into finals.</div>`;
}

function renderVadMeter() {
  const db = mode === 'live' ? liveDb : (speaking ? -22 + Math.sin(t * 9) * 5 : -58);
  const floor = mode === 'live' ? vad.noiseFloor : -60;
  const norm = Math.max(0, Math.min(1, (db + 70) / 70));
  const floorNorm = Math.max(0, Math.min(1, (floor + 70) / 70));
  $('#vad').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">
      <span class="pill ${speaking ? 'ok' : 'mute'}">${speaking ? 'speech' : 'silence'}</span>
      <span class="mono" style="font-size:11.5px;color:var(--ink-3)">${db.toFixed(1)} dBFS · floor ${floor.toFixed(1)} dBFS</span>
    </div>
    <div style="position:relative;height:14px;background:var(--bg-2);border-radius:4px;overflow:hidden;border:1px solid var(--line)">
      <div style="position:absolute;inset:0 auto 0 0;width:${norm * 100}%;background:linear-gradient(90deg,var(--accent-dim),var(--accent));transition:width .06s"></div>
      <div style="position:absolute;top:0;bottom:0;left:${floorNorm * 100}%;width:2px;background:var(--rose)"></div>
    </div>
    <div class="note" style="margin-top:9px">
      Gate opens at floor + ${vad.onsetDb} dB and holds at floor + ${vad.releaseDb} dB — hysteresis, so a
      speaker who drops volume mid-sentence is not clipped. An endpoint fires after
      ${vad.hangoverMs}ms below the hold threshold. The red mark is the adaptive noise floor,
      which only tracks while the gate is closed.
    </div>`;
}

function renderHistogram() {
  const h = budget.histogram(22, 240);
  const max = Math.max(...h, 1);
  $('#hist').innerHTML = `
    <div style="display:flex;align-items:flex-end;gap:2px;height:88px">
      ${h.map((v, i) => {
        const over = (i / 22) * 240 > 150;
        return `<div style="flex:1;height:${(v / max) * 100}%;min-height:${v ? 2 : 0}px;background:${over ? 'var(--rose)' : 'var(--accent-dim)'};border-radius:1px" title="${Math.round((i / 22) * 240)}ms — ${v}"></div>`;
      }).join('')}
    </div>
    <div class="mono" style="display:flex;justify-content:space-between;font-size:10px;color:var(--ink-3);margin-top:5px">
      <span>0ms</span><span>150ms budget</span><span>240ms+</span>
    </div>`;
}

function renderWire() {
  $('#wire').innerHTML = wire.length
    ? wire.map((m) => {
        const isFinal = m.type === 'Results' && m.is_final;
        const color = m.type === 'Results' ? (isFinal ? 'var(--accent)' : 'var(--ink-3)') : m.type === 'Metadata' ? 'var(--violet)' : 'var(--blue)';
        const compact = { ...m };
        delete compact.t;
        if (compact.channel && compact.channel.alternatives) {
          const alt = compact.channel.alternatives[0];
          compact.channel = { alternatives: [{ transcript: alt.transcript, confidence: alt.confidence, words: `[${alt.words.length} words]` }] };
        }
        return `<div style="padding:6px 0;border-bottom:1px solid var(--line)">
          <div class="mono" style="font-size:10.5px;color:${color};font-weight:600">${m.t}s  ${m.type}${isFinal ? ' (final)' : m.type === 'Results' ? ' (interim)' : ''}</div>
          <pre class="mono" style="margin:3px 0 0;font-size:10.5px;color:var(--ink-2);white-space:pre-wrap;word-break:break-word">${JSON.stringify(compact)}</pre>
        </div>`;
      }).join('')
    : `<div class="empty">No frames yet.</div>`;
}

function render() {
  renderMetrics();
  renderTranscript();
  renderVadMeter();
  renderHistogram();
  renderWire();
}

renderControls();
render();
window.asr = { VAD, LatencyBudget, FlowControl, SESSION };
