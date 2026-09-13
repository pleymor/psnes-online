/**
 * L'échappatoire du propriétaire, en ssh.
 *
 * Pas de colonne `isAdmin`, pas d'écran `/admin`. Une route privilégiée
 * exposée au web est une surface d'attaque permanente pour un besoin
 * occasionnel ; une commande derrière ssh a exactement la portée de l'accès
 * ssh, qui existe déjà.
 *
 * Écrit comme une fonction de (base, arguments) vers des lignes : c'est ce qui
 * le rend testable sans lancer de processus.
 *
 *     bun src/db/invite-cli.ts grant Sprite#0417
 *     bun src/db/invite-cli.ts list
 *     bun src/db/invite-cli.ts revoke <code>
 */

import { databaseFileFromUrl, openDatabase, type Database } from './sqlite.js';
import { findUserByHandle } from './users.js';
import { parseHandle } from '../utils/pseudo.js';
import {
  INVITE_QUOTA, countAccounts, countChargedInvites, findInviteByCode,
  listInvitesOf, maxUsers, mintInvite, revokeInvite
} from './signup-invites.js';

const USAGE = [
  'Usage :',
  '  grant <Pseudo#1234>   frappe une invitation qui ne débite pas son quota',
  '  list                  les places de la plateforme',
  '  revoke <code>         éteint un lien non consommé'
];

export function runInviteCli(db: Database, argv: string[]): { code: number; lines: string[] } {
  const [command, argument] = argv;

  if (command === 'list') {
    const lines = [`Comptes : ${countAccounts(db)} / ${maxUsers()}`];
    return { code: 0, lines };
  }

  if (command === 'grant') {
    const handle = parseHandle(argument);
    if (!handle) {
      return { code: 1, lines: [`Handle attendu sous la forme Sprite#0417, reçu « ${argument ?? ''} »`] };
    }
    const user = findUserByHandle(db, handle.pseudo, handle.discriminator);
    if (!user) {
      return { code: 1, lines: [`Aucun joueur ne porte ${argument}`] };
    }
    const invite = mintInvite(db, user.id, { grantedByCli: true });
    const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    return {
      code: 0,
      lines: [
        `Invitation hors quota pour ${argument} :`,
        `${base}/?invite=${invite.code}`,
        `(quota ordinaire : ${countChargedInvites(db, user.id)} / ${INVITE_QUOTA})`
      ]
    };
  }

  if (command === 'revoke') {
    const invite = argument ? findInviteByCode(db, argument) : null;
    if (!invite) {
      return { code: 1, lines: [`Aucun lien ne porte ce code`] };
    }
    if (invite.usedAt) {
      return { code: 1, lines: [`Ce lien est déjà consommé ; une place occupée ne se rend pas`] };
    }
    revokeInvite(db, invite.id);
    // `listInvitesOf` exclut les liens révoqués mais garde les liens
    // consommés : sa longueur n'est pas « vivants », c'est « non révoqués ».
    // Un joueur qui a déjà placé son unique invitation se ferait dire qu'il
    // lui en reste une. Seul `usedAt === null` est un lien encore vivant.
    const stillLive = listInvitesOf(db, invite.inviterId).filter(i => i.usedAt === null).length;
    return { code: 0, lines: [`Lien éteint. Il reste ${stillLive} lien(s) vivant(s) à son inviteur.`] };
  }

  return { code: 1, lines: USAGE };
}

// `import.meta.main` : vrai seulement quand ce fichier est le point d'entrée,
// donc jamais pendant les tests qui importent `runInviteCli`.
if (import.meta.main) {
  const db = openDatabase(databaseFileFromUrl(process.env.DATABASE_URL ?? 'file:./dev.db'));
  const { code, lines } = runInviteCli(db, process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exit(code);
}
