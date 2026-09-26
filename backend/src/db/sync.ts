/**
 * Appliquer ce que `saves/sync-plan.ts` a décidé, dans une transaction.
 *
 * La règle est là-bas, et testée seule ; ici il n'y a que l'écriture. Chaque
 * fonction lit l'état, demande le plan et l'applique sans rendre la main :
 * deux appareils qui reviennent en même temps sur le même jeu ne doivent pas
 * pouvoir lire tous les deux « rien n'est stocké » et écrire l'un par-dessus
 * l'autre.
 *
 * `syncId` rend chaque envoi rejouable : la file du client renvoie ce dont elle
 * n'a pas eu l'accusé, et l'accusé peut se perdre après l'écriture. Une ligne
 * qui porte déjà ce `syncId` dit que l'envoi a déjà eu lieu.
 */

import { randomUUID } from 'node:crypto';
import { asBuffer, type Database } from './sqlite.js';
import {
  KEPT_SRAM_NAME,
  KEPT_STATE_NAME,
  QUICK_SAVE_NAME,
  planSramSync,
  planStateSync,
  type SramPlan,
  type StatePlan,
  type StoredState
} from '../saves/sync-plan.js';

export type SaveKind = 'state' | 'sram';

export interface SramSyncResult {
  outcome: SramPlan['kind'] | 'duplicate';
  /** La version désormais stockée - la prochaine `base` de l'appareil s'il l'adopte. */
  updatedAt: number;
  /** Les octets stockés, quand ce ne sont pas ceux que l'appareil vient d'envoyer. */
  sram: Buffer | null;
  /** La sauvegarde datée qui garde le perdant, s'il y en a eu un. */
  kept: { id: string; savedAt: number } | null;
}

export interface StateSyncResult {
  outcome: StatePlan['kind'] | 'duplicate';
  saveId: string;
}

function readSram(db: Database, gameId: string): { bytes: Buffer; updatedAt: number } | null {
  const row = db.query(`SELECT sram, sramUpdatedAt FROM "Game" WHERE id = ?`).get(gameId) as
    | { sram: Uint8Array | null; sramUpdatedAt: number | null }
    | undefined;
  if (!row?.sram) return null;
  // Une SRAM sans date - écrite avant qu'on date quoi que ce soit - est la plus
  // ancienne qui soit : zéro, et non « maintenant », qui la ferait gagner.
  return { bytes: asBuffer(row.sram), updatedAt: row.sramUpdatedAt ?? 0 };
}

function findBySyncId(db: Database, gameId: string, syncId: string): { id: string } | null {
  return (db.query(`SELECT id FROM "Save" WHERE gameId = ? AND syncId = ?`).get(gameId, syncId) as
    | { id: string }
    | undefined) ?? null;
}

function heads(db: Database, gameId: string): StoredState[] {
  return db.query(
    `SELECT id, name, slotNumber, kind, updatedAt FROM "Save" WHERE gameId = ?`
  ).all(gameId) as StoredState[];
}

function nextSlot(db: Database, gameId: string): number {
  const row = db.query(`SELECT MAX(slotNumber) AS highest FROM "Save" WHERE gameId = ?`)
    .get(gameId) as { highest: number | null };
  return (row.highest ?? 0) + 1;
}

