/**
 * Video and audio output for the lockstep core.
 *
 * Both are deliberately one-way and stateless with respect to emulation: the
 * core produces a frame and some samples, these push them at the hardware, and
 * nothing here can ever feed back into the emulated machine. That is a
 * requirement, not a style choice - anything that let audio timing influence
 * emulation (dynamic rate control, dropped frames, "catch up if behind") would
 * make two peers diverge.
 */

import type { PsnesCore } from './core.js';
import type { PixelAspect } from './fit.js';

/* ------------------------------------------------------------------ video */

/**
 * Display options.
 *
 * All of these are local and cosmetic: they change how a frame is shown, never
 * what the emulator computes, so two players can pick differently without any
 * risk to the lockstep.
 */
export interface DisplayOptions {
	/**
	 * How the picture is presented: 'square' for 1:1 pixels (8:7 at 256x224),
	 * 'crt' for the 4:3 shape the games were composed for.
	 *
	 * The renderers do not read this - the room does, to size the canvas box.
	 * It lives here because it is display state and travels with the rest.
	 */
	aspect: PixelAspect;
	/**
	 * A libretro shader id such as `xbrz/6xbrz-linear`, or '' for none.
	 *
	 * Neither renderer reads this field - the room does. It picks the shader,
	 * swaps `WebglRenderer` in or out, and stores the id here so the toolbar
	 * button and the renderer's other options keep travelling together as one
	 * `DisplayOptions` value. Like the rest of this interface it is local and
	 * cosmetic and never crosses the network.
	 */
	shader: string;
}

export const DEFAULT_DISPLAY: DisplayOptions = {
	aspect: 'square',
	shader: ''
};

/**
 * What a room needs from a renderer.
 *
 * Both renderers implement this, so the room picks one at boot and never has
 * to know which it got. Deliberately tiny, and deliberately without any method
 * that could let a renderer influence when a frame runs.
 */
export interface Renderer {
	setOptions(options: DisplayOptions): void;
	draw(core: PsnesCore): void;
	dispose(): void;
}

export class CanvasRenderer implements Renderer {
	private ctx: CanvasRenderingContext2D;
	private image: ImageData | null = null;
	private options: DisplayOptions = { ...DEFAULT_DISPLAY };

	constructor(private canvas: HTMLCanvasElement) {
		const ctx = canvas.getContext('2d', { alpha: false });
		if (!ctx) throw new Error('could not get a 2D canvas context');
		this.ctx = ctx;
		this.applyOptions();
	}

	setOptions(options: DisplayOptions): void {
		this.options = { ...options };
		this.applyOptions();
	}

	private applyOptions(): void {
		// Always nearest-neighbour here: this path's buffer is the SNES frame at
		// its native size, so it is only ever scaled UP to the display, and hard
		// pixels are the point. (imageSmoothingEnabled would not matter either
		// way - putImageData ignores it.)
		this.canvas.style.imageRendering = 'pixelated';
	}


	draw(core: PsnesCore): void {
		const frame = core.videoFrame();
		if (frame.width === 0 || frame.height === 0) return;

		if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
			this.canvas.width = frame.width;
			this.canvas.height = frame.height;
			this.image = null;
			// Resizing a canvas resets its context, including smoothing.
			this.applyOptions();
		}
		if (!this.image || this.image.width !== frame.width || this.image.height !== frame.height) {
			this.image = this.ctx.createImageData(frame.width, frame.height);
		}

		this.image.data.set(frame.data);
		this.ctx.putImageData(this.image, 0, 0);
	}

	/** Nothing to release: a 2D context holds no GL objects. Here for symmetry. */
	dispose(): void {
		this.image = null;
	}
}

/* ------------------------------------------------------------------ audio */

/**
 * The worklet is a plain ring-buffer drain. All the policy lives on the main
 * thread, because the one thing this must never do is ask the emulator to
 * speed up or slow down.
 *
 * Exported so the tests can evaluate *this* source in a stubbed worklet scope
 * rather than reason about a copy of it. A copy drifts, and the drift is
 * silent - the bookkeeping below already went wrong once and no test could
 * have seen it.
 */
