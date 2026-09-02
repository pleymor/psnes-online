/**
 * The one question about the headset that the browser can answer honestly.
 *
 * No user-agent sniffing: `OculusBrowser` in a UA string is a fact about a
 * release, not about a capability, and it rots. `isSessionSupported` is the
 * capability itself.
 *
 * It says yes on a PC with a tethered headset too. That is intended: such a
 * player sees the button, and pressing it gives them the same experience a
 * Quest player gets, because the inputs arrive through `XRInputSource` whatever
 * the hardware. Their flat-screen settings sit untouched behind it.
 *
 * Takes its navigator, for the reason `znet/devices.ts:76` takes its own.
 */

export interface XrCapableNavigator {
  xr?: { isSessionSupported(mode: string): Promise<boolean> };
}

export async function vrAvailable(
  nav: XrCapableNavigator | undefined = globalThis.navigator as XrCapableNavigator | undefined
): Promise<boolean> {
  if (!nav?.xr?.isSessionSupported) return false;
  try {
    return await nav.xr.isSessionSupported('immersive-vr');
  } catch {
    // A permissions policy can reject this. A missing button is a far better
    // outcome than a library page that throws over an absent headset.
    return false;
  }
}
