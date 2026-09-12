/**
 * Ce qu'il faut rendre quand une partie s'arrête, ou meurt avant de commencer.
 *
 * Deux façons de rendre un salon, choisies délibérément plutôt qu'une seule
 * appliquée partout - et les confondre coûte cher dans les deux sens.
 *
 * Un salon que le casque s'est créé pour lui-même n'a qu'un membre : le
 * quitter et le détruire sont le même acte, et `room:leave` est le bon geste.
 *
 * Un salon de GROUPE ne se quitte jamais ainsi. `room:leave` est, dans les
 * mots du lobby plat, « ce qui dissout un groupe de deux » - exactement ce que
 * quitter une partie PARTAGÉE ne doit pas faire. On y détache le jeu
 * (`room:release-game`) : le salon et ses membres survivent, et l'ami garde
 * son siège pour choisir autre chose.
 *
 * La décision vit ici plutôt que dans le composant parce qu'elle a trois
 * branches et qu'une chaîne de conditions dans un composant cache toujours sa
 * troisième - même partage que `game-click.ts` et `room-intent.ts`, pour la
 * même raison.
 */
import type { GroupRoom } from './game-click';

export type GiveUp =
	| { kind: 'leave'; roomId: string }
	| { kind: 'release'; roomId: string }
	| { kind: 'none' };

/**
 * `ownedRoomId` est le salon que ce casque a ouvert pour lui-même, `room`
 * celui du groupe auquel il appartient. Silencieux quand rien n'est dû, donc
 * appelable deux fois sans dommage.
 */
export function giveUpAction(
	ownedRoomId: string | null,
	room: GroupRoom | null | undefined
): GiveUp {
	if (ownedRoomId) return { kind: 'leave', roomId: ownedRoomId };
	if (!room) return { kind: 'none' };

	/*
	 * LE NOMBRE DE JOUEURS N'EST PAS UN CRITÈRE, et l'avoir cru a coûté une
	 * soirée.
	 *
	 * La condition portait `players.length >= 2`, sans doute parce qu'un
	 * groupe est fait de deux personnes. Mais rendre un jeu ne dissout rien :
	 * le serveur remet le salon en `waiting` et efface le jeu, que le salon
	 * compte un membre ou deux.
	 *
	 * Ce que la garde produisait, rapporté de la production le 2026-09-12 : le
	 * moteur mourait au lancement, le `catch` appelait cette décision en
	 * croyant nettoyer, elle ne rendait rien, et le salon restait en `playing`
	 * avec un jeu mort dedans. L'écran de lancement refusait alors toute
	 * nouvelle partie par « ce salon joue déjà » - et le seul émetteur non
	 * gardé de `room:release-game` étant la page plate, il fallait retirer le
	 * casque pour se débloquer.
	 *
	 * Le statut, lui, reste un critère : un salon qui n'a jamais commencé à
	 * jouer ne doit rien, et c'est ce qui rend cette fonction appelable deux
	 * fois.
	 */
	if (room.status !== 'playing') return { kind: 'none' };

	return { kind: 'release', roomId: room.id };
}
