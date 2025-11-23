import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from './logger.js';

const logger = createLogger('Avatar');
const AVATARS_DIR = path.join(process.cwd(), 'avatars');

/**
 * Ensure avatars directory exists
 */
export async function ensureAvatarsDir() {
  try {
    await fs.mkdir(AVATARS_DIR, { recursive: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to create avatars directory');
  }
}

/**
 * Download and save an avatar from a URL
 * @param url - The URL of the avatar to download
 * @param userId - The user ID to use for the filename
 * @returns The local path to the saved avatar, or null if failed
 */
export async function downloadAvatar(url: string, userId: string): Promise<string | null> {
  try {
    await ensureAvatarsDir();

    // Download the image
    const response = await fetch(url);
    if (!response.ok) {
      logger.error({ url, status: response.status }, 'Failed to download avatar');
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Detect file extension from content-type or URL
    const contentType = response.headers.get('content-type');
    let ext = 'jpg'; // default
    if (contentType?.includes('png')) {
      ext = 'png';
    } else if (contentType?.includes('gif')) {
      ext = 'gif';
    } else if (contentType?.includes('webp')) {
      ext = 'webp';
    }

    // Create filename using userId hash to avoid collisions
    const hash = crypto.createHash('md5').update(userId).digest('hex');
    const filename = `${hash}.${ext}`;
    const filepath = path.join(AVATARS_DIR, filename);

    // Save the file
    await fs.writeFile(filepath, buffer);

    // Return the URL path (not filesystem path)
    return `/api/avatars/${filename}`;
  } catch (error) {
    logger.error({ err: error, url }, 'Error downloading avatar');
    return null;
  }
}

/**
 * Delete an avatar file
 * @param filename - The filename of the avatar to delete
 */
export async function deleteAvatar(filename: string): Promise<void> {
  try {
    const filepath = path.join(AVATARS_DIR, filename);
    await fs.unlink(filepath);
  } catch (error) {
    // Ignore errors if file doesn't exist
    logger.debug({ err: error, filename }, 'Error deleting avatar');
  }
}

/**
 * Get the filesystem path for the avatars directory
 */
export function getAvatarsDir(): string {
  return AVATARS_DIR;
}
