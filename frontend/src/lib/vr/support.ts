/**
 * The one question about the headset that the browser can answer honestly.
 *
 * `isSessionSupported` is the capability itself, and it decides everywhere a
 * headset can be. It says yes on a PC with a tethered headset too. That is
 * intended: such a player sees the button, and pressing it gives them the same
 * experience a Quest player gets, because the inputs arrive through
 * `XRInputSource` whatever the hardware. Their flat-screen settings sit
 * untouched behind it.
 *
 * It also says yes on an Android phone, where `immersive-vr` means a
 * Cardboard viewer. The capability is real there and the mode is useless: the
 * phone sits in the viewer, the room has no controller to read, and the player
 * gets a picture they cannot play. So a phone - or a tablet, which fares no
 * better - never sees the button, whatever the browser answers. That is the
 * one place the user agent is read, and it is read to say "handheld", never to
 * guess at a headset; see `handheld`.
 *
 * Takes its navigator, for the reason `znet/devices.ts:76` takes its own.
 */

export interface XrCapableNavigator {
  xr?: { isSessionSupported(mode: string): Promise<boolean> };
  userAgent?: string;
  /** User-Agent Client Hints, Chromium only. `mobile` is the hint itself. */
  userAgentData?: { mobile?: boolean };
  maxTouchPoints?: number;
}

/**
 * Headset browsers that run on Android, and say so in their user agent.
 *
 * Meta's Quest Browser has carried `Android` and `Mobile` in its UA in past
 * releases, Pico's still does, and Wolvic says `Mobile VR`. Each also names
 * itself, or the headset, or says `VR` - which is what keeps them out of the
 * phone test below. A headset this list misses would lose its button, so it
 * leans wide: any `VR` token is enough.
 */
const HEADSET = /OculusBrowser|Quest|PicoBrowser|Pico|Wolvic|\bVR\b/i;

/** Phones and tablets, by what their browsers say about themselves. */
const HANDHELD = /Android|iPhone|iPad|iPod|Mobile/i;

/**
 * Whether this is a phone or a tablet rather than a desktop or a headset.
 *
 * Several signals, any one of which is enough: the Client Hint where Chromium
 * gives it, a handheld token in the user agent, and an iPad that asks for the
 * desktop site - its UA then reads `Macintosh`, and only its touch points give
 * it away, no Mac having a touch screen. A headset is ruled out before any of
 * them, because a Quest or Pico UA can contain `Android` and `Mobile`.
 *
 * A pad connected to the phone does not bring the button back: a Bluetooth pad
 * is read inside a session (`bt-pad.ts`), but the phone is strapped into a
 * viewer by then, and nothing in the room can be pointed at without hands.
 */
export function handheld(nav: XrCapableNavigator | undefined): boolean {
  const ua = nav?.userAgent ?? '';
  if (HEADSET.test(ua)) return false;
  if (nav?.userAgentData?.mobile === true) return true;
  if (HANDHELD.test(ua)) return true;
  return /Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1;
}

export async function vrAvailable(
  nav: XrCapableNavigator | undefined = globalThis.navigator as XrCapableNavigator | undefined
): Promise<boolean> {
  if (!nav?.xr?.isSessionSupported) return false;
  if (handheld(nav)) return false;
  try {
    return await nav.xr.isSessionSupported('immersive-vr');
  } catch {
    // A permissions policy can reject this. A missing button is a far better
    // outcome than a library page that throws over an absent headset.
    return false;
  }
}
