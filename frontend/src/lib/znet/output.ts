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
    // Silence before the first sound is not owed audio: the context starts
    // with the room and the emulator's first frame comes later. Nothing was
    // stalled, the game had simply not begun.
    this.started = false;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') { this.queue = []; this.offset = 0; this.queued = 0; this.starved = 0; this.started = false; return; }
      this.queue.push(e.data);
      this.queued += e.data.length / 2;
      /*
       * Past the high mark, cut the backlog back to the target.
       *
       * A ceiling is not enough, and a second of one was far too much. The
       * debt paid on starvation only fires when the sink runs dry, and a deep
       * queue never runs dry - so once the backlog is past the point of
       * starving, nothing pulls it down and every burst adds to it for good.
       * Measured in production: 363ms held on one machine against 160 on the
       * other, while the platform's own path accounted for 44 and 50. Sound
       * and picture agreed at first and drifted apart the longer the session
       * ran.
       *
       * So it is a target, not a ceiling: 120ms of slack to absorb a burst,
       * cut back to 50ms - two to three frames - when that is exceeded. The
       * trade is deliberate, and it is the one a fighting game wants: cutting
       * more often costs the occasional glitch, while a third of a second of
       * standing delay costs every input.
       */
      const high = Math.round(sampleRate * 0.12);
      const target = Math.round(sampleRate * 0.05);
      let excess = this.queued > high ? this.queued - target : 0;
      while (excess > 0 && this.queue.length > 0) {
        const stale = this.queue[0];
        const available = (stale.length - this.offset) / 2;
        const drop = Math.min(available, excess);
        this.offset += drop * 2;
        this.queued -= drop;
        excess -= drop;
        if (this.offset >= stale.length) { this.queue.shift(); this.offset = 0; }
      }

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
    while (this.starved > 0 && this.queue.length > 0) {
      const stale = this.queue[0];
      const available = (stale.length - this.offset) / 2;
      const drop = Math.min(available, this.starved);
      this.offset += drop * 2;
      this.queued -= drop;
      this.starved -= drop;
      if (this.offset >= stale.length) { this.queue.shift(); this.offset = 0; }
    }

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
      this.port.postMessage({ type: 'depth', frames: this.queued });
    }

    for (let i = 0; i < left.length; i++) {
      const chunk = this.queue[0];
      if (!chunk) {
        // Underrun: the session is stalled waiting on a pad. Silence is the
        // honest output; repeating the last buffer would sound worse and
        // pretend progress that is not happening.
        left[i] = 0;
        right[i] = 0;
        if (this.started) this.starved++;
        continue;
      }
      this.started = true;
      left[i] = chunk[this.offset] / 32768;
      right[i] = chunk[this.offset + 1] / 32768;
      this.offset += 2;
      this.queued--;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
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
			const data = e.data as { type?: string; frames?: number } | null;
			if (data?.type === 'depth' && typeof data.frames === 'number') {
				this.queuedFrames = data.frames;
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
	get latency(): { queued: number | null; output: number | null } {
		const context = this.context;
		if (!context || this.rate <= 0) return { queued: null, output: null };
		const output = (context.outputLatency ?? 0) + (context.baseLatency ?? 0);
		return {
			queued: Math.round((this.queuedFrames / this.rate) * 1000),
			output: Math.round(output * 1000)
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