function insertSave(
  db: Database,
  row: {
    gameId: string; name: string; slotNumber: number; data: Uint8Array; screenshot: string | null;
    kind: SaveKind; savedAt: number; syncId: string | null;
  }
): string {
  const id = randomUUID();
  // Datée du moment où elle a été jouée, pas de son arrivée ici : c'est ce que
  // le joueur lira sur la vignette pour savoir laquelle est laquelle.
  db.query(`
    INSERT INTO "Save" (id, name, slotNumber, data, screenshot, createdAt, updatedAt, gameId, kind, syncId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, row.name, row.slotNumber, row.data, row.screenshot, row.savedAt, row.savedAt,
    row.gameId, row.kind, row.syncId);
  return id;
}

function writeSram(db: Database, gameId: string, bytes: Uint8Array, updatedAt: number): void {
  db.query(`UPDATE "Game" SET sram = ?, sramUpdatedAt = ? WHERE id = ?`).run(bytes, updatedAt, gameId);
}

export function syncSram(
  db: Database,
  gameId: string,
  incoming: { bytes: Uint8Array; base: number | null; savedAt: number; syncId: string },
  now: number = Date.now()
): SramSyncResult {
  return db.transaction((): SramSyncResult => {
    const stored = readSram(db, gameId);

    const already = findBySyncId(db, gameId, incoming.syncId);
    if (already) {
      return {
        outcome: 'duplicate',
        updatedAt: stored?.updatedAt ?? 0,
        sram: stored?.bytes ?? null,
        kept: null
      };
    }

    const plan = planSramSync(stored, incoming, now);
    switch (plan.kind) {
      case 'same':
        return { outcome: 'same', updatedAt: plan.updatedAt, sram: null, kept: null };
      case 'write':
      case 'fast-forward':
        writeSram(db, gameId, incoming.bytes, plan.updatedAt);
        return { outcome: plan.kind, updatedAt: plan.updatedAt, sram: null, kept: null };
      case 'incoming-wins': {
        // Le stocké d'abord, et dans la même transaction : s'il n'était pas
        // gardé, l'écriture de la ligne suivante serait une perte.
        const keptId = insertSave(db, {
          gameId, name: KEPT_SRAM_NAME, slotNumber: nextSlot(db, gameId), data: stored!.bytes,
          screenshot: null, kind: 'sram', savedAt: plan.keep.savedAt, syncId: incoming.syncId
        });
        writeSram(db, gameId, incoming.bytes, plan.updatedAt);
        return {
          outcome: plan.kind, updatedAt: plan.updatedAt, sram: null,
          kept: { id: keptId, savedAt: plan.keep.savedAt }
        };
      }
      case 'stored-wins': {
        const keptId = insertSave(db, {
          gameId, name: KEPT_SRAM_NAME, slotNumber: nextSlot(db, gameId), data: incoming.bytes,
          screenshot: null, kind: 'sram', savedAt: plan.keep.savedAt, syncId: incoming.syncId
        });
        return {
          outcome: plan.kind, updatedAt: plan.updatedAt, sram: stored!.bytes,
          kept: { id: keptId, savedAt: plan.keep.savedAt }
        };
      }
    }
  })();
}

export function syncState(
  db: Database,
  gameId: string,
  incoming: {
    name: string; data: Uint8Array; screenshot: string | null; savedAt: number; syncId: string;
    replaces: { id: string; updatedAt: number } | null;
  },
  now: number = Date.now()
): StateSyncResult {
  return db.transaction((): StateSyncResult => {
    const already = findBySyncId(db, gameId, incoming.syncId);
    if (already) return { outcome: 'duplicate', saveId: already.id };

    const plan = planStateSync(heads(db, gameId), incoming, now);
    const row = {
      gameId, data: incoming.data, screenshot: incoming.screenshot, kind: 'state' as const,
      savedAt: plan.savedAt, syncId: incoming.syncId
    };
    switch (plan.kind) {
      case 'create':
        return {
          outcome: plan.kind,
          saveId: insertSave(db, { ...row, name: plan.name, slotNumber: plan.slotNumber })
        };
      case 'overwrite':
        db.query(`
          UPDATE "Save" SET data = ?, screenshot = ?, updatedAt = ?, syncId = ? WHERE id = ?
        `).run(incoming.data, incoming.screenshot, plan.savedAt, incoming.syncId, plan.id);
        return { outcome: plan.kind, saveId: plan.id };
      case 'take-quick':
        db.query(`UPDATE "Save" SET name = ? WHERE id = ?`).run(KEPT_STATE_NAME, plan.renameId);
        return {
          outcome: plan.kind,
          saveId: insertSave(db, { ...row, name: QUICK_SAVE_NAME, slotNumber: plan.slotNumber })
        };
      case 'keep-beside-quick':
        return {
          outcome: plan.kind,
          saveId: insertSave(db, { ...row, name: KEPT_STATE_NAME, slotNumber: plan.slotNumber })
        };
    }
  })();
}

export type RestoreResult =
  | { ok: true; sram: Buffer; updatedAt: number; kept: { id: string; savedAt: number } | null }
  | { ok: false; reason: 'not-found' };

/**
 * Remettre une SRAM gardée à sa place de SRAM.
 *
 * Un échange et non un écrasement : la SRAM courante devient à son tour une
 * sauvegarde datée, avant que la gardée prenne sa place. Restaurer par erreur
 * se défait donc en restaurant l'autre.
 */
export function restoreKeptSram(
  db: Database,
  gameId: string,
  saveId: string,
  now: number = Date.now()
): RestoreResult {
  return db.transaction((): RestoreResult => {
    const row = db.query(`SELECT data FROM "Save" WHERE id = ? AND gameId = ? AND kind = 'sram'`)
      .get(saveId, gameId) as { data: Uint8Array } | undefined;
    if (!row) return { ok: false, reason: 'not-found' };

    const current = readSram(db, gameId);
    let kept: { id: string; savedAt: number } | null = null;
    if (current) {
      const id = insertSave(db, {
        gameId, name: KEPT_SRAM_NAME, slotNumber: nextSlot(db, gameId), data: current.bytes,
        screenshot: null, kind: 'sram', savedAt: current.updatedAt, syncId: null
      });
      kept = { id, savedAt: current.updatedAt };
    }

    const updatedAt = Math.max(now, (current?.updatedAt ?? 0) + 1);
    writeSram(db, gameId, row.data, updatedAt);
    db.query(`DELETE FROM "Save" WHERE id = ?`).run(saveId);
    return { ok: true, sram: asBuffer(row.data), updatedAt, kept };
  })();
}

/** La SRAM stockée et sa version, pour la lecture HTTP. */
export function readStoredSram(
  db: Database,
  gameId: string
): { bytes: Buffer; updatedAt: number } | null {
  return readSram(db, gameId);
}

/**
 * Un savestate - ou une SRAM gardée - avec ses octets, pour l'appareil qui en
 * garde une copie (#71, la copie hors-ligne). Null si la sauvegarde n'est pas
 * de ce jeu : la même réponse que « n'existe pas », comme pour la suppression.
 */
export function readSaveOfGame(
  db: Database,
  gameId: string,
  saveId: string
): {
  id: string; name: string; kind: 'state' | 'sram'; screenshot: string | null;
  createdAt: number; updatedAt: number; syncId: string | null; data: Buffer;
} | null {
  const row = db.query(`
    SELECT id, name, kind, screenshot, createdAt, updatedAt, syncId, data
    FROM "Save" WHERE id = ? AND gameId = ?
  `).get(saveId, gameId) as {
    id: string; name: string; kind: string; screenshot: string | null;
    createdAt: number; updatedAt: number; syncId: string | null; data: Uint8Array;
  } | undefined;
  if (!row) return null;
  return { ...row, kind: row.kind === 'sram' ? 'sram' : 'state', data: asBuffer(row.data) };
}
