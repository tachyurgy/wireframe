# Wireframe

**A streaming speech recognition endpoint viewed from the protocol side, with real VAD.**

Live: **https://wireframe.levelbrook.com**

## What this is

Most speech demos show a transcript. The interesting engineering is one layer down, at the
socket. Wireframe shows interim hypotheses being revised before anything commits, endpointing, per-frame
latency budgets, and backpressure.

## Engineering notes

### Protocol-level view

Interim hypotheses arrive and get revised before commit. Per-frame latency
is reported as p50/p95/p99 against a budget rather than as a mean, because a mean hides the tail that actually
breaks a live call.

### Backpressure

A decode queue applies high and low water marks when a client streams faster than
realtime, which is what happens the first time someone uploads a file over a socket designed for live capture.

### Genuine DSP, not simulated

Switch to live microphone and the VAD runs on real audio: frame RMS
in dBFS, an adaptive noise floor that only tracks while the gate is closed (otherwise steady speech raises the
floor and gates itself off mid-sentence), a hysteresis gate with separate onset and hold thresholds so a speaker
who drops volume is not clipped, and a hangover timer for endpointing.

### A bug worth recording

A `requestAnimationFrame` delta is about 16ms, shorter than a 20ms frame,
so flooring each delta independently dropped nearly every frame and the counter read 1 after nine seconds.
Carrying the remainder across ticks fixed it, and the latency histogram immediately looked like a real one.

## Stack

Vanilla JavaScript, Web Audio API, real-time DSP


## Running it

Static. Open `index.html`, or serve the directory:

```
python3 -m http.server 8000
```

## Honest scope

This is a focused engineering demo, not a production system. The data is synthetic and generated
locally so that the behaviour is reproducible. The reasoning, the arithmetic and the failure modes
are the point; the surface area is deliberately narrow.

## License

MIT
