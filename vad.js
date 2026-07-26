// Voice activity detection and endpointing.
//
// This runs for real on live microphone audio: frame energy in dBFS, an adaptive
// noise floor, a hysteresis gate, and a hangover timer that decides when an
// utterance has ended. Endpointing is the part of a streaming ASR API that users
// actually feel — cut it too early and you truncate the speaker, too late and the
// interaction drags.

export class VAD {
  constructor({ frameMs = 20, onsetDb = 6, releaseDb = 3, hangoverMs = 420, minSpeechMs = 120 } = {}) {
    this.frameMs = frameMs;
    this.onsetDb = onsetDb;       // dB above the noise floor to open the gate
    this.releaseDb = releaseDb;   // dB above the floor to keep it open (hysteresis)
    this.hangoverMs = hangoverMs; // trailing silence before we declare an endpoint
    this.minSpeechMs = minSpeechMs;

    this.noiseFloor = -60;
    this.state = 'silence';
    this.silenceMs = 0;
    this.speechMs = 0;
    this.frames = 0;
  }

  static rmsDb(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(samples.length, 1));
    return 20 * Math.log10(Math.max(rms, 1e-8));
  }

  /**
   * Push one frame. Returns { db, state, event } where event is one of
   * null | 'speech_start' | 'speech_end'.
   */
  push(samples) {
    const db = VAD.rmsDb(samples);
    this.frames++;

    // Track the noise floor only while the gate is closed, and only downward
    // quickly — a fast upward adaptation would let steady speech raise the floor
    // and gate itself off mid-utterance.
    if (this.state === 'silence') {
      const alpha = db < this.noiseFloor ? 0.25 : 0.02;
      this.noiseFloor = this.noiseFloor * (1 - alpha) + db * alpha;
    }

    const openThresh = this.noiseFloor + this.onsetDb;
    const holdThresh = this.noiseFloor + this.releaseDb;
    let event = null;

    if (this.state === 'silence') {
      if (db > openThresh) {
        this.speechMs += this.frameMs;
        if (this.speechMs >= this.minSpeechMs) {
          this.state = 'speech';
          this.silenceMs = 0;
          event = 'speech_start';
        }
      } else {
        this.speechMs = 0;
      }
    } else {
      if (db > holdThresh) {
        this.silenceMs = 0;
        this.speechMs += this.frameMs;
      } else {
        this.silenceMs += this.frameMs;
        if (this.silenceMs >= this.hangoverMs) {
          this.state = 'silence';
          this.speechMs = 0;
          event = 'speech_end';
        }
      }
    }
    return { db, state: this.state, event, noiseFloor: this.noiseFloor, openThresh };
  }
}

// ---------------------------------------------------------------------------
// Latency budget. A streaming endpoint's SLO is a percentile, never a mean —
// the mean hides exactly the tail that makes a voice agent feel broken.
// ---------------------------------------------------------------------------

export class LatencyBudget {
  constructor(cap = 4000) {
    this.samples = [];
    this.cap = cap;
  }
  add(ms) {
    this.samples.push(ms);
    if (this.samples.length > this.cap) this.samples.shift();
  }
  pct(p) {
    if (!this.samples.length) return 0;
    const s = [...this.samples].sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return s[i];
  }
  get mean() {
    if (!this.samples.length) return 0;
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }
  histogram(bins = 22, max = 240) {
    const h = new Array(bins).fill(0);
    for (const v of this.samples) {
      const i = Math.min(bins - 1, Math.floor((v / max) * bins));
      h[i]++;
    }
    return h;
  }
}

// ---------------------------------------------------------------------------
// Flow control. A client that streams audio faster than realtime (uploading a
// file over a socket built for live capture) will outrun the decoder; the server
// has to either buffer, drop, or apply backpressure. This models the buffer so
// the failure mode is visible instead of theoretical.
// ---------------------------------------------------------------------------

export class FlowControl {
  constructor({ highWater = 32, lowWater = 8 } = {}) {
    this.queue = 0;
    this.highWater = highWater;
    this.lowWater = lowWater;
    this.paused = false;
    this.dropped = 0;
    this.maxDepth = 0;
  }
  enqueue(n = 1) {
    this.queue += n;
    this.maxDepth = Math.max(this.maxDepth, this.queue);
    if (this.queue >= this.highWater) this.paused = true;
    return this.paused;
  }
  drain(n = 1) {
    this.queue = Math.max(0, this.queue - n);
    if (this.paused && this.queue <= this.lowWater) this.paused = false;
    return this.paused;
  }
}
