import { PrismaClient } from '@prisma/client';
import { findGameMetadata } from '../src/services/metadata-loader.js';

const prisma = new PrismaClient();

async function refreshMetadata() {
  const games = await prisma.game.findMany();

  console.log('Found', games.length, 'games to check');

  let updatedCount = 0;
  let skippedCount = 0;

  for (const game of games) {
    console.log('\nChecking:', game.title);
    const metadata = await findGameMetadata(game.title);

    if (metadata) {
      await prisma.game.update({
        where: { id: game.id },
        data: {
          title: metadata.title,
          genre: metadata.genre,
          publisher: metadata.publisher,
          developer: metadata.developer,
          releaseDate: metadata.releaseDate,
          players: metadata.players,
          region: metadata.region,
          description: metadata.description,
          coverUrl: metadata.coverUrl
        }
      });
      updatedCount++;
      console.log('✅ Updated to:', metadata.title);
    } else {
      skippedCount++;
      console.log('ℹ️  No metadata found');
    }
  }

  console.log('\n=== Summary ===');
  console.log('Total games:', games.length);
  console.log('Updated:', updatedCount);
  console.log('Skipped:', skippedCount);

  await prisma.$disconnect();
}

refreshMetadata().catch(console.error);
