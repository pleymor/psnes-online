/**
 * The life of one immersive session, and nothing about its contents.
 *
 * `local` is the only space asked for, and that is a decision rather than a
 * fallback. Wanting a real floor is what makes the Quest ask which boundary to
 * use, on every single entry, before the player can get in - and the floor
 * bought nothing: the scene was placed from a guessed 1.6 m eye height, which
 * is wrong for anybody sitting down. `local` is the stationary space, its
 * origin is the head's pose when the session opens, and `layout.ts` measures
 * every distance from the eyes. Nothing is guessed and nothing is asked.
 *
 * `local` is also guaranteed for an immersive session by the WebXR spec, so
 * there is no longer a degradation to handle, and no feature to negotiate.
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
