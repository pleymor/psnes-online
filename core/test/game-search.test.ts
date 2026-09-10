/**
 * Trouver un jeu dans sa propre bibliotheque.
 *
 * `rankCatalogue` cherche cote serveur et n est pas flou : exact, prefixe,
 * sous-chaine, rien d autre. Ici c est la bibliotheque du joueur, et ce qu il
 * tape est ce dont il se souvient - des initiales, un titre sans ses accents,
 * un mot du milieu.
 *
 * Ce qui est teste est l ordre autant que le filtre : une liste qui contient
 * le bon jeu en onzieme position n a pas repondu.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { searchGames } from '../../frontend/src/lib/games/search.js';

const LIBRARY = [
  { title: 'Donkey Kong Country', filename: 'dkc.sfc' },
  { title: 'Ducktales Classic', filename: 'ducktales.sfc' },
  { title: 'Pokémon Puzzle Challenge', filename: 'pkmn.sfc' },
  { title: 'The Legend of Zelda: A Link to the Past', filename: 'zelda3.sfc' },
  { title: 'Zelda', filename: 'zelda1.sfc' },
  { title: 'super-mario-world (usa) [!].sfc', filename: 'super-mario-world (usa) [!].sfc' }
];

const titles = (query: string) => searchGames(LIBRARY, query).map(g => g.title);

test('une recherche vide rend toute la bibliotheque', () => {
  assert.equal(searchGames(LIBRARY, '').length, LIBRARY.length);
  assert.equal(searchGames(LIBRARY, '   ').length, LIBRARY.length);
});

test('un seul caractere ne filtre pas', () => {
  // Une lettre correspond a presque tout et ordonnerait la bibliotheque au
  // hasard - la meme raison que `MIN_QUERY` cote catalogue.
  assert.equal(searchGames(LIBRARY, 'z').length, LIBRARY.length);
});

test('le titre exact vient en premier', () => {
  assert.equal(titles('zelda')[0], 'Zelda');
});

test('un prefixe passe devant une sous-chaine', () => {
  const found = titles('donkey');
  assert.equal(found[0], 'Donkey Kong Country');
});

test('les accents ne comptent pas', () => {
  // Personne ne tape l accent aigu pour chercher Pokemon.
  assert.deepEqual(titles('pokemon'), ['Pokémon Puzzle Challenge']);
});

test('la ponctuation ne compte pas', () => {
  // Le titre porte deux-points et le joueur non ; et un nom de fichier de
  // dump est un buisson de tirets, de parentheses et de crochets.
  assert.equal(titles('zelda a link')[0], 'The Legend of Zelda: A Link to the Past');
  assert.equal(titles('super mario world')[0], 'super-mario-world (usa) [!].sfc');
});

test('les initiales trouvent le jeu', () => {
  assert.equal(titles('dkc')[0], 'Donkey Kong Country');
});

test('les initiales passent devant une sous-sequence eparpillee', () => {
  // « dkc » est aussi une sous-sequence de « Ducktales Classic ». Sans cette
  // preference, taper trois lettres ramenerait la moitie de la bibliotheque
  // dans un ordre qui ne veut rien dire.
  const found = titles('dkc');
  assert.equal(found[0], 'Donkey Kong Country');
  assert.ok(
    found.indexOf('Donkey Kong Country') < found.indexOf('Ducktales Classic'),
    `ordre obtenu : ${found.join(' | ')}`
  );
});

test('un mot du milieu suffit', () => {
  assert.equal(titles('puzzle')[0], 'Pokémon Puzzle Challenge');
});

test('un jeu non identifie se trouve par son nom de fichier', () => {
  // Tant que rien ne l a identifie, son nom de fichier EST ce qu il montre.
  const found = searchGames(
    [{ title: 'mystery', filename: 'chrono-trigger.sfc' }],
    'chrono'
  );
  assert.equal(found.length, 1);
});

test('ce qui ne correspond pas disparait', () => {
  assert.deepEqual(titles('metroid'), []);
});

test('a egalite, le titre le plus court vient en premier', () => {
  // Deux jeux commencent par « zelda » ; celui qui n est QUE ca est le plus
  // probable quand on tape juste ca.
  const found = titles('zeld');
  assert.equal(found[0], 'Zelda');
});

test('deux recherches identiques donnent le meme ordre', () => {
  // Un tri instable fait danser la grille sous le curseur a chaque frappe.
  assert.deepEqual(titles('zelda'), titles('zelda'));
  assert.deepEqual(titles('c'), titles('c'));
});
