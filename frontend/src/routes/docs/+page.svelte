<script lang="ts">
  /**
   * La documentation, en une page et une adresse.
   *
   * Une route et non une modale, pour la raison que la page de profil donne
   * pour elle-même : ceci se partage, s'ouvre dans un onglet et se quitte avec
   * le bouton retour. Et surtout, ça se lit sans compte - c'est la seule page
   * du site à devoir répondre à quelqu'un qui hésite encore à se connecter,
   * donc rien ici n'est derrière `requireAuth`.
   *
   * Le contenu vit dans `$lib/docs/content.ts`, dans les deux langues, avec un
   * test de parité. Cette page ne fait que le rendre : elle ne porte aucune
   * phrase à elle, ce qui est ce qui empêche une version française et une
   * version anglaise de diverger au fil des retouches de mise en page.
   */
  import { language } from '$lib/stores/language';
  import TopBar from '$lib/components/TopBar.svelte';
  import { DOCS } from '$lib/docs/content';

  $: page = DOCS[$language] ?? DOCS.en;
</script>

<svelte:head>
  <title>{page.title} · psnes</title>
  <meta name="description" content={page.intro} />
</svelte:head>

<TopBar />

<main class="docs">
  <header>
    <h1>{page.title}</h1>
    <p class="intro">{page.intro}</p>
  </header>

  <!--
    Un sommaire, parce que la section qui compte n'est pas la première.
    Quelqu'un qui arrive ici vient le plus souvent pour une question précise -
    « où sont mes ROMs », « qu'est-ce qui est gardé sur moi » - et la faire
    chercher au défilement lui coûterait la réponse.
  -->
  <nav class="toc" aria-label={page.title}>
    {#each page.sections as section}
      <a href={`#${section.id}`}>{section.title}</a>
    {/each}
  </nav>

  {#each page.sections as section}
    <!-- `id` sur la section elle-même : c'est l'ancre du sommaire. -->
    <section class="card" id={section.id}>
      <h2>{section.title}</h2>
      {#each section.body as paragraph}
        <p>{paragraph}</p>
      {/each}

      {#if section.bullets}
        <ul>
          {#each section.bullets as bullet}
            <li>{bullet}</li>
          {/each}
        </ul>
      {/if}

      {#if section.links}
        <ul class="links">
          {#each section.links as link}
            <li>
              <!--
                `rel="noreferrer"` avec `noopener` : ces liens partent vers
                Legifrance et EUR-Lex, et rien ne justifie de leur dire d'où
                vient le lecteur.
              -->
              <a href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/each}

  <p class="updated">{page.updated}</p>
</main>

<style>
  /* La même enveloppe que la page de profil : une colonne bornée, centrée. */
  .docs {
    width: 100%;
    max-width: 60rem;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  /* La même écriture que le titre de l'accueil, pour que cette page
     appartienne au site plutôt que d'avoir l'air d'une annexe - c'était
     déjà la raison, c'est le dégradé qui a changé de camp. */
  h1 {
    margin: 0 0 0.5rem;
    font-family: 'Silkscreen', monospace;
    font-size: 1.6rem;
    font-weight: 400;
    line-height: 1.4;
    color: var(--label);
  }

  .intro {
    margin: 0;
    color: #c8c8d0;
    /* 62 caractères par ligne environ : au-delà, l'œil perd la ligne
       suivante, et cette page est la seule du site qui se lit vraiment. */
    max-width: 46rem;
    font-size: 1.05rem;
    line-height: 1.6;
  }

  .toc {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .toc a {
    padding: 0.35rem 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    color: #c8c8d0;
    text-decoration: none;
    font-size: 0.9rem;
  }

  .toc a:hover,
  .toc a:focus-visible {
    border-color: var(--edge);
    background: var(--edge);
    color: var(--panel);
  }

  .card {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 14px;
    padding: 1.25rem 1.5rem;
    /* Le sommaire amène ici par une ancre : sans ce décalage, le titre de la
       section se retrouverait sous la barre du haut, qui est fixe. */
    scroll-margin-top: 5rem;
  }

  h2 {
    margin: 0 0 0.75rem;
    font-size: 1.3rem;
    color: #fff;
  }

  p,
  li {
    color: #b8b8c4;
    line-height: 1.65;
    max-width: 46rem;
  }

  p {
    margin: 0 0 0.75rem;
  }

  p:last-child {
    margin-bottom: 0;
  }

  ul {
    margin: 0;
    padding-left: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .links {
    list-style: none;
    padding-left: 0;
    margin-top: 1rem;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 0.5rem 1.25rem;
  }

  .links a {
    color: #8fa4ff;
  }

  .updated {
    margin: 0;
    color: #7a7a86;
    font-size: 0.85rem;
  }

  @media (max-width: 40rem) {
    .docs {
      padding: 1rem 1rem 3rem;
    }

    h1 {
      font-size: 1.6rem;
    }
  }
</style>