export const WORKLET_SOURCE = `
class PsnesSink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.queued = 0;
    this.starved = 0;
    this.reportAt = 0;
    // Frames thrown away since the stream began, and the fractional part of the
    // read position. The first is a diagnostic - discarding audio is a click,
    // so how often it happens belongs in the logs. The second is what lets the
    // backlog be drained by reading faster instead.
    this.dropped = 0;
    this.frac = 0;
    // Silence before the first sound is not owed audio: the context starts
    // with the room and the emulator's first frame comes later. Nothing was
    // stalled, the game had simply not begun.
    this.started = false;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') { this.queue = []; this.offset = 0; this.queued = 0; this.starved = 0; this.started = false; this.frac = 0; return; }
      this.queue.push(e.data);
      this.queued += e.data.length / 2;
      /*
       * An excursion is cut back at once; drift is not cut at all.
       *
       * Reading one percent faster answers the slow drift a session shows, and
       * would need a hundred seconds to answer a second of backlog. Minimising
       * the window and restoring it, or releasing fast-forward, puts the
       * producer hundreds of milliseconds ahead in one go - draining is the
       * wrong tool for that, and the player hears the sound stay late.
       *
       * So the cut returns, at a threshold ordinary play never reaches. The
       * 120ms it briefly sat at was inside the normal range, which is exactly
       * why it clicked constantly. Past 400ms nothing is ordinary, and someone
       * who just let go of fast-forward will take one glitch over a sound that
       * stays half a second behind.
       */
      const excursion = Math.round(sampleRate * 0.4);
      const back = Math.round(sampleRate * 0.05);
      let excess = this.queued > excursion ? this.queued - back : 0;
      while (excess > 0 && this.queue.length > 0) {
        const stale = this.queue[0];
        const available = (stale.length - this.offset) / 2;
        const cut = Math.min(available, excess);
        this.offset += cut * 2;
        this.queued -= cut;
        this.dropped += cut;
        excess -= cut;
        if (this.offset >= stale.length) { this.queue.shift(); this.offset = 0; }
      }

      /*
       * The backlog is no longer cut back here.
       *
       * It used to be: past a high mark, 70ms were thrown away at once. Every
       * such throw is a discontinuity in the signal - a click - and the player
       * heard them as crackling. The render loop drains the same backlog by
       * reading very slightly faster, with nothing discarded at all.
       *
       * What remains below is the last line of defence, at a second, for a
       * producer no playback speed could ever catch up with.
       */
      // The old hard cap, kept as the last line of defence against a producer
      // that somehow outruns even the target.
      while (this.queued > sampleRate) {
        const dropped = this.queue.shift();
        if (!dropped) break;
        // Only what is LEFT in the chunk. process() already decremented
        // \`queued\` once per frame it played out of this one, so subtracting
        // the whole length here would subtract the played part a second time -
        // \`queued\` then reads under the real backlog, the condition above
        // stops holding when it should, and the cap drifts open. Measured: the
        // backlog settles half a second past the cap in the harness, and past
        // two seconds in a real session.
        // \`offset\` counts interleaved values, \`queued\` counts frames.
        this.dropped += dropped.length / 2 - this.offset / 2;
        this.queued -= dropped.length / 2 - this.offset / 2;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] || outputs[0][0];

    /*
     * Audio for a moment already played as silence is stale.
     *
     * Starving costs real time and consumes nothing, but the emulator does not
     * skip the frames it owed - when the peer catches up it runs them, and
     * their audio arrives for a moment that is already spent. Playing it
     * anyway pushes everything after it back by the length of the stall, for
     * good, and again at every stall. In lockstep the queue starves on every
     * wait for a pad, which is how the delay reached the cap in about a minute
     * and then sat there.
     *
     * So the debt is paid in dropped audio rather than in latency: a brief
     * glitch instead of a delay that never comes back.
     */
    const target = Math.round(sampleRate * 0.05);

    /*
     * Only an outage is paid for.
     *
     * A lockstep follower waits on its peer's pad by construction - it is not
     * falling behind, it is keeping step - and paying for each of those waits
     * in discarded audio turns a normal rhythm into a continuous crackle.
     * Measured on 2026-09-22: the phone stalled 754 times in 135 seconds and
     * threw away 3152ms of audio, some 23ms a second, while the peer that
     * stalls 8 times threw away none. Pinning the delay to five frames changed
     * nothing, which is the proof this has nothing to do with the pad buffer:
     * the debt looks at the audio queue, not at that one.
     *
     * Anything a drain can absorb is left to the drain, which discards nothing.
     * Two frames of debt is the line: below it the queue is merely breathing.
     */
    const payable = this.starved > sampleRate * 0.04;

    while (payable && this.starved > 0 && this.queue.length > 0) {
      /*
       * Only ever out of surplus. A debt paid from a queue that is already at
       * or below the target makes the starvation it answers strictly worse,
       * and the result sustains itself: the queue starves, the debt grows, the
       * audio that arrives is thrown away to settle it, so the queue starves
       * again.
       *
       * Measured in production on 2026-09-22, after a window was minimised and
       * restored: the emulator back at 60fps and drawing normally, the queue
       * held at 6-23ms against a healthy 26-47, and 150 to 250ms of audio
       * discarded every second for as long as the session lasted. At the bench
       * it settles at a hundred percent of everything produced.
       *
       * The debt keeps what it cannot collect: a later surplus settles it, and
       * the break guard below bounds how large it can grow meanwhile.
       */
      const spare = this.queued - target;
      if (spare <= 0) break;

      const stale = this.queue[0];
      const available = (stale.length - this.offset) / 2;
      const drop = Math.min(available, this.starved, spare);
      this.offset += drop * 2;
      this.queued -= drop;
      this.starved -= drop;
      this.dropped += drop;
      if (this.offset >= stale.length) { this.queue.shift(); this.offset = 0; }
    }

    /*
     * Forgiven only once the starvation is over, never during it.
     *
     * Clearing a small debt while the queue is still empty means a long outage
     * never accumulates enough to be worth paying: each quantum forgives what
     * the one before it added, and the debt never crosses the line. So the
     * condition is that audio has come back - then a debt too small for a cut
     * is dropped rather than banked, where it would pile up over a minute of
     * ordinary waiting and be paid in one audible lump.
     */
    if (!payable && this.queue.length > 0) this.starved = 0;

    /*
     * Say how deep the queue is, for the main thread to ship.
     *
     * A constant offset between a machine's sound and its own picture has two
     * halves that call for opposite answers: what the platform adds below the
     * API - outputLatency, commonly 100-200ms on Android and beyond reach from
     * a page - and what this queue is holding, which is entirely ours to
     * shorten. Only here is the second one known.
     *
     * On a counter, not every quantum: 128 frames a quantum would be some 375
     * messages a second across the thread for a figure read once a second.
     */
    if (++this.reportAt >= 64) {
      this.reportAt = 0;
      this.port.postMessage({ type: 'depth', frames: this.queued, dropped: this.dropped });
    }

    /*
     * How fast to read, which is how the backlog is drained.
     *
     * At or below the target, nominal. Above it, up to one percent faster -
     * about seventeen cents of pitch, which no one hears - and the excess
     * empties itself instead of being cut out. The ramp reaches full speed at
     * a tenth of a second of excess, so ordinary jitter is barely touched
     * while a real backlog comes down steadily.
     *
     * A percent buys some 480 frames a second at 48kHz, far more than the
     * drift a session actually shows, so the queue converges rather than
     * merely stops growing.
     */
    const over = this.queued - target;
    const step = over <= 0 ? 1 : 1 + 0.01 * Math.min(1, over / (sampleRate * 0.1));

    for (let i = 0; i < left.length; i++) {
      const chunk = this.queue[0];
      if (!chunk) {
        // Underrun: the session is stalled waiting on a pad. Silence is the
        // honest output; repeating the last buffer would sound worse and
        // pretend progress that is not happening.
        left[i] = 0;
        right[i] = 0;
        if (this.started) {
          this.starved++;
          /*
           * Past half a second of continuous silence this is no longer a
           * lockstep stall to make up for - it is a break in the stream. A
           * pause, a backgrounded tab, an outage: the listener lost continuity
           * long ago, and resuming cleanly costs nothing more than resuming
           * late.
           *
           * Without this the debt grew for the whole length of a pause and was
           * then paid in dropped audio, so play came back silent for as long
           * as it had been paused and then lurched into the middle of a sound.
           * The same trap as the silence before the first sound, sprung in the
           * middle of a session instead of at its start - so it is answered
           * the same way, by declaring the stream not started.
           */
          if (this.starved > sampleRate * 0.5) {
            this.starved = 0;
            this.started = false;
          }
        }
        continue;
      }
      this.started = true;

      /*
       * Linear interpolation between this frame and the next, so the read
       * position can sit between two samples. Written out in scalars rather
       * than through a helper returning a pair: this runs 48000 times a second
       * on the audio thread, and an allocation per sample is a way to make a
       * glitch out of the very thing that removes them.
       */
      const a0 = chunk[this.offset];
      const a1 = chunk[this.offset + 1];
      let b0 = a0;
      let b1 = a1;
      if (this.offset + 3 < chunk.length) {
        b0 = chunk[this.offset + 2];
        b1 = chunk[this.offset + 3];
      } else {
        const next = this.queue[1];
        if (next) {
          b0 = next[0];
          b1 = next[1];
        }
      }

      const f = this.frac;
      left[i] = (a0 + (b0 - a0) * f) / 32768;
      right[i] = (a1 + (b1 - a1) * f) / 32768;

      this.frac += step;
      while (this.frac >= 1) {
        this.frac -= 1;
        const head = this.queue[0];
        if (!head) break;
        this.offset += 2;
        this.queued--;
        if (this.offset >= head.length) {
          this.queue.shift();
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('psnes-sink', PsnesSink);
`;

