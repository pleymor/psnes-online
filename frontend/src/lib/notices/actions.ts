/**
 * Les boutons, séparés du texte parce qu'ils ne se testent pas de la même
 * façon.
 *
 * `shapes.ts` est pur et se lit sous Bun. Les actions, elles, appellent
 * `acceptInvitation`, `sharing().accept` ou `offer.decline` - qui veulent la
 * socket, `$app/environment` et IndexedDB. Les importer depuis le registre
 * ferait entrer tout cela dans la suite de tests par un import transitif.
 *
 * Elles s'enregistrent donc à l'exécution, depuis `bridges.ts`, qui ne tourne
 * que dans un navigateur. Dans un test, la table est vide et le centre rend
 * des notifications sans boutons - ce qui est exactement ce qu'on veut y
 * tester.
 */

import type { NoticeAction } from './notice.js';

const table = new Map<string, readonly NoticeAction[]>();

export function registerNoticeActions(kind: string, actions: readonly NoticeAction[]): void {
  table.set(kind, actions);
}

export function actionsOf(kind: string): readonly NoticeAction[] {
  return table.get(kind) ?? [];
}

export function hasActions(kind: string): boolean {
  return actionsOf(kind).length > 0;
}
