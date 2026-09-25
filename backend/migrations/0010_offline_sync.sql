-- Hors-ligne d'abord (#71) : ce qu'une synchronisation garde au lieu d'écraser.
--
-- 0009 est réservé par le plan de #68, d'où le saut.
--
-- ------------------------------------------------------------------ kind
--
-- Quand la SRAM a divergé sur deux appareils, la plus récente devient la SRAM
-- du jeu et l'autre est gardée comme une sauvegarde datée (`saves/sync-plan.ts`).
-- Ce n'est pas un savestate : ce sont les octets de la pile de la cartouche,
-- et les donner à `loadState` chargerait n'importe quoi. `kind` le dit, pour
-- que le chargement la refuse et que l'écran propose de la restaurer plutôt
-- que de la charger. Tout ce qui existe déjà est un savestate.
--
-- ---------------------------------------------------------------- syncId
--
-- L'identifiant qu'un appareil donne à une écriture en attente. Une file qui
-- se vide au retour du réseau renvoie ce dont elle n'a pas reçu l'accusé, et
-- un accusé peut se perdre après que la ligne a été écrite : sans cette clé, le
-- second envoi ferait une seconde copie. Unique par jeu ; NULL pour tout ce qui
-- n'est pas venu par la file, et SQLite tient les NULL pour distincts.

ALTER TABLE "Save" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'state';
ALTER TABLE "Save" ADD COLUMN "syncId" TEXT;

CREATE UNIQUE INDEX "Save_gameId_syncId_key" ON "Save"("gameId", "syncId");
