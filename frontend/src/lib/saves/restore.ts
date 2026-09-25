/**
 * Remettre en place une sauvegarde de cartouche que la synchronisation a
 * gardée au lieu de l'écraser (#71).
 *
 * Un échange, décidé par le serveur (`restoreKeptSram`) : la SRAM courante y
 * devient à son tour une sauvegarde datée. Ici, l'appareil suit - le local
 * prend les octets restaurés, la mémoire de synchronisation la nouvelle
 * version - pour que la prochaine écriture de la partie descende de ce qui
 * vient d'être restauré au lieu de le prendre pour un conflit.
 *
 * Aucun import `$lib` : `core/test` tourne sous node nu.
 */

import { fromBase64 } from './base64.js';
import type { LocalSaveStore } from './local-store.js';
import type { Outbox } from './outbox.js';
import { bytesHash } from './sync-rules.js';

/** La clé de contexte par laquelle une salle offre la restauration à son menu. */
export const RESTORE_SRAM = 'psnes.restore-sram';

/** Restaure la sauvegarde gardée `saveId`. Vrai si la machine a désormais cette SRAM. */
export type RestoreSram = (saveId: string) => Promise<boolean>;

export async function restoreKept(
	deps: {
		store: LocalSaveStore;
		outbox: Outbox;
		fetcher?: typeof fetch;
	},
	ctx: { checksum: string; userId: string; saveId: string }
): Promise<Uint8Array | null> {
	const fetcher = deps.fetcher ?? fetch;
	// Ce qui attend encore d'abord : restaurer par-dessus une SRAM que le
	// serveur n'a pas reçue la ferait arriver ensuite en conflit - gardée, donc
	// pas perdue, mais datée d'avant la restauration qu'elle suit pourtant.
	await deps.outbox.drain(ctx.userId, { checksum: ctx.checksum, force: true }).catch(() => undefined);

	const res = await fetcher(`/api/sync/${encodeURIComponent(ctx.checksum)}/sram/restore`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ saveId: ctx.saveId })
	});
	if (!res.ok) return null;
	const body = (await res.json()) as { sram: string; updatedAt: number };
	const bytes = fromBase64(body.sram);
	await deps.store.write(ctx.checksum, 'sram', bytes);
	await deps.outbox.setRecord(ctx.userId, ctx.checksum, { base: body.updatedAt, hash: bytesHash(bytes) });
	return bytes;
}
