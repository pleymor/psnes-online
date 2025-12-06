import { google } from 'googleapis';
import { prisma } from '../db/prisma.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('GoogleDrive');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

export async function getValidAccessToken(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user?.googleAccessToken) {
    throw new Error('User not authenticated with Google Drive');
  }

  // Check if token is still valid (with 5 min buffer)
  const bufferTime = 5 * 60 * 1000;
  if (user.googleTokenExpiry && user.googleTokenExpiry.getTime() > Date.now() + bufferTime) {
    return decrypt(user.googleAccessToken);
  }

  // Token expired - need to refresh
  if (!user.googleRefreshToken) {
    throw new Error('No refresh token available. User needs to re-authenticate.');
  }

  logger.info({ userId }, 'Refreshing Google access token');

  oauth2Client.setCredentials({
    refresh_token: decrypt(user.googleRefreshToken)
  });

  const { credentials } = await oauth2Client.refreshAccessToken();

  if (!credentials.access_token) {
    throw new Error('Failed to refresh access token');
  }

  // Update stored tokens
  await prisma.user.update({
    where: { id: userId },
    data: {
      googleAccessToken: encrypt(credentials.access_token),
      googleTokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date) : null
    }
  });

  return credentials.access_token;
}

export async function downloadDriveFile(userId: string, fileId: string): Promise<Buffer> {
  const accessToken = await getValidAccessToken(userId);

  oauth2Client.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  logger.info({ userId, fileId }, 'Downloading file from Google Drive');

  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );

  return Buffer.from(response.data as ArrayBuffer);
}

export async function getDriveFileMetadata(userId: string, fileId: string) {
  const accessToken = await getValidAccessToken(userId);

  oauth2Client.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const response = await drive.files.get({
    fileId,
    fields: 'id, name, size, mimeType'
  });

  return response.data;
}

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
}

export async function listDriveFolder(userId: string, folderId?: string): Promise<DriveItem[]> {
  const accessToken = await getValidAccessToken(userId);

  oauth2Client.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  // Query for files in folder (or root if no folderId)
  const parent = folderId || 'root';
  const query = `'${parent}' in parents and trashed = false`;

  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name, mimeType)',
    orderBy: 'folder, name',
    pageSize: 100
  });

  const items: DriveItem[] = (response.data.files || []).map(file => ({
    id: file.id!,
    name: file.name!,
    mimeType: file.mimeType!,
    isFolder: file.mimeType === 'application/vnd.google-apps.folder'
  }));

  return items;
}
