// A canned streaming session with word-level timings, used when no microphone is
// attached so the demo is deterministic. Timings are in seconds from stream open.
// Confidences are per-word, which is what a real ASR endpoint returns and what
// downstream consumers actually key on.

export const SESSION = {
  sampleRate: 16000,
  encoding: 'linear16',
  channels: 1,
  model: 'nova-3',
  utterances: [
    {
      start: 0.42,
      words: [
        { w: 'okay', s: 0.42, e: 0.71, c: 0.981 },
        { w: 'so', s: 0.74, e: 0.89, c: 0.994 },
        { w: 'the', s: 0.92, e: 1.02, c: 0.997 },
        { w: 'shipment', s: 1.05, e: 1.58, c: 0.962 },
        { w: 'went', s: 1.61, e: 1.83, c: 0.988 },
        { w: 'out', s: 1.86, e: 2.05, c: 0.993 },
        { w: 'tuesday', s: 2.12, e: 2.68, c: 0.947 },
        { w: 'morning', s: 2.71, e: 3.18, c: 0.973 },
      ],
      // Interim hypotheses the decoder emits before committing. The revision at
      // "shipment" is the interesting one: a partial that a naive consumer would
      // have already rendered to the user.
      interims: [
        { at: 0.62, text: 'okay' },
        { at: 0.84, text: 'okay so' },
        { at: 1.16, text: 'okay so the ship' },
        { at: 1.44, text: 'okay so the shipment' },
        { at: 1.78, text: 'okay so the shipment when' },
        { at: 1.98, text: 'okay so the shipment went out' },
        { at: 2.44, text: 'okay so the shipment went out tuesday' },
        { at: 3.02, text: 'okay so the shipment went out tuesday morn' },
      ],
      final: 'Okay, so the shipment went out Tuesday morning.',
      endpointAt: 3.62,
    },
    {
      start: 4.31,
      words: [
        { w: 'can', s: 4.31, e: 4.52, c: 0.991 },
        { w: 'you', s: 4.55, e: 4.68, c: 0.996 },
        { w: 'pull', s: 4.71, e: 4.98, c: 0.978 },
        { w: 'the', s: 5.01, e: 5.11, c: 0.995 },
        { w: 'bill', s: 5.14, e: 5.42, c: 0.958 },
        { w: 'of', s: 5.45, e: 5.55, c: 0.991 },
        { w: 'lading', s: 5.58, e: 6.04, c: 0.883 },
        { w: 'for', s: 6.07, e: 6.24, c: 0.986 },
        { w: 'me', s: 6.27, e: 6.48, c: 0.992 },
      ],
      interims: [
        { at: 4.5, text: 'can' },
        { at: 4.74, text: 'can you' },
        { at: 5.06, text: 'can you pull the' },
        { at: 5.38, text: 'can you pull the bill' },
        { at: 5.72, text: 'can you pull the bill of lay' },
        { at: 6.02, text: 'can you pull the bill of lading' },
        { at: 6.4, text: 'can you pull the bill of lading for me' },
      ],
      final: 'Can you pull the bill of lading for me?',
      endpointAt: 6.98,
    },
    {
      start: 7.84,
      words: [
        { w: 'it', s: 7.84, e: 7.98, c: 0.993 },
        { w: 'should', s: 8.01, e: 8.26, c: 0.989 },
        { w: 'be', s: 8.29, e: 8.41, c: 0.995 },
        { w: 'under', s: 8.44, e: 8.79, c: 0.981 },
        { w: 'account', s: 8.82, e: 9.31, c: 0.969 },
        { w: 'four', s: 9.38, e: 9.62, c: 0.912 },
        { w: 'seven', s: 9.65, e: 9.94, c: 0.898 },
        { w: 'two', s: 9.97, e: 10.18, c: 0.934 },
        { w: 'nine', s: 10.21, e: 10.52, c: 0.907 },
      ],
      interims: [
        { at: 8.02, text: 'it should' },
        { at: 8.44, text: 'it should be' },
        { at: 8.82, text: 'it should be under' },
        { at: 9.28, text: 'it should be under a count' },
        { at: 9.6, text: 'it should be under account four' },
        { at: 9.98, text: 'it should be under account four seven' },
        { at: 10.44, text: 'it should be under account four seven two' },
      ],
      final: 'It should be under account 4729.',
      endpointAt: 11.1,
    },
  ],
};

// Realistic per-frame inference latency, milliseconds. A long tail is the whole
// reason a streaming endpoint needs a latency budget rather than an average.
export function sampleLatency(rng) {
  const u = rng();
  if (u < 0.86) return 18 + rng() * 14;      // warm path
  if (u < 0.97) return 42 + rng() * 38;      // batch boundary
  return 120 + rng() * 190;                  // GPU contention / model swap
}

export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
