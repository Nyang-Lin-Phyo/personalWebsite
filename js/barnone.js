/*!
 * Bar None — in-browser port of the desktop app's detection pipeline.
 *
 * Pure functions over Float32/Float64 audio at sr = 22050, no DOM access
 * (decodeAndResample is the one exception — it needs Web Audio and is only
 * called from the demo page).
 *
 * Source of truth: daVinci/beatMatcher/src/beats.py, src/edl.py,
 * src/timecode.py — with the installed librosa mirrored for the DSP
 * primitives (onset envelope, tempogram tempo, Ellis DP beat tracker,
 * peak picking, Slaney mel filterbank).
 */
(function (global) {
    'use strict';

    /* ── constants (beats.py:35–58) ──────────────────────────── */
    const HOP_LENGTH = 512;
    const BAR_LENGTHS = [3, 4, 6]; // candidate beats per bar (3/4, 4/4, 6/8)
    const STFT_N_FFT = 2048;
    const KICK_BAND = [40.0, 150.0]; // Hz — where the kick drum lives
    const SNAP_WINDOW = 0.30; // seconds — max move when snapping a beat
    const SNAP_IBI_FRACTION = 0.35; // …never past the midpoint to the next beat
    const SNAP_MIN_SEP_FRACTION = 0.25; // min spacing of snapped beats (IBI fraction)
    const INTRO_ONSET_RATIO = 0.35; // "strong" onset vs track peak
    const INTRO_RMS_RATIO = 0.40; // leading region quiet vs track median
    const SECTION_BEATS = 48; // beats per scoring section
    const SECTION_MIN_SD = 0.1; // sections quieter than this fraction: skip
    const PRIOR_BONUS = 0.5; // score boost for the first-hit phase
    const LAG4_TIE_RATIO = 0.9; // lag 4 wins unless another lag beats it >10%
    const CUT_BAND = [40.0, 2500.0]; // Hz — kick/snare body, not hat ticks
    const CUT_DENSITY_GAPS = { tight: 0.5, medium: 1.0, loose: 1.5 };
    const DEFAULT_CUT_DENSITY = 'medium';
    const PUNCH_BASELINE_SEC = 4.0; // adaptive punch baseline window
    const CUT_PEAK_MAX = 8; // peak neighbourhood for peak_pick
    const CUT_AVG = 32; // local baseline window for peak_pick
    const CUT_PEAK_DELTA = 0.5; // punch must beat its local average
    const CUT_PEAK_WAIT = 2; // frames between candidate peaks
    const CUT_RMS_RATIO = 0.25; // cuts must be this loud vs track median

    const SR = 22050;
    const TINY = 2.2250738585072014e-308; // np.finfo(np.float64).tiny

    const MODE_ALL = 'all';
    const MODE_DOWNBEATS = 'downbeats';
    const MODE_BOTH = 'both';
    const MODE_CUT = 'cut';

    /* ── numeric helpers ──────────────────────────────────────── */

    // Python's round(): half-to-even (JS Math.round is half-away-from-zero).
    function pyRound(x) {
        const f = Math.floor(x), r = x - f;
        if (r > 0.5) return f + 1;
        if (r < 0.5) return f;
        return f % 2 === 0 ? f : f + 1; // tie → even, like Python
    }

    function median(values) {
        const n = values.length;
        if (n === 0) return NaN;
        const a = Float64Array.from(values);
        a.sort();
        const m = n >> 1;
        return n % 2 === 1 ? a[m] : (a[m - 1] + a[m]) / 2;
    }

    function meanOf(a, start, end) {
        start = start || 0;
        end = end === undefined ? a.length : end;
        let sum = 0;
        for (let i = start; i < end; i++) sum += a[i];
        return sum / (end - start);
    }

    // population std (numpy default ddof=0)
    function stdPop(a, start, end) {
        start = start || 0;
        end = end === undefined ? a.length : end;
        const m = meanOf(a, start, end);
        let acc = 0;
        for (let i = start; i < end; i++) {
            const d = a[i] - m;
            acc += d * d;
        }
        return Math.sqrt(acc / (end - start));
    }

    // sample std (ddof=1) — librosa's __normalize_onsets
    function stdSample(a) {
        const n = a.length;
        const m = meanOf(a, 0, n);
        let acc = 0;
        for (let i = 0; i < n; i++) {
            const d = a[i] - m;
            acc += d * d;
        }
        return Math.sqrt(acc / (n - 1));
    }

    // scipy.ndimage.uniform_filter1d(..., mode="nearest"): centered window,
    // edge values repeated outside the array.
    function uniformFilter1d(x, size) {
        const n = x.length;
        const out = new Float64Array(n);
        const half = Math.floor(size / 2);
        for (let i = 0; i < n; i++) {
            let sum = 0;
            const lo = i - half;
            for (let j = lo; j < lo + size; j++) {
                sum += x[j < 0 ? 0 : (j >= n ? n - 1 : j)];
            }
            out[i] = sum / size;
        }
        return out;
    }

    // np.argmax semantics: first strictly-greatest index (NaN never wins).
    function argmaxFirst(a, start, end) {
        start = start || 0;
        end = end === undefined ? a.length : end;
        let best = a[start], bi = start;
        for (let i = start + 1; i < end; i++) {
            if (a[i] > best) {
                best = a[i];
                bi = i;
            }
        }
        return bi;
    }

    // np.array_split(np.arange(count), n): as equal as possible, earlier
    // chunks get the extra elements. Returns [start, end) ranges.
    function splitSections(count) {
        const n = Math.max(1, Math.floor(count / SECTION_BEATS));
        const base = Math.floor(count / n);
        const rem = count % n;
        const out = [];
        let start = 0;
        for (let k = 0; k < n; k++) {
            const size = base + (k < rem ? 1 : 0);
            out.push([start, start + size]);
            start += size;
        }
        return out;
    }

    /* ── frame ↔ time (librosa frames_to_time / time_to_frames) ─ */

    // librosa: samples = frames * hop_length (int); time = samples / sr
    function frameToTime(frame) {
        return (frame * HOP_LENGTH) / SR;
    }

    // librosa: samples = int(t * sr) (truncating cast); frames = samples // hop
    function timeToFrames(t) {
        const samples = Math.trunc(t * SR);
        return Math.floor(samples / HOP_LENGTH);
    }

    /* ── radix-2 FFT (complex, in place) ──────────────────────── */

    function createFFT(n) {
        const levels = Math.round(Math.log2(n));
        if (1 << levels !== n) throw new Error('FFT size must be a power of 2');
        const rev = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
            let x = i, r = 0;
            for (let j = 0; j < levels; j++) {
                r = (r << 1) | (x & 1);
                x >>= 1;
            }
            rev[i] = r;
        }
        const cosT = new Float64Array(n / 2);
        const sinT = new Float64Array(n / 2);
        for (let i = 0; i < n / 2; i++) {
            cosT[i] = Math.cos((2 * Math.PI * i) / n);
            sinT[i] = Math.sin((2 * Math.PI * i) / n);
        }
        return function fft(re, im, inverse) {
            for (let i = 0; i < n; i++) {
                const r = rev[i];
                if (i < r) {
                    let t = re[i]; re[i] = re[r]; re[r] = t;
                    t = im[i]; im[i] = im[r]; im[r] = t;
                }
            }
            for (let size = 2; size <= n; size <<= 1) {
                const half = size >> 1;
                const step = n / size;
                for (let i = 0; i < n; i += size) {
                    for (let j = i, k = 0; j < i + half; j++, k += step) {
                        const l = j + half;
                        const wr = cosT[k];
                        const wi = inverse ? sinT[k] : -sinT[k];
                        const tr = re[l] * wr - im[l] * wi;
                        const ti = re[l] * wi + im[l] * wr;
                        re[l] = re[j] - tr;
                        im[l] = im[j] - ti;
                        re[j] += tr;
                        im[j] += ti;
                    }
                }
            }
            if (inverse) {
                const inv = 1 / n;
                for (let i = 0; i < n; i++) {
                    re[i] *= inv;
                    im[i] *= inv;
                }
            }
        };
    }

    /* ── mel filterbank (librosa.filters.mel, Slaney norm) ────── */

    const MEL_F_SP = 200.0 / 3.0;
    const MEL_MIN_LOG_HZ = 1000.0;
    const MEL_MIN_LOG_MEL = (MEL_MIN_LOG_HZ - 0.0) / MEL_F_SP; // (1000 - 0) / f_sp
    const MEL_LOGSTEP = Math.log(6.4) / 27.0;

    function hzToMel(f) {
        const mels = (f - 0.0) / MEL_F_SP;
        if (f >= MEL_MIN_LOG_HZ) {
            return MEL_MIN_LOG_MEL + Math.log(f / MEL_MIN_LOG_HZ) / MEL_LOGSTEP;
        }
        return mels;
    }

    function melToHz(mel) {
        let freqs = 0.0 + MEL_F_SP * mel;
        if (mel >= MEL_MIN_LOG_MEL) {
            freqs = MEL_MIN_LOG_HZ * Math.exp(MEL_LOGSTEP * (mel - MEL_MIN_LOG_MEL));
        }
        return freqs;
    }

    // librosa.fft_frequencies: np.fft.rfftfreq(n_fft, d=1/sr)
    function fftFreqBin(k) {
        return k * (1.0 / (STFT_N_FFT * (1.0 / SR)));
    }

    // Dense Slaney mel basis (128 x 1025), then compressed to per-row
    // contiguous positive spans for fast application.
    function buildMelBanks() {
        const nMels = 128;
        const nBins = 1 + STFT_N_FFT / 2;
        // librosa: mel_f = mel_to_hz(linspace(0, hz_to_mel(fmax), n_mels+2))
        const maxMel = hzToMel(SR / 2);
        const step = maxMel / (nMels + 1); // np.linspace divisor = num-1
        const melF = new Float64Array(nMels + 2); // centre freqs in Hz
        for (let i = 0; i < nMels + 2; i++) melF[i] = melToHz(i * step);

        const fdiff = new Float64Array(nMels + 1);
        for (let i = 0; i < nMels + 1; i++) fdiff[i] = melF[i + 1] - melF[i];

        const fftFreqs = new Float64Array(nBins);
        for (let k = 0; k < nBins; k++) fftFreqs[k] = fftFreqBin(k);

        const banks = [];
        for (let i = 0; i < nMels; i++) {
            const enorm = 2.0 / (melF[i + 2] - melF[i]);
            const row = new Float64Array(nBins);
            for (let f = 0; f < nBins; f++) {
                const lower = (fftFreqs[f] - melF[i]) / fdiff[i];
                const upper = (melF[i + 2] - fftFreqs[f]) / fdiff[i + 1];
                const w = Math.max(0, Math.min(lower, upper)) * enorm;
                row[f] = w;
            }
            let lo = -1, hi = -1;
            for (let f = 0; f < nBins; f++) {
                if (row[f] > 0) {
                    if (lo < 0) lo = f;
                    hi = f;
                }
            }
            if (lo < 0) {
                banks.push({ start: 0, w: new Float64Array(0) });
            } else {
                banks.push({ start: lo, w: row.slice(lo, hi + 1) });
            }
        }
        return banks;
    }

    const MEL_BANKS = buildMelBanks();

    /* ── STFT analysis pass ─────────────────────────────────────
       One centered STFT of the track yields, in a single sweep:
         - the log-power mel spectrogram (onset envelope source)
         - kick-band (40-150 Hz) and cut-band (40-2500 Hz) magnitude sums
           (the inputs to _band_flux for downbeats and punch points).
       Python recomputes the STFT up to three times; the results are
       identical, so we reuse one pass for speed. */
    function analyzeSpectra(y) {
        const n = y.length;
        const nFrames = Math.floor(n / HOP_LENGTH) + 1;
        const hann = new Float64Array(STFT_N_FFT);
        for (let j = 0; j < STFT_N_FFT; j++) {
            hann[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / STFT_N_FFT);
        }
        const kickBins = bandBinRange(KICK_BAND[0], KICK_BAND[1]);
        const cutBins = bandBinRange(CUT_BAND[0], CUT_BAND[1]);

        const fft = createFFT(STFT_N_FFT);
        const re = new Float64Array(STFT_N_FFT);
        const im = new Float64Array(STFT_N_FFT);
        const melPower = new Float64Array(nFrames * 128); // [frame][mel]
        const kickBand = new Float64Array(nFrames);
        const cutBand = new Float64Array(nFrames);

        for (let t = 0; t < nFrames; t++) {
            const off = t * HOP_LENGTH - STFT_N_FFT / 2; // centered: pad n_fft//2
            for (let j = 0; j < STFT_N_FFT; j++) {
                const s = off + j;
                re[j] = (s >= 0 && s < n ? y[s] : 0) * hann[j];
                im[j] = 0;
            }
            fft(re, im, false);

            const rowOff = t * 128;
            for (let m = 0; m < 128; m++) {
                const bank = MEL_BANKS[m];
                let acc = 0;
                for (let f = 0; f < bank.w.length; f++) {
                    const b = bank.start + f;
                    const pr = re[b], pi = im[b];
                    acc += bank.w[f] * (pr * pr + pi * pi); // power = |X|^2
                }
                melPower[rowOff + m] = acc;
            }
            let ks = 0, cs = 0;
            for (let k = kickBins[0]; k <= kickBins[1]; k++) {
                ks += Math.sqrt(re[k] * re[k] + im[k] * im[k]); // |X|
            }
            for (let k = cutBins[0]; k <= cutBins[1]; k++) {
                cs += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
            }
            kickBand[t] = ks;
            cutBand[t] = cs;
        }
        return { nFrames: nFrames, melPower: melPower, kickBand: kickBand, cutBand: cutBand };
    }

    function bandBinRange(low, high) {
        let lo = -1, hi = -1;
        for (let k = 0; k <= STFT_N_FFT / 2; k++) {
            const f = fftFreqBin(k);
            if (f >= low && f <= high) {
                if (lo < 0) lo = k;
                hi = k;
            }
        }
        if (lo < 0) throw new Error('empty frequency band');
        return [lo, hi];
    }

    /* ── power_to_db (librosa.core.spectrum.power_to_db) ──────── */

    function powerToDbInPlace(melPower) {
        let maxLog = -Infinity;
        for (let i = 0; i < melPower.length; i++) {
            const v = 10.0 * Math.log10(Math.max(1e-10, melPower[i])); // ref = 1.0
            melPower[i] = v;
            if (v > maxLog) maxLog = v;
        }
        const floor = maxLog - 80.0;
        for (let i = 0; i < melPower.length; i++) {
            if (melPower[i] < floor) melPower[i] = floor;
        }
        return melPower;
    }

    /* ── onset strength envelope (librosa.onset.onset_strength
          with aggregate=np.median — beats.py:107–112) ────────── */

    function onsetStrength(melDb, nFrames) {
        const out = new Float64Array(nFrames); // leading zeros by construction
        const scratch = new Float64Array(128);
        // rectified lag-1 flux per mel, median across frequency
        const core = new Float64Array(Math.max(0, nFrames - 1));
        for (let t = 0; t + 1 < nFrames; t++) {
            const cur = t * 128, prev = (t + 1) * 128;
            for (let m = 0; m < 128; m++) {
                const d = melDb[prev + m] - melDb[cur + m];
                scratch[m] = d > 0 ? d : 0;
            }
            scratch.sort();
            core[t] = (scratch[63] + scratch[64]) / 2; // np.median of 128 values
        }
        // pad_width = lag(1) + n_fft//2//hop(2) = 3 zeros, then trim to nFrames
        for (let i = 3; i < nFrames; i++) out[i] = core[i - 3];
        return out;
    }

    /* ── RMS envelope (librosa.feature.rms, center=True) ──────── */

    function rmsEnvelope(y) {
        const n = y.length;
        const nFrames = Math.floor(n / HOP_LENGTH) + 1;
        // prefix sums of squares over the zero-padded signal
        const pad = STFT_N_FFT / 2;
        const pref = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) pref[i + 1] = pref[i] + y[i] * y[i];
        const out = new Float64Array(nFrames);
        for (let t = 0; t < nFrames; t++) {
            const center = t * HOP_LENGTH; // padded index of window start + pad
            const lo = center - pad; // original-signal bounds of the window
            const hi = center + pad;
            const a = lo < 0 ? 0 : lo;
            const b = hi > n ? n : hi;
            const sum = pref[b] - pref[a];
            out[t] = Math.sqrt(sum / STFT_N_FFT);
        }
        return out;
    }

    /* ── band flux + punch envelope (beats.py:254–276, 371–381) ─ */

    function bandFlux(band) {
        const n = band.length;
        const out = new Float64Array(n);
        for (let t = 1; t < n; t++) {
            const d = band[t] - band[t - 1];
            out[t] = d > 0 ? d : 0;
        }
        return out; // out[0] = max(0, band[0]-band[0]) = 0
    }

    function punchEnvelope(cutFlux) {
        const n = cutFlux.length;
        let mean = 0;
        for (let t = 0; t < n; t++) mean += cutFlux[t];
        mean /= n;
        const window = Math.max(3, pyRound((PUNCH_BASELINE_SEC * SR) / HOP_LENGTH));
        const baseline = uniformFilter1d(cutFlux, window);
        const out = new Float64Array(n);
        const denomAdj = 0.1 * mean + 1e-12;
        for (let t = 0; t < n; t++) {
            out[t] = cutFlux[t] / (baseline[t] + denomAdj);
        }
        return out;
    }

    /* ── tempo (librosa.feature.rhythm.tempo, defaults) ─────────
       Windowed autocorrelation of the onset envelope (tempogram),
       mean-aggregated over time, weighted by the log-normal prior
       around 120 BPM with a 320 BPM ceiling. Returns an array of
       length 1, mirroring np.atleast_1d(bpm) in beat_track. */
    function estimateTempo(env) {
        const n = env.length;
        const winLength = timeToFrames(8.0); // ac_size = 8 s → 344 frames
        const p = Math.floor(winLength / 2);

        // center=True: linear-ramp pad of win//2 on each side (end value 0)
        const padded = new Float64Array(n + 2 * p);
        if (n > 0) {
            const edge0 = env[0], edgeN = env[n - 1];
            for (let j = 0; j < p; j++) padded[j] = (edge0 * j) / p;
            padded.set(env, p);
            for (let j = 0; j < p; j++) {
                padded[p + n + j] = (edgeN * (p - 1 - j)) / p;
            }
        }

        const hann = new Float64Array(winLength);
        for (let j = 0; j < winLength; j++) {
            hann[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / winLength);
        }

        const v = new Float64Array(winLength);
        const ac = new Float64Array(winLength);
        const tg = new Float64Array(winLength);
        for (let t = 0; t < n; t++) {
            for (let j = 0; j < winLength; j++) {
                v[j] = padded[t + j] * hann[j];
            }
            // linear autocorrelation, lags 0..winLength-1 (matches
            // scipy.fft.autocorrelate with a non-aliasing pad)
            for (let lag = 0; lag < winLength; lag++) {
                let s = 0;
                const m = winLength - lag;
                for (let j = 0; j < m; j++) s += v[j] * v[j + lag];
                ac[lag] = s;
            }
            // librosa.util.normalize(norm=inf, axis=-2): divide each column
            // by its max magnitude, or leave untouched below tiny()
            let mx = 0;
            for (let lag = 0; lag < winLength; lag++) {
                const a = ac[lag] < 0 ? -ac[lag] : ac[lag];
                if (a > mx) mx = a;
            }
            if (mx >= TINY) {
                for (let lag = 0; lag < winLength; lag++) ac[lag] /= mx;
            }
            for (let lag = 0; lag < winLength; lag++) tg[lag] += ac[lag];
        }
        // aggregate = np.mean over time
        if (n > 0) {
            for (let lag = 0; lag < winLength; lag++) tg[lag] /= n;
        }

        // tempo_frequencies: [inf, 60*sr/(hop*i)]
        const bpms = new Float64Array(winLength);
        bpms[0] = Infinity;
        for (let i = 1; i < winLength; i++) {
            bpms[i] = (60.0 * SR) / (HOP_LENGTH * i);
        }

        // log-normal prior around start_bpm=120, std=1
        const logprior = new Float64Array(winLength);
        const log2Start = Math.log2(120);
        for (let i = 0; i < winLength; i++) {
            const d = (Math.log2(bpms[i]) - log2Start) / 1.0;
            logprior[i] = -0.5 * d * d;
        }
        // max_tempo=320: kill every bin at or above the ceiling
        let maxIdx = 0;
        for (let i = 0; i < winLength; i++) {
            if (bpms[i] < 320.0) {
                maxIdx = i;
                break;
            }
        }
        for (let i = 0; i < maxIdx; i++) logprior[i] = -Infinity;

        // argmax over lags of log1p(1e6 * tg) + logprior (first max wins)
        let best = -Infinity;
        let bestLag = maxIdx;
        for (let i = 0; i < winLength; i++) {
            const val = Math.log1p(1e6 * tg[i]) + logprior[i];
            if (val > best) {
                best = val;
                bestLag = i;
            }
        }
        return [bpms[bestLag]];
    }

    /* ── beat tracking (librosa.beat, trim=False, units="frames") ─ */

    function localmax(x) {
        const n = x.length;
        const lm = new Uint8Array(n);
        if (n > 1) {
            // x[0] is never a local maximum (librosa contract)
            for (let i = 1; i < n - 1; i++) {
                lm[i] = x[i] > x[i - 1] && x[i] >= x[i + 1] ? 1 : 0;
            }
            lm[n - 1] = x[n - 1] > x[n - 2] ? 1 : 0;
        }
        return lm;
    }

    function trackBeats(env, bpmArr) {
        const n = env.length;
        const frameRate = SR / HOP_LENGTH; // float(sr) / hop_length
        const fpb = pyRound((frameRate * 60.0) / bpmArr[0]); // np.round
        const tightness = 100;

        // localscore: AGC'd envelope smoothed with a Gaussian the width of
        // one beat (librosa.beat.__beat_local_score, static-tempo branch)
        const norm = stdSample(env);
        const normEnv = new Float64Array(n);
        const div = norm + TINY;
        for (let i = 0; i < n; i++) normEnv[i] = env[i] / div;

        const K = 2 * fpb + 1;
        const K2 = fpb; // K // 2
        const window = new Float64Array(K);
        const scale = 32.0 / fpb;
        for (let k = 0; k < K; k++) {
            const idx = -fpb + k;
            const x = (idx * 32.0) / fpb;
            window[k] = Math.exp(-0.5 * x * x);
        }
        void scale;

        const localscore = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let s = 0;
            const kStart = Math.max(0, i + K2 - n + 1);
            const kEnd = Math.min(i + K2, K);
            for (let k = kStart; k < kEnd; k++) {
                s += window[k] * normEnv[i + K2 - k];
            }
            localscore[i] = s;
        }

        // Ellis DP (librosa.beat.__beat_track_dp)
        let maxLocal = -Infinity;
        for (let i = 0; i < n; i++) if (localscore[i] > maxLocal) maxLocal = localscore[i];
        const scoreThresh = 0.01 * maxLocal;
        const backlink = new Int32Array(n);
        const cumscore = new Float64Array(n);
        backlink[0] = -1;
        cumscore[0] = localscore[0];
        let firstBeat = true;
        const halfStep = pyRound(fpb / 2);
        for (let i = 0; i < n; i++) {
            let bestScore = -Infinity;
            let beatLocation = -1;
            const stop = Math.trunc(i - 2 * fpb - 1); // range end (exclusive)
            for (let loc = i - halfStep; loc > stop; loc--) {
                if (loc < 0) break;
                const d = Math.log(i - loc) - Math.log(fpb);
                const score = cumscore[loc] - tightness * d * d;
                if (score > bestScore) {
                    bestScore = score;
                    beatLocation = loc;
                }
            }
            cumscore[i] = beatLocation >= 0 ? localscore[i] + bestScore : localscore[i];
            if (firstBeat && localscore[i] < scoreThresh) {
                backlink[i] = -1;
            } else {
                backlink[i] = beatLocation;
                firstBeat = false;
            }
        }

        // tail = last local max above half the median local-max score
        const lm = localmax(cumscore);
        const lmVals = [];
        for (let i = 0; i < n; i++) if (lm[i]) lmVals.push(cumscore[i]);
        const threshold = lmVals.length ? 0.5 * median(lmVals) : 0;
        let tail = n - 1;
        for (let i = n - 1; i >= 0; i--) {
            if (lm[i] && cumscore[i] >= threshold) {
                tail = i;
                break;
            }
        }

        // backtrack the chosen path
        const beats = new Uint8Array(n);
        let i = tail;
        while (i >= 0) {
            beats[i] = 1;
            i = backlink[i];
        }

        // __trim_beats with trim=False: still discard beats whose
        // localscore is exactly 0 at the edges
        let lo = 0;
        while (lo < n && localscore[lo] <= 0) {
            beats[lo] = 0;
            lo++;
        }
        let hi = n - 1;
        while (hi >= 0 && localscore[hi] <= 0) {
            beats[hi] = 0;
            hi--;
        }

        const out = [];
        for (let j = 0; j < n; j++) if (beats[j]) out.push(j);
        return out;
    }

    /* ── pipeline stages (beats.py:148–365) ───────────────────── */

    function trimIntro(beatTimes, onsetEnv, rms) {
        const result = { times: beatTimes, anchor: null };
        if (beatTimes.length === 0 || onsetEnv.length === 0 || rms.length === 0) {
            return result;
        }
        const n = Math.min(onsetEnv.length, rms.length);
        let peak = 0;
        for (let i = 0; i < n; i++) if (onsetEnv[i] > peak) peak = onsetEnv[i];
        if (peak <= 0) return result;

        const strong = [];
        for (let i = 0; i < n; i++) {
            if (onsetEnv[i] >= INTRO_ONSET_RATIO * peak) strong.push(i);
        }
        if (strong.length === 0 || strong[0] === 0) return result;

        const firstStrong = (strong[0] * HOP_LENGTH) / SR;
        const trackRms = median(rms.subarray(0, n));
        const leadRms = median(rms.subarray(0, strong[0]));
        if (trackRms <= 0 || leadRms >= INTRO_RMS_RATIO * trackRms) return result;

        let ibi = 0.5;
        if (beatTimes.length > 1) {
            const diffs = [];
            for (let i = 1; i < beatTimes.length; i++) {
                diffs.push(beatTimes[i] - beatTimes[i - 1]);
            }
            ibi = median(diffs);
        }
        const cutoff = firstStrong - 0.5 * ibi;
        const kept = beatTimes.filter((t) => t >= cutoff);
        if (kept.length < 8) return result; // never trim the grid away
        return { times: kept, anchor: firstStrong };
    }

    function snapToOnsets(beatTimes, punch, rms) {
        if (beatTimes.length < 2) return beatTimes;
        const count = Math.min(punch.length, rms.length);
        if (count === 0) return beatTimes;
        const pk = punch.subarray(0, count);
        const rm = rms.subarray(0, count);

        const floor = CUT_RMS_RATIO * median(rm);
        const diffs = [];
        for (let i = 1; i < beatTimes.length; i++) {
            diffs.push(beatTimes[i] - beatTimes[i - 1]);
        }
        const ibi = median(diffs);
        // clamp the window so a beat can never hop onto the offbeat
        const window = Math.max(
            1,
            pyRound((Math.min(SNAP_WINDOW, SNAP_IBI_FRACTION * ibi) * SR) / HOP_LENGTH)
        );
        const minSep = Math.max(
            1,
            pyRound(((SNAP_MIN_SEP_FRACTION * ibi) * SR) / HOP_LENGTH)
        );

        const snapped = [];
        for (const t of beatTimes) {
            let frame = timeToFrames(t);
            if (frame < 0) frame = 0;
            if (frame > count - 1) frame = count - 1;
            const lo = Math.max(0, frame - window);
            const hi = Math.min(count, frame + window + 1);
            const best = argmaxFirst(pk, lo, hi); // absolute index
            const hereLo = Math.max(0, frame - 1);
            const hereHi = Math.min(count, frame + 2);
            let here = -Infinity;
            for (let i = hereLo; i < hereHi; i++) if (pk[i] > here) here = pk[i];

            let candidate = t;
            if (pk[best] > here && rm[best] >= floor) {
                candidate = (best * HOP_LENGTH) / SR;
            }
            const prev = snapped.length ? snapped[snapped.length - 1] : null;
            if (prev !== null && ((candidate - prev) * SR) / HOP_LENGTH < minSep) {
                candidate = t; // too close: keep the grid position
            }
            if (prev !== null && candidate <= prev) {
                candidate = t; // keep order: prefer the grid position
            }
            if (prev !== null && candidate <= prev) {
                candidate = prev + 1e-4; // pathological: force progress
            }
            snapped.push(candidate);
        }
        return snapped;
    }

    function sampleAt(envelope, times) {
        const len = envelope.length;
        const values = new Float64Array(times.length);
        for (let i = 0; i < times.length; i++) {
            let f = timeToFrames(times[i]);
            if (f < 0) f = 0;
            if (f > len - 1) f = len - 1;
            const lo = Math.max(0, f - 1);
            const hi = Math.min(len, f + 2);
            let v = -Infinity;
            for (let j = lo; j < hi; j++) if (envelope[j] > v) v = envelope[j];
            values[i] = v;
        }
        return values;
    }

    function barPhaseScores(values, priorIdx) {
        const count = values.length;
        if (count < 8) return [];
        const sections = splitSections(count);
        const globalSd = stdPop(values);
        const scores = [];

        for (const lag of BAR_LENGTHS) {
            if (count < lag * 2) continue;
            for (let phase = 0; phase < lag; phase++) {
                let total = 0;
                let used = 0;
                for (const [s, e] of sections) {
                    if (e <= s) continue;
                    const m = meanOf(values, s, e);
                    const sd = stdPop(values, s, e);
                    if (sd <= 1e-12) continue;
                    if (globalSd > 0 && sd < SECTION_MIN_SD * globalSd) continue;
                    // picks = section indices with i % lag == phase
                    let first = s + (((phase - s) % lag) + lag) % lag;
                    let pickSum = 0;
                    let pickCount = 0;
                    for (let i = first; i < e; i += lag) {
                        pickSum += (values[i] - m) / sd;
                        pickCount++;
                    }
                    if (pickCount === 0) continue;
                    total += pickSum / Math.sqrt(pickCount);
                    used++;
                }
                if (used === 0) continue;
                let score = total / used;
                if (priorIdx !== null && phase === priorIdx % lag) {
                    score += PRIOR_BONUS;
                }
                scores.push({ score: score, lag: lag, phase: phase });
            }
        }
        return scores;
    }

    function findDownbeats(kick, beatTimes, anchor) {
        const count = beatTimes.length;
        if (count < 8) return [];
        const values = sampleAt(kick, beatTimes);

        let priorIdx = null;
        if (anchor !== null && anchor !== undefined) {
            let bi = 0;
            let bd = Math.abs(beatTimes[0] - anchor);
            for (let i = 1; i < count; i++) {
                const d = Math.abs(beatTimes[i] - anchor);
                if (d < bd) {
                    bd = d;
                    bi = i;
                }
            }
            priorIdx = bi;
        }

        const scores = barPhaseScores(values, priorIdx);
        if (scores.length === 0) {
            const out = [];
            for (let i = 0; i < count; i += 4) out.push(i);
            return out;
        }

        let best = scores[0];
        for (const entry of scores) {
            if (entry.score > best.score) best = entry;
        }
        let lag = best.lag;
        let phase = best.phase;

        // 4/4 tie-break: unless another lag clearly beats lag 4, the track
        // is counted as 4/4 — by far the most common meter
        const lag4 = scores.filter((entry) => entry.lag === 4);
        if (lag4.length) {
            let bestL4 = lag4[0];
            for (const entry of lag4) {
                if (entry.score > bestL4.score) bestL4 = entry;
            }
            if (bestL4.score <= 0 || bestL4.score >= LAG4_TIE_RATIO * best.score) {
                lag = 4;
                phase = bestL4.phase;
            }
        }

        const out = [];
        for (let i = phase; i < count; i += lag) out.push(i);
        return out;
    }

    /* ── public detection entry points ────────────────────────── */

    function detectBeats(y, report) {
        const duration = y.length / SR;
        if (report) report('Tracking beats…');
        const spec = analyzeSpectra(y);
        powerToDbInPlace(spec.melPower);
        const env = onsetStrength(spec.melPower, spec.nFrames);

        let any = false;
        for (let i = 0; i < env.length; i++) {
            if (env[i] !== 0) {
                any = true;
                break;
            }
        }
        if (!any) throw new Error('no beats could be detected in this file');

        const bpmArr = estimateTempo(env);
        const beatFrames = trackBeats(env, bpmArr);
        if (beatFrames.length === 0) {
            throw new Error('no beats could be detected in this file');
        }
        const tempo = meanOf(bpmArr, 0, bpmArr.length);
        let beatTimes = beatFrames.map(frameToTime);

        const rms = rmsEnvelope(y);
        const trimmed = trimIntro(beatTimes, env, rms);
        beatTimes = trimmed.times;
        const anchor = trimmed.anchor;

        const punch = punchEnvelope(bandFlux(spec.cutBand));
        beatTimes = snapToOnsets(beatTimes, punch, rms);

        if (report) report('Finding downbeats…');
        const kick = bandFlux(spec.kickBand);
        const downbeats = findDownbeats(kick, beatTimes, anchor);

        return { tempo: tempo, beatTimes: beatTimes, downbeats: downbeats, duration: duration };
    }

    /* ── cut points (beats.py:384–463) ────────────────────────── */

    function peakPickGreedy(x, preMax, postMax, preAvg, postAvg, delta, wait) {
        const n = x.length;
        const peaks = new Uint8Array(n);
        if (n === 0) return peaks;

        let mx = -Infinity;
        for (let i = 0; i < Math.min(postMax, n); i++) if (x[i] > mx) mx = x[i];
        let sum = 0;
        const avgN = Math.min(postAvg, n);
        for (let i = 0; i < avgN; i++) sum += x[i];
        let ok = x[0] >= mx && x[0] >= sum / avgN + delta;
        peaks[0] = ok ? 1 : 0;

        let m = peaks[0] ? wait + 1 : 1;
        while (m < n) {
            const lo = Math.max(0, m - preMax);
            const hi = Math.min(m + postMax, n);
            mx = -Infinity;
            for (let i = lo; i < hi; i++) if (x[i] > mx) mx = x[i];
            if (x[m] !== mx) {
                m++;
                continue;
            }
            const alo = Math.max(0, m - preAvg);
            const ahi = Math.min(m + postAvg, n);
            sum = 0;
            for (let i = alo; i < ahi; i++) sum += x[i];
            if (x[m] < sum / (ahi - alo) + delta) {
                m++;
                continue;
            }
            peaks[m] = 1;
            m += wait + 1;
        }
        return peaks;
    }

    function findCutPoints(y, minGap, report) {
        if (report) report('Scoring punch points…');
        const spec = analyzeSpectra(y);
        const punch = punchEnvelope(bandFlux(spec.cutBand));
        const rms = rmsEnvelope(y);

        const count = Math.min(punch.length, rms.length);
        if (count === 0) return [];
        const pk = punch.subarray(0, count);
        const rm = rms.subarray(0, count);

        const raw = peakPickGreedy(pk, CUT_PEAK_MAX, CUT_PEAK_MAX, CUT_AVG, CUT_AVG, CUT_PEAK_DELTA, CUT_PEAK_WAIT);
        const candidates = [];
        for (let i = 0; i < count; i++) if (raw[i]) candidates.push(i);
        if (candidates.length === 0) return [];

        const floor = CUT_RMS_RATIO * median(rm);
        const audible = candidates.filter((f) => rm[f] >= floor);
        if (audible.length === 0) return [];

        // strongest first: sort by punch value ascending, then reverse
        // (mirrors np.argsort(punch[peaks])[::-1])
        const byStrength = audible.slice().sort((a, b) => pk[a] - pk[b]).reverse();
        const gapFrames = (minGap * SR) / HOP_LENGTH;
        const chosen = [];
        for (const frame of byStrength) {
            let ok = true;
            for (const kept of chosen) {
                if (Math.abs(frame - kept) < gapFrames) {
                    ok = false;
                    break;
                }
            }
            if (ok) chosen.push(frame);
        }
        if (chosen.length === 0) return [];
        chosen.sort((a, b) => a - b);
        return chosen.map((f) => (f * HOP_LENGTH) / SR);
    }

    function detectCutPoints(y, minGap, report) {
        const gap = minGap === undefined || minGap === null
            ? CUT_DENSITY_GAPS[DEFAULT_CUT_DENSITY]
            : Number(minGap);
        if (!(gap > 0)) throw new Error('min_gap must be positive');
        const duration = y.length / SR;
        const cutTimes = findCutPoints(y, gap, report);
        if (cutTimes.length === 0) {
            throw new Error('no punch points could be detected in this file');
        }
        return { cutTimes: cutTimes, duration: duration, minGap: gap };
    }

    /* ── decode + resample (Web Audio; demo page only) ────────── */

    // Decode the picked file, mix down to mono, and let the browser
    // resample to 22050 through an OfflineAudioContext (§3.1).
    async function decodeAndResample(arrayBuffer) {
        const AC = global.AudioContext || global.webkitAudioContext;
        if (!AC || !global.OfflineAudioContext) {
            throw new Error('Web Audio is not available in this browser');
        }
        const ctx = new AC();
        let decoded;
        try {
            decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
        } finally {
            if (ctx.close) ctx.close();
        }
        const outLen = Math.max(1, Math.round(decoded.duration * SR));
        const oac = new global.OfflineAudioContext(1, outLen, SR);
        const mono = oac.createBuffer(1, decoded.length, decoded.sampleRate);
        const chans = [];
        for (let c = 0; c < decoded.numberOfChannels; c++) {
            chans.push(decoded.getChannelData(c));
        }
        const md = mono.getChannelData(0);
        if (chans.length === 1) {
            md.set(chans[0]);
        } else {
            for (let i = 0; i < md.length; i++) {
                let s = 0;
                for (let c = 0; c < chans.length; c++) s += chans[c][i];
                md[i] = s / chans.length;
            }
        }
        const src = oac.createBufferSource();
        src.buffer = mono;
        src.connect(oac.destination);
        src.start(0);
        const rendered = await oac.startRendering();
        return new Float32Array(rendered.getChannelData(0)); // copy for transfer
    }

    /* ── EDL layer (byte-exact port of edl.py + timecode.py) ──── */

    const FRAME_RATES = [
        { label: '23.976', fps: 24000 / 1001, nominal: 24 },
        { label: '24', fps: 24.0, nominal: 24 },
        { label: '25', fps: 25.0, nominal: 25 },
        { label: '29.97', fps: 30000 / 1001, nominal: 30 },
        { label: '30', fps: 30.0, nominal: 30 },
        { label: '50', fps: 50.0, nominal: 50 },
        { label: '59.94', fps: 60000 / 1001, nominal: 60 },
        { label: '60', fps: 60.0, nominal: 60 },
    ];
    const DEFAULT_FRAME_RATE_LABEL = '24';
    const DEFAULT_CLIP_SOURCE_TC = '01:00:00:00';
    const DEFAULT_TIMELINE_START_TC = '01:00:00:00';

    const BEAT_COLOR = 'ResolveColorBlue'; // Resolve's own EDL colour names
    const BAR_COLOR = 'ResolveColorRed';

    function getFrameRate(label) {
        for (const rate of FRAME_RATES) {
            if (rate.label === label) return rate;
        }
        throw new Error('unknown frame rate: ' + JSON.stringify(label));
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function secondsToFrames(seconds, rate) {
        return pyRound(seconds * rate.fps); // int(round(seconds * fps))
    }

    function framesToTimecode(frames, rate) {
        if (frames < 0) throw new Error('frame number is negative');
        const ff = frames % rate.nominal;
        const totalSeconds = Math.floor(frames / rate.nominal);
        const ss = totalSeconds % 60;
        const mm = Math.floor(totalSeconds / 60) % 60;
        const hh = Math.floor(totalSeconds / 3600);
        return pad2(hh) + ':' + pad2(mm) + ':' + pad2(ss) + ':' + pad2(ff);
    }

    function parseTimecode(timecode, rate) {
        const parts = String(timecode).trim().split(':');
        let hh, mm, ss, ff;
        if (
            parts.length === 4 &&
            parts.every((part) => /^[+-]?\d+$/.test(part))
        ) {
            hh = parseInt(parts[0], 10);
            mm = parseInt(parts[1], 10);
            ss = parseInt(parts[2], 10);
            ff = parseInt(parts[3], 10);
        } else {
            throw new Error(
                'bad timecode ' + JSON.stringify(String(timecode)) + ' — expected HH:MM:SS:FF'
            );
        }
        if (
            hh < 0 ||
            !(mm >= 0 && mm < 60) ||
            !(ss >= 0 && ss < 60) ||
            !(ff >= 0 && ff < rate.nominal)
        ) {
            throw new Error(
                'timecode ' + JSON.stringify(String(timecode)) + ' is out of range for ' +
                rate.label + ' fps (frames run 0..' + (rate.nominal - 1) + ')'
            );
        }
        return ((hh * 60 + mm) * 60 + ss) * rate.nominal + ff;
    }

    // Keep marker/comment fields on a single line and free of field breaks.
    function sanitize(text) {
        const s = String(text).replace(/\|/g, '/');
        return s
            .split(/\r\n|[\n\x0b\x0c\x85\u2028\u2029\x1c\x1d\x1e\r]/)
            .join(' ')
            .trim();
    }

    function makeMarkers(beatTimes, downbeatIndices, mode) {
        const downbeats = new Set(downbeatIndices || []);
        const markers = [];
        let bar = 0;
        for (let index = 0; index < beatTimes.length; index++) {
            const t = Number(beatTimes[index]);
            const isBarStart = downbeats.has(index);
            if (mode === MODE_ALL) {
                markers.push({ t: t, name: 'Beat ' + (index + 1), color: BEAT_COLOR, comment: '' });
            } else if (mode === MODE_DOWNBEATS) {
                if (isBarStart) {
                    bar += 1;
                    markers.push({ t: t, name: 'Bar ' + bar, color: BAR_COLOR, comment: '' });
                }
            } else if (mode === MODE_BOTH) {
                if (isBarStart) {
                    bar += 1;
                    markers.push({ t: t, name: 'Bar ' + bar, color: BAR_COLOR, comment: '' });
                } else {
                    markers.push({ t: t, name: 'Beat ' + (index + 1), color: BEAT_COLOR, comment: '' });
                }
            } else if (mode === MODE_CUT) {
                markers.push({ t: t, name: 'Cut ' + (index + 1), color: BAR_COLOR, comment: '' });
            } else {
                throw new Error('unknown marker mode: ' + JSON.stringify(mode));
            }
        }
        return markers;
    }

    function buildEdl(title, markers, rate, clipSourceTc, timelineStartTc) {
        const sourceStart = parseTimecode(clipSourceTc, rate);
        const recordStart = parseTimecode(timelineStartTc, rate);

        let out = 'TITLE: ' + sanitize(title) + '\r\nFCM: NON-DROP FRAME\r\n\r\n';
        let eventNumber = 0;
        let previousRecordFrame = null;

        for (const marker of markers) {
            const beatFrame = secondsToFrames(marker.t, rate);
            const sourceIn = sourceStart + beatFrame;
            const recordIn = recordStart + beatFrame;

            // Two beats can round onto the same frame at extreme tempos;
            // emit one event per frame so Resolve never gets overlapping
            // 1-frame cuts.
            if (recordIn === previousRecordFrame) continue;
            previousRecordFrame = recordIn;
            eventNumber += 1;

            const eventLine =
                String(eventNumber).padStart(3, '0') + '  ' +
                '001      ' + 'V' + '     ' + 'C' + '        ' +
                framesToTimecode(sourceIn, rate) + ' ' +
                framesToTimecode(sourceIn + 1, rate) + ' ' +
                framesToTimecode(recordIn, rate) + ' ' +
                framesToTimecode(recordIn + 1, rate) + '  ';
            const markerLine =
                sanitize(marker.comment || '') + ' |C:' + marker.color +
                ' |M:' + sanitize(marker.name) + ' |D:1';
            out += eventLine + '\r\n' + markerLine + '\r\n\r\n';
        }
        return out;
    }

    // main.py::format_duration — h:mm:ss past an hour, else m:ss
    function formatDuration(seconds) {
        const total = pyRound(seconds);
        const hours = Math.floor(total / 3600);
        const remainder = total - hours * 3600;
        const minutes = Math.floor(remainder / 60);
        const secs = remainder - minutes * 60;
        if (hours) {
            return hours + ':' + pad2(minutes) + ':' + pad2(secs);
        }
        return minutes + ':' + pad2(secs);
    }

    /* ── exports (browser, worker, and node test harnesses) ───── */

    global.BarNone = {
        SR: SR,
        HOP_LENGTH: HOP_LENGTH,
        CUT_DENSITY_GAPS: CUT_DENSITY_GAPS,
        FRAME_RATES: FRAME_RATES,
        DEFAULT_FRAME_RATE_LABEL: DEFAULT_FRAME_RATE_LABEL,
        DEFAULT_CLIP_SOURCE_TC: DEFAULT_CLIP_SOURCE_TC,
        DEFAULT_TIMELINE_START_TC: DEFAULT_TIMELINE_START_TC,
        MODE_ALL: MODE_ALL,
        MODE_DOWNBEATS: MODE_DOWNBEATS,
        MODE_BOTH: MODE_BOTH,
        MODE_CUT: MODE_CUT,
        pyRound: pyRound,
        detectBeats: detectBeats,
        detectCutPoints: detectCutPoints,
        makeMarkers: makeMarkers,
        buildEdl: buildEdl,
        getFrameRate: getFrameRate,
        secondsToFrames: secondsToFrames,
        framesToTimecode: framesToTimecode,
        parseTimecode: parseTimecode,
        formatDuration: formatDuration,
        decodeAndResample: decodeAndResample,
        timeToFrames: timeToFrames,
        frameToTime: frameToTime,
    };
})(typeof self !== 'undefined' ? self : globalThis);
