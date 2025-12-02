# Google Drive ROM Storage Integration

## Overview

ROMs are stored in users' personal Google Drive instead of on the server. This approach:
- **Legal**: Users are responsible for their own ROM storage
- **Scalable**: No server storage costs
- **Private**: ROMs never permanently stored on our servers

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Google Drive   │     │     Backend     │     │    Frontend     │
│  (User's ROMs)  │     │  (API + Cache)  │     │   (Emulator)    │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │◄──── OAuth Token ─────┤                       │
         │                       │                       │
         │◄─── Download ROM ─────┤                       │
         │                       │                       │
         │                       │────── ROM Data ──────►│
         │                       │                       │
```

## Data Model

### User (stores OAuth tokens)
```prisma
model User {
  googleAccessToken   String?   // Encrypted access token
  googleRefreshToken  String?   // Encrypted refresh token
  googleTokenExpiry   DateTime? // Token expiration time
}
```

### Game (stores Drive file reference)
```prisma
model Game {
  driveFileId   String  // Google Drive file ID
  driveFileName String  // Original filename
  // No romPath - file stays in user's Drive
}
```

## Flows

### 1. Adding a Game

```
User clicks "Add from Drive"
    │
    ▼
Frontend requests access token from backend
    │ GET /api/games/drive-token
    │
    ▼
Backend returns valid token (refreshes if expired)
    │
    ▼
Frontend opens Google Drive Picker
    │
    ▼
User selects ROM file (.smc, .sfc, etc.)
    │
    ▼
Frontend sends file info to backend
    │ POST /api/games/add-from-drive
    │ { driveFileId, driveFileName, title }
    │
    ▼
Backend verifies file exists & saves reference to database
    │
    ▼
Game appears in user's library
```

### 2. Single Player

```
User clicks Play
    │
    ▼
Frontend requests ROM
    │ GET /api/games/:gameId/download
    │
    ▼
Backend downloads ROM from Google Drive
    │ (using user's OAuth token)
    │
    ▼
Backend streams ROM to frontend
    │
    ▼
Frontend loads ROM into emulator
    │
    ▼
Game starts
```

### 3. Multiplayer (Host)

```
Host clicks Play
    │
    ▼
Backend creates room + caches ROM
    │ 1. Download ROM from host's Google Drive
    │ 2. Save to ./rom-cache/{roomId}.rom
    │
    ▼
Host's frontend loads ROM (same as single player)
    │
    ▼
Room is ready for guests
```

### 4. Multiplayer (Guest)

```
Guest joins room
    │
    ▼
Guest requests ROM
    │ GET /api/games/room/:roomId/rom
    │
    ▼
Backend serves ROM from cache
    │ (NOT from host's Drive - guest has no access)
    │
    ▼
Guest's frontend loads ROM
    │
    ▼
Both players ready
```

### 5. Room Cleanup

```
All players leave room
    │
    ▼
Backend detects empty room
    │
    ▼
Backend deletes cached ROM
    │ rm ./rom-cache/{roomId}.rom
    │
    ▼
Room destroyed
```

## Token Management

### OAuth Scopes
```
profile              - User identity
email                - User email
drive.readonly       - Read files from Drive
```

### Token Refresh
```typescript
// Tokens expire after 1 hour
// Backend automatically refreshes when needed

async function getValidAccessToken(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  // Check if token is still valid (5 min buffer)
  if (user.googleTokenExpiry > Date.now() + 5 * 60 * 1000) {
    return decrypt(user.googleAccessToken);
  }

  // Refresh token
  const { credentials } = await oauth2Client.refreshAccessToken();

  // Save new token
  await prisma.user.update({
    where: { id: userId },
    data: {
      googleAccessToken: encrypt(credentials.access_token),
      googleTokenExpiry: new Date(credentials.expiry_date)
    }
  });

  return credentials.access_token;
}
```

## Security

### Token Encryption
- Access and refresh tokens are encrypted with AES-256-CBC
- Encryption key stored in `TOKEN_ENCRYPTION_KEY` env variable
- Generate key: `openssl rand -hex 32`

### API Key Restrictions
The frontend API key (for Drive Picker) should be restricted:
1. **HTTP referrers**: Only allow your domains
2. **API restrictions**: Only allow Picker API

### Cache Security
- ROM cache files are named by room ID (UUID)
- Only room members can access cached ROMs
- Cache auto-cleans after 2 hours (TTL)
- Cache deleted when room is destroyed

## Environment Variables

### Backend (.env)
```env
# Token encryption (generate with: openssl rand -hex 32)
TOKEN_ENCRYPTION_KEY=your-32-byte-hex-key

# Google OAuth
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback

# ROM cache directory
ROM_CACHE_DIR=./rom-cache
```

### Frontend (.env)
```env
# Google Drive Picker
VITE_GOOGLE_API_KEY=your-api-key
VITE_GOOGLE_CLIENT_ID=your-client-id
```

## Google Cloud Console Setup

1. **Enable APIs**:
   - Google Drive API
   - Google Picker API

2. **OAuth Consent Screen**:
   - Add scope: `https://www.googleapis.com/auth/drive.readonly`
   - Add test users (for development)
   - Publish app (for production)

3. **API Key** (for Picker):
   - Create API key
   - Restrict to HTTP referrers (your domains)
   - Restrict to Picker API only

## File Structure

```
backend/
├── src/
│   ├── services/
│   │   ├── google-drive.ts    # Drive API wrapper
│   │   └── rom-cache.ts       # Multiplayer cache
│   ├── utils/
│   │   └── crypto.ts          # Token encryption
│   └── api/
│       └── games.ts           # Drive endpoints
└── rom-cache/                  # Temporary ROM storage
    └── {roomId}.rom

frontend/
└── src/lib/
    ├── services/
    │   └── drive-picker.ts    # Picker API integration
    └── components/
        └── AddFromDrive.svelte # UI component
```
