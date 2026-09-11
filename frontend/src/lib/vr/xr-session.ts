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
 * MEASURED, 2026-09-07, and this paragraph exists so nobody pulls that lever a
 * fourth time. A player reported entering VR stationary for a fraction of a
 * second and then being switched to a room zone. A temporary probe ran inside
 * a real session on a Quest and asked for the three spaces this page never
 * requests. All three were refused:
 *
 *     bounded-floor: NotSupportedError
 *     local-floor:   NotSupportedError
 *     unbounded:     NotSupportedError
 *     boundsPoints:  null
 *
 * That is the conformant refusal for a feature that was not asked for, so the
 * runtime provisioned no bounded space and no floor at any point - the session
 * is `local`-only for its whole life. `visibilityState` was sampled every
 * 100 ms for two and a half seconds and never left `visible`, so no transition
 * of ours coincides with what the player sees either.
 *
 * The switch is therefore the headset compositor's own, invisible from the
 * page. The only place to pin the boundary is the Quest's own setting. The
 * complete list of what this page asks WebXR is four calls -
 * `support.ts`'s `isSessionSupported`, the `requestSession` below with no init
 * dictionary, its `requestReferenceSpace('local')`, and three's own request of
 * the same type at `WebXRManager.js:509` - and none of them mentions a
 * boundary. There is no fifth call to remove.
 *
 * The probe's one blind spot, stated because it bounds the claim: it starts
 * after `setSession`, so it never saw the very first fraction of a second. The
 * refusals are time-independent and settle the question regardless; the
 * visibility sampling only speaks for what followed.
 *
 * `onEnd` fires exactly once, whatever ended the session. The system menu, the
 * quit button and a headset set down on the table all arrive as the same `end`
 * event, and `end()` raises it as well. Two calls would stop an already-stopped
 * engine and write the cartridge save twice.
 *
 * Its navigator is a parameter for the reason the rest of this codebase's
 * device code gives: so it can be tested without one.
 *
 * UPDATED, 2026-09-11: `local-floor` is now requested as an OPTIONAL feature,
 * solely to measure the floor's height (`decor/floor.ts`). The 2026-09-07
 * measurement above stays accurate and is still the reason for this change:
 * it observed the conformant refusal of a feature that was never asked for.
 * What has NOT changed: the scene's reference space is still `local`, three
 * still requests its own, and `layout.ts` still measures everything from the
 * eyes. No geometry becomes floor-relative, and a headset that refuses
 * `local-floor` still enters VR - the rejection is swallowed here, and only
 * here, because higher up it would mask a real failure to open the session.
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
  floorSpace: unknown | null;
  end(): Promise<void>;
}

export async function openVrSession(
  onEnd: () => void,
  nav: XrEntryNavigator | undefined = globalThis.navigator as XrEntryNavigator | undefined
): Promise<VrSession> {
  if (!nav?.xr?.requestSession) {
    throw new Error('WebXR is not available in this browser');
  }

  /*
   * One feature negotiated, and OPTIONAL.
   *
   * The header above tells of a 2026-09-07 probe that saw
   * `local-floor: NotSupportedError` on a Quest, and draws the right
   * conclusion from it: that is the conformant refusal of a feature that was
   * not asked for. Here it is asked for.
   *
   * What it serves, and nothing else: MEASURING where the floor is, so
   * `decor/floor.ts` can put the world's floor there. The anchor does not
   * change one bit - three still requests and uses its own `local`
   * (`WebXRManager.js:509`), and `scene.ts` still answers it with `local`. No
   * geometry in `layout.ts` becomes floor-relative.
   *
   * A rejection of `requestSession` itself is still a real refusal
   * (permission, no device, a session already running) and belongs to the
   * caller, which keeps its button and explains itself.
   */
  const session = await nav.xr.requestSession('immersive-vr', {
    optionalFeatures: ['local-floor']
  });

  const referenceSpace = await session.requestReferenceSpace('local');

  /*
   * The floor, requested separately and without consequence on failure.
   *
   * `requestReferenceSpace` rejects when the feature was not granted, and
   * that rejection is not an anomaly: it is the conformant answer of a
   * headset that does not know where the floor is. Swallowing it here is
   * therefore correct, and this is the only place where it is - higher up it
   * would mask a real failure to open the session.
   */
  let floorSpace: unknown | null = null;
  try {
    floorSpace = (await session.requestReferenceSpace('local-floor')) ?? null;
  } catch {
    floorSpace = null;
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
    floorSpace,
    end: async () => {
      if (finished) return;
      // `end()` raises the event, which runs `finish`. Nothing else to do.
      await session.end();
    }
  };
}
