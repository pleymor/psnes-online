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

/* ------------------------------------------------------------------ video */

export class CanvasRenderer {
	private ctx: CanvasRenderingContext2D;
	private image: ImageData | null = null;

	constructor(private canvas: HTMLCanvasElement) {
		const ctx = canvas.getContext('2d', { alpha: false });
		if (!ctx) throw new Error('could not get a 2D canvas context');
		this.ctx = ctx;
		this.ctx.imageSmoothingEnabled = false;
	}

	draw(core: PsnesCore): void {
		const frame = core.videoFrame();
		if (frame.width === 0 || frame.height === 0) return;

		if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
			this.canvas.width = frame.width;
			this.canvas.height = frame.height;
			this.image = null;
			this.ctx.imageSmoothingEnabled = false;
		}
		if (!this.image || this.image.width !== frame.width || this.image.height !== frame.height) {
			this.image = this.ctx.createImageData(frame.width, frame.height);
		}

		this.image.data.set(frame.data);
		this.ctx.putImageData(this.image, 0, 0);
	}
}

/* ------------------------------------------------------------------ audio */

/**
 * The worklet is a plain ring-buffer drain. All the policy lives on the main
 * thread, because the one thing this must never do is ask the emulator to
 * speed up or slow down.
 */
const WORKLET_SOURCE = `
class PsnesSink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.queued = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') { this.queue = []; this.offset = 0; this.queued = 0; return; }
      this.queue.push(e.data);
      this.queued += e.data.length / 2;
      // Hard cap: if the producer outruns the sink (fast-forward, a long
      // catch-up burst) drop the oldest audio rather than growing without
      // bound and drifting further behind the picture every second.
      while (this.queued > sampleRate) {
        const dropped = this.queue.shift();
        if (!dropped) break;
        this.queued -= dropped.length / 2;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] || outputs[0][0];
    for (let i = 0; i < left.length; i++) {
      const chunk = this.queue[0];
      if (!chunk) {
        // Underrun: the session is stalled waiting on a pad. Silence is the
        // honest output; repeating the last buffer would sound worse and
        // pretend progress that is not happening.
        left[i] = 0;
        right[i] = 0;
        continue;
      }
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
		this.node.connect(this.context.destination);
		this.ready = true;
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
