import { createLogger } from '$lib/utils/logger';

const logger = createLogger('DrivePicker');

const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY;
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

let pickerApiLoaded = false;
let gapiLoaded = false;

declare global {
  interface Window {
    gapi: any;
    google: any;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.body.appendChild(script);
  });
}

async function loadGapi(): Promise<void> {
  if (gapiLoaded) return;

  await loadScript('https://apis.google.com/js/api.js');

  return new Promise((resolve) => {
    window.gapi.load('picker', () => {
      gapiLoaded = true;
      pickerApiLoaded = true;
      resolve();
    });
  });
}

export interface DriveFile {
  fileId: string;
  fileName: string;
  mimeType: string;
}

export async function openDrivePicker(accessToken: string): Promise<DriveFile | null> {
  if (!API_KEY) {
    throw new Error('Google API key not configured (VITE_GOOGLE_API_KEY)');
  }

  await loadGapi();

  return new Promise((resolve) => {
    const google = window.google;

    // Create a view for all files, then filter by extension in callback
    const docsView = new google.picker.DocsView()
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);

    const picker = new google.picker.PickerBuilder()
      .addView(docsView)
      .setOAuthToken(accessToken)
      .setDeveloperKey(API_KEY)
      .setTitle('Select a SNES ROM')
      .setCallback((data: any) => {
        if (data.action === google.picker.Action.PICKED) {
          const file = data.docs[0];
          const fileName = file.name as string;

          // Validate file extension
          const ext = fileName.toLowerCase();
          const validExtensions = ['.smc', '.sfc', '.fig', '.swc', '.mgd', '.zip'];
          const hasValidExtension = validExtensions.some(e => ext.endsWith(e));

          if (!hasValidExtension) {
            logger.warn({ fileName }, 'Invalid file extension selected');
            alert('Please select a valid SNES ROM file (.smc, .sfc, .fig, .swc, .mgd, or .zip)');
            resolve(null);
            return;
          }

          resolve({
            fileId: file.id,
            fileName: file.name,
            mimeType: file.mimeType
          });
        } else if (data.action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();

    picker.setVisible(true);
  });
}

export async function getAccessToken(): Promise<string> {
  const response = await fetch('/api/games/drive-token', {
    credentials: 'include'
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get Drive access token');
  }

  const data = await response.json();
  return data.accessToken;
}
