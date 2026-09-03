/**
 * The life of one immersive session, and nothing about its contents.
 *
 * `local` is the only space asked for. The geometry in `layout.ts` is measured
 * from the eyes, so there is no floor height left to want, and `local` is
 * guaranteed for an immersive session by the WebXR spec - nothing to
 * negotiate, nothing to fall back from.
 *
 * It was changed hoping to stop the Quest asking which boundary to use before
 * every entry. It did not: that dialog is the system's own Guardian - "enter
 * the nearby boundary or resume where you left off" - it never names the site,
 * and it appears whatever the page requests. No web API reaches it. The change
 * is kept on its own merits, which are real: the old `local` fallback placed
 * the whole scene at a floor-relative height and would have hung it overhead,
 * and the 1.6 m eye height it guessed was wrong for a seated player.
 *
 * `onEnd` fires exactly once, whatever ended the session. The system menu, the
 * quit button and a headset set down on the table all arrive as the same `end`
 * event, and `end()` raises it as well. Two calls would stop an already-stopped
 * engine and write the cartridge save twice.
 *
 * Its navigator is a parameter for the reason the rest of this codebase's
 * device code gives: so it can be tested without one.
 */

/** The part of `XRSession` this module touches. three.js gets the real thing. */
export interface XrSessionLike {
  visibilityState: string;
  requestReferenceSpace(type: string): Promise<unknown>;
  addEventListener(type: string, fn: () => void): void;
  end(): Promise<void>;
}

export interface XrEntryNavigator {
  xr?: { requestSession(mode: string, init?: unknown): Promise<XrSessionLike> };
}

export interface VrSession {
  session: XrSessionLike;
  referenceSpace: unknown;
  end(): Promise<void>;
}

export async function openVrSession(
  onEnd: () => void,
  nav: XrEntryNavigator | undefined = globalThis.navigator as XrEntryNavigator | undefined
): Promise<VrSession> {
  if (!nav?.xr?.requestSession) {
    throw new Error('WebXR is not available in this browser');
  }

  // No features negotiated - see the header. A rejection here is a real
  // refusal (permission, no device, a session already running) and belongs to
  // the caller, which keeps its button and explains itself.
  const session = await nav.xr.requestSession('immersive-vr');

  const referenceSpace = await session.requestReferenceSpace('local');

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onEnd();
  };
  session.addEventListener('end', finish);

  return {
    session,
    referenceSpace,
    end: async () => {
      if (finished) return;
      // `end()` raises the event, which runs `finish`. Nothing else to do.
      await session.end();
    }
  };
}
