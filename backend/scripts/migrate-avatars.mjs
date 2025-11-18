import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

const AVATARS_DIR = path.join(process.cwd(), 'avatars');

async function ensureAvatarsDir() {
  try {
    await fs.mkdir(AVATARS_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create avatars directory:', error);
  }
}

async function downloadAvatar(url, userId) {
  try {
    await ensureAvatarsDir();

    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to download avatar from ${url}: ${response.status}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const contentType = response.headers.get('content-type');
    let ext = 'jpg';
    if (contentType?.includes('png')) {
      ext = 'png';
    } else if (contentType?.includes('gif')) {
      ext = 'gif';
    } else if (contentType?.includes('webp')) {
      ext = 'webp';
    }

    const hash = crypto.createHash('md5').update(userId).digest('hex');
    const filename = `${hash}.${ext}`;
    const filepath = path.join(AVATARS_DIR, filename);

    await fs.writeFile(filepath, buffer);

    return `/api/avatars/${filename}`;
  } catch (error) {
    console.error('Error downloading avatar:', error);
    return null;
  }
}

const prisma = new PrismaClient();

async function migrateAvatars() {
  console.log('🔄 Starting avatar migration...');

  try {
    // Get all users with Google avatar URLs
    const users = await prisma.user.findMany({
      where: {
        avatar: {
          contains: 'googleusercontent.com'
        }
      }
    });

    console.log(`📊 Found ${users.length} users with Google avatars`);

    let successCount = 0;
    let failCount = 0;

    for (const user of users) {
      console.log(`\n👤 Processing user: ${user.displayName} (${user.email})`);
      console.log(`   Current avatar: ${user.avatar}`);

      if (user.avatar && user.googleId) {
        const localAvatar = await downloadAvatar(user.avatar, user.googleId);

        if (localAvatar) {
          await prisma.user.update({
            where: { id: user.id },
            data: { avatar: localAvatar }
          });
          console.log(`   ✅ Downloaded and updated: ${localAvatar}`);
          successCount++;
        } else {
          console.log(`   ❌ Failed to download avatar`);
          failCount++;
        }
      }
    }

    console.log('\n📈 Migration completed!');
    console.log(`   ✅ Success: ${successCount}`);
    console.log(`   ❌ Failed: ${failCount}`);
  } catch (error) {
    console.error('❌ Migration error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

migrateAvatars();
