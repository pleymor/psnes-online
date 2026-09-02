/**
 * The life of one immersive session, and nothing about its contents.
 *
 * `local-floor` is an OPTIONAL feature here, not a required one. Required, it
 * would make `requestSession` reject outright on a headset that cannot report a
 * floor - turning a cosmetic degradation, a scene placed from an assumed eye
 * height, into "VR does not work on your device". So the session is asked for
 * plainly and the reference space is where the fallback happens.
 *
 * `onEnd` fires exactly once, whatever ended the session. The system menu, the
 * quit button and a headset set down on the table all arrive as the same `end`
 * event, and `end()` raises it as well. Two calls would stop an already-stopped
 * engine and write the cartridge save twice.
 *
 * Its navigator is a parameter for the reason the rest of this codebase's
 * device code gives: so it can be tested without one.
 */

export type SpaceType = 'local-floor' | 'local';

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
  /** `'local'` tells the scene it is guessing the eye height rather than
   * measuring from a real floor. */
  spaceType: SpaceType;
  end(): Promise<void>;
}

export async function openVrSession(
  onEnd: () => void,
  nav: XrEntryNavigator | undefined = globalThis.navigator as XrEntryNavigator | undefined
): Promise<VrSession> {
  if (!nav?.xr?.requestSession) {
    throw new Error('WebXR is not available in this browser');
  }

  // Optional, not required - see the header. A rejection here is a real
  // refusal (permission, no device, a session already running) and belongs to
  // the caller, which keeps its button and explains itself.
  const session = await nav.xr.requestSession('immersive-vr', {
    optionalFeatures: ['local-floor']
  });

  let spaceType: SpaceType = 'local-floor';
  let referenceSpace: unknown;
  try {
    referenceSpace = await session.requestReferenceSpace('local-floor');
  } catch {
    referenceSpace = await session.requestReferenceSpace('local');
    spaceType = 'local';
  }

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
    spaceType,
    end: async () => {
      if (finished) return;
      // `end()` raises the event, which runs `finish`. Nothing else to do.
      await session.end();
    }
  };
}