export class AudioSink {
	private context: AudioContext | null = null;
	private node: AudioWorkletNode | null = null;
	private ready = false;
	private muted = false;
	/** Frames the worklet last said it was holding, and the rate to read it in ms. */
	private queuedFrames = 0;
	private droppedFrames = 0;
	private rate = 0;

	async start(sampleRate: number): Promise<void> {
		if (this.ready) return;

		this.context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
		const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
		try {
			await this.context.audioWorklet.addModule(url);
		} finally {
			URL.revokeObjectURL(url);
		}

		this.node = new AudioWorkletNode(this.context, 'psnes-sink', { outputChannelCount: [2] });
		this.node.port.onmessage = (e) => {
			const data = e.data as { type?: string; frames?: number; dropped?: number } | null;
			if (data?.type === 'depth' && typeof data.frames === 'number') {
				this.queuedFrames = data.frames;
				if (typeof data.dropped === 'number') this.droppedFrames = data.dropped;
			}
		};
		this.node.connect(this.context.destination);
		this.rate = sampleRate;
		this.ready = true;
	}

	/**
	 * How long the sound is behind the picture on this machine, split in two.
	 *
	 * `queued` is what our own buffer is holding and is ours to shorten;
	 * `output` is what the platform adds below the API between handing the
	 * samples over and the speaker, which a page cannot touch at all - commonly
	 * 100-200ms on Android against 10-30ms on a desktop. A constant offset is
	 * only actionable in the first half, and nothing else distinguishes them.
	 *
	 * Both null before the context exists.
	 */
	get latency(): { queued: number | null; output: number | null; dropped: number | null } {
		const context = this.context;
		if (!context || this.rate <= 0) return { queued: null, output: null, dropped: null };
		const output = (context.outputLatency ?? 0) + (context.baseLatency ?? 0);
		return {
			queued: Math.round((this.queuedFrames / this.rate) * 1000),
			output: Math.round(output * 1000),
			// Cumulative, like `stalls`: audio thrown away is a click, so how
			// much of it there has been is the figure that says whether the
			// drain is doing its job or the axe is doing it for him.
			dropped: Math.round((this.droppedFrames / this.rate) * 1000)
		};
	}

	/**
	 * Whether the browser is actually holding audio until a user gesture.
	 *
	 * Ask rather than assume. A room reached by clicking - which is every room -
	 * usually has user activation already, so the context starts running and no
	 * gesture is needed. Callers that assumed otherwise showed a "click for
	 * sound" button that did nothing, because `resume()` is a no-op on a context
	 * that was never suspended.
	 */
	get needsGesture(): boolean {
		return this.context?.state === 'suspended';
	}

	/** Browsers block audio until a gesture; call this from a click handler. */
	async resume(): Promise<void> {
		if (this.context?.state === 'suspended') await this.context.resume();
	}

	push(samples: Int16Array): void {
		if (!this.ready || this.muted || samples.length === 0) return;
		// Transferred, not copied: the core hands us a fresh slice each frame.
		this.node!.port.postMessage(samples, [samples.buffer]);
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
		if (muted) this.node?.port.postMessage('flush');
	}

	/** Drops buffered audio - use after a resync, where the old audio is wrong. */
	flush(): void {
		this.node?.port.postMessage('flush');
	}

	async stop(): Promise<void> {
		this.node?.disconnect();
		this.node = null;
		this.ready = false;
		await this.context?.close();
		this.context = null;
	}
}
