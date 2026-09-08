/**
 * La page de documentation, et sa parité entre les deux langues.
 *
 * Un trou de traduction sur cette page n'est pas cosmétique : elle porte ce que
 * le service fait de vos fichiers, ce qu'il garde de vous, et les références de
 * droit qui encadrent les ROMs. Une section, une puce ou un lien qui
 * n'existerait que dans une langue laisserait la moitié des lecteurs sans
 * l'information - et ce sont précisément les sections où le manque coûte le
 * plus cher qui sont les plus longues, donc les plus faciles à laisser
 * derrière.
 *
 * Les liens sont comparés par leur URL et non par leur libellé : c'est l'URL
 * qui est la même dans les deux langues, et une référence de loi présente d'un
 * seul côté serait exactement le trou que ce fichier existe pour interdire.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  DOCS,
  PRIVACY_CONTACT,
  DATA_CONTROLLER,
  type DocPage
} from '../../frontend/src/lib/docs/content.js';

const LOCALES = ['en', 'fr'] as const;

/** Les cinq sujets demandés, plus l'introduction du projet. */
const EXPECTED_SECTIONS = ['what', 'features', 'roms', 'saves', 'privacy', 'law'];

function pages(): DocPage[] {
  return LOCALES.map((locale) => DOCS[locale]);
}

test('les deux langues portent les mêmes sections, dans le même ordre', () => {
  for (const locale of LOCALES) {
    assert.deepEqual(
      DOCS[locale].sections.map((section) => section.id),
      EXPECTED_SECTIONS,
      `${locale} n'a pas les sections attendues`
    );
  }
});

test('rien n est vide, nulle part', () => {
  // Une chaîne vide se dessine comme un paragraphe absent : la page paraît
  // complète et il manque une phrase.
  for (const locale of LOCALES) {
    const page = DOCS[locale];
    assert.ok(page.title.trim().length > 0);
    assert.ok(page.intro.trim().length > 20, `${locale} : l intro est trop courte`);
    assert.ok(page.updated.trim().length > 0, `${locale} : la date manque`);

    for (const section of page.sections) {
      assert.ok(section.title.trim().length > 0, `${locale}/${section.id} : pas de titre`);
      assert.ok(section.body.length > 0, `${locale}/${section.id} : pas de corps`);
      for (const paragraph of [...section.body, ...(section.bullets ?? [])]) {
        assert.ok(paragraph.trim().length > 0, `${locale}/${section.id} : ligne vide`);
      }
      for (const link of section.links ?? []) {
        assert.ok(link.label.trim().length > 0, `${locale}/${section.id} : lien sans libellé`);
      }
    }
  }
});

test('chaque section est traduite ligne pour ligne', () => {
  const [en, fr] = pages();
  for (let i = 0; i < en.sections.length; i++) {
    const a = en.sections[i];
    const b = fr.sections[i];
    assert.equal(
      a.body.length,
      b.body.length,
      `${a.id} : ${a.body.length} paragraphes en anglais, ${b.body.length} en français`
    );
    assert.equal(
      (a.bullets ?? []).length,
      (b.bullets ?? []).length,
      `${a.id} : les puces ne correspondent pas`
    );
  }
});

test('les mêmes références de loi dans les deux langues', () => {
  const [en, fr] = pages();
  const hrefs = (page: DocPage) =>
    page.sections.flatMap((section) => (section.links ?? []).map((link) => link.href));

  assert.deepEqual(hrefs(en), hrefs(fr), 'une référence n existe que d un côté');
  assert.ok(hrefs(en).length >= 5, 'les références de loi ont disparu');
});

test('les liens de loi pointent vers Legifrance ou EUR-Lex, en https', () => {
  /*
   * Vérifié plutôt que supposé : les identifiants Legifrance sont opaques
   * (`LEGIARTI000044365559`), donc un lien tapé de mémoire ne ressemble pas à
   * une erreur - il ressemble à un lien. Ceux du module ont été relus un par
   * un sur le site ; ce test tient au moins la forme, et interdit qu'un
   * http:// ou un domaine tiers s y glisse.
   */
  const [en] = pages();
  const links = en.sections.flatMap((section) => section.links ?? []);
  for (const link of links) {
    const url = new URL(link.href);
    assert.equal(url.protocol, 'https:', `${link.href} n est pas en https`);
    assert.ok(
      url.hostname === 'www.legifrance.gouv.fr' || url.hostname === 'eur-lex.europa.eu',
      `${link.href} ne vient ni de Legifrance ni d EUR-Lex`
    );
  }
});

test('les quatre articles cités sont tous liés', () => {
  // Citer un article dans le texte sans donner le lien laisse le lecteur avec
  // une référence qu'il doit chercher lui-même.
  const [en] = pages();
  const labels = en.sections.flatMap((s) => (s.links ?? []).map((l) => l.label)).join(' ');
  for (const article of ['L122-4', 'L122-5', 'L122-6-1', 'L335-2']) {
    assert.ok(labels.includes(article), `${article} est cité mais pas lié`);
  }
});

test('le responsable et l adresse de contact figurent dans les deux langues', () => {
  // Une section RGPD sans contact est incomplète : c est par là que passent
  // l accès, la rectification et l effacement.
  for (const locale of LOCALES) {
    const privacy = DOCS[locale].sections.find((section) => section.id === 'privacy');
    const text = privacy!.body.join('\n');
    assert.ok(text.includes(PRIVACY_CONTACT), `${locale} : pas d adresse de contact`);
    assert.ok(text.includes(DATA_CONTROLLER), `${locale} : pas de responsable nommé`);
  }
});

test('l adresse de contact est une adresse, et le responsable un nom', () => {
  assert.match(PRIVACY_CONTACT, /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/);
  assert.ok(DATA_CONTROLLER.trim().length > 0);
});
