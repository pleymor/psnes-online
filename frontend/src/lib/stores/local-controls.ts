import {
	defaultControlsConfig,
	normaliseControlsConfig,
	type ControlsConfig
} from '$lib/controls/binding';

/**
 * The bindings of a player without an account, kept on this device.
 *
 * With an account they live on the server (`/api/user/controls`), which a
 * player with no account and possibly no network cannot reach. Normalised on
 * the way out, like the server's copy, so a config written by an older build
 * still yields every button.
 */
const KEY = 'psnes.localControls';

export function readLocalControls(storage: Pick<Storage, 'getItem'>): ControlsConfig {
	try {
		const raw = storage.getItem(KEY);
		return raw ? normaliseControlsConfig(JSON.parse(raw)) : defaultControlsConfig();
	} catch {
		return defaultControlsConfig();
	}
}

export function writeLocalControls(storage: Pick<Storage, 'setItem'>, config: ControlsConfig): void {
	try {
		storage.setItem(KEY, JSON.stringify(config));
	} catch {
		// Storage blocked or full: the bindings last for this session only.
	}
}
