/* Bar None — Web Worker wrapper.
 *
 * Receives decoded mono PCM at 22050 Hz plus the chosen options, runs the
 * detection pipeline from barnone.js off the UI thread, and posts back
 * progress strings ({progress}) mirroring the desktop app, then either the
 * final result ({result}) or a friendly error ({error}).
 */
'use strict';

importScripts('barnone.js');

self.onmessage = function (event) {
    const data = event.data;
    try {
        const report = function (message) {
            self.postMessage({ progress: message });
        };

        let tempo = null;
        let beatCount = 0;
        let barCount = 0;
        let cutCount = 0;
        let times = [];
        let downbeats = [];
        let duration = data.pcm.length / data.sr;

        if (data.mode === BarNone.MODE_CUT) {
            const out = BarNone.detectCutPoints(data.pcm, data.gap, report);
            times = out.cutTimes;
            cutCount = times.length;
            duration = out.duration;
        } else {
            const out = BarNone.detectBeats(data.pcm, report);
            tempo = out.tempo;
            times = out.beatTimes;
            beatCount = times.length;
            downbeats = out.downbeats;
            barCount = downbeats.length;
            duration = out.duration;
        }

        const markers = BarNone.makeMarkers(times, downbeats, data.mode);
        const rate = BarNone.getFrameRate(data.fps);
        const edl = BarNone.buildEdl(
            data.title,
            markers,
            rate,
            data.clipTC,
            data.timelineTC
        );

        let firstMarkerTC = null;
        if (markers.length) {
            const base = BarNone.parseTimecode(data.timelineTC, rate);
            firstMarkerTC = BarNone.framesToTimecode(
                base + BarNone.secondsToFrames(markers[0].t, rate),
                rate
            );
        }

        self.postMessage({
            result: {
                tempo: tempo,
                beatCount: beatCount,
                barCount: barCount,
                cutCount: cutCount,
                duration: duration,
                edl: edl,
                firstMarkerTC: firstMarkerTC,
                error: null,
                markers: markers,
            },
        });
    } catch (err) {
        self.postMessage({
            error: { message: (err && err.message) || String(err) },
        });
    }
};
