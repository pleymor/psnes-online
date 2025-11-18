# Google OAuth Setup Guide

**Note:** Replace the following placeholders with your actual values:
- `YOUR_DOMAIN` - Your domain (e.g., `snes.example.com`)
- `YOUR_VPS_IP` - Your VPS IP address (e.g., `123.45.67.89`)
- `YOUR_SSH_USER` - Your VPS SSH username (e.g., `ubuntu`, `deploy`, etc.)
- `YOUR_EMAIL` - Your email address (e.g., `user@example.com`)

Complete guide to setting up Google OAuth authentication for PSNES.

## Overview

Google OAuth allows users to sign in with their Google accounts. You need to:
1. Create a Google Cloud Project
2. Configure OAuth consent screen
3. Create OAuth 2.0 credentials
4. Add credentials to GitHub Secrets

## Step-by-Step Instructions

### 1. Go to Google Cloud Console

Visit: **https://console.cloud.google.com/**

Sign in with your Google account.

### 2. Create or Select a Project

**If you don't have a project:**
1. Click the project dropdown at the top
2. Click "New Project"
3. Enter project name: `PSNES Emulator` (or your preferred name)
4. Click "Create"
5. Wait for project creation (~30 seconds)
6. Select your new project from the dropdown

**If you have an existing project:**
- Select it from the project dropdown

### 3. Configure OAuth Consent Screen

1. In the left sidebar, navigate to:
   ```
   APIs & Services → OAuth consent screen
   ```

2. Select **"External"** user type
   - Choose "External" unless you have a Google Workspace organization
   - Click "Create"

3. Fill in **App information**:
   - **App name**: `PSNES Multiplayer Emulator`
   - **User support email**: Select your email from dropdown
   - **App logo** (optional): Upload a logo if you have one

4. Fill in **App domain** (optional):
   - **Application home page**: `https://YOUR_DOMAIN`
     Example: `https://snes.example.com`
   - **Application privacy policy link**: Can skip for now
   - **Application terms of service link**: Can skip for now

5. Fill in **Developer contact information**:
   - **Email addresses**: Enter YOUR_EMAIL
     Example: `user@example.com`

6. Click **"Save and Continue"**

7. **Scopes** screen:
   - Click "Save and Continue" (default scopes are fine)

8. **Test users** screen (optional):
   - You can add test users, or skip this
   - Click "Save and Continue"

9. **Summary** screen:
   - Review your settings
   - Click "Back to Dashboard"

### 4. Create OAuth 2.0 Client ID

1. In the left sidebar, navigate to:
   ```
   APIs & Services → Credentials
   ```

2. Click **"+ Create Credentials"** at the top
3. Select **"OAuth client ID"**

4. Configure the OAuth client:
   - **Application type**: Select **"Web application"**
   - **Name**: `PSNES Production`

5. **Authorized JavaScript origins** (optional):
   - Click "+ Add URI"
   - Add: `https://YOUR_DOMAIN`
     Example: `https://snes.example.com`

6. **Authorized redirect URIs** (REQUIRED):
   - Click "+ Add URI"
   - Add: `https://YOUR_DOMAIN/auth/google/callback`
     Example: `https://snes.example.com/auth/google/callback`

   **For local development** (optional):
   - Click "+ Add URI" again
   - Add: `http://localhost:5173/auth/google/callback`

7. Click **"Create"**

### 5. Save Your Credentials

A popup will appear with your credentials:

```
Your Client ID
123456789-abc123def456.apps.googleusercontent.com

Your Client Secret
GOCSPX-abc123def456ghi789
```

**Important:**
- ✅ Copy both values immediately
- ✅ Store them securely (password manager recommended)
- ⚠️ You can always view them later in the Credentials page

Click "OK" to close the popup.

### 6. Add Credentials to GitHub Secrets

1. Go to your GitHub repository
2. Navigate to: **Settings → Secrets and variables → Actions**
3. Click **"New repository secret"**

**Add first secret:**
- Name: `GOOGLE_CLIENT_ID`
- Value: Paste your Client ID (e.g., `123456789-abc123def456.apps.googleusercontent.com`)
- Click "Add secret"

**Add second secret:**
- Click "New repository secret" again
- Name: `GOOGLE_CLIENT_SECRET`
- Value: Paste your Client Secret (e.g., `GOCSPX-abc123def456ghi789`)
- Click "Add secret"

## Verification

### Check Your Setup

1. In Google Cloud Console → Credentials:
   - You should see your OAuth 2.0 Client ID listed
   - Click on it to view/edit settings

2. Verify redirect URIs include:
   - ✅ `https://YOUR_DOMAIN/auth/google/callback`
     Example: `https://snes.example.com/auth/google/callback`
   - ✅ `http://localhost:5173/auth/google/callback` (optional, for development)

3. In GitHub repository → Settings → Secrets:
   - ✅ `GOOGLE_CLIENT_ID` should be listed
   - ✅ `GOOGLE_CLIENT_SECRET` should be listed

## Testing After Deployment

Once your application is deployed:

1. Visit: `https://YOUR_DOMAIN`
   Example: `https://snes.example.com`
2. Click "Sign in with Google"
3. You should be redirected to Google's sign-in page
4. After signing in, you should be redirected back to your app

**If it fails:**
- Check that redirect URI matches exactly
- Check that credentials are correctly set in GitHub Secrets
- Check backend logs: `ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f backend'`

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f backend'
```

## Common Issues

### "redirect_uri_mismatch" Error

**Problem:** The redirect URI doesn't match what's configured in Google Console.

**Solution:**
1. Check the error message for the actual redirect URI being used
2. Go to Google Cloud Console → Credentials → Your OAuth Client
3. Add the exact URI shown in the error message
4. Wait a few minutes for changes to propagate

### "invalid_client" Error

**Problem:** Client ID or Client Secret is incorrect.

**Solution:**
1. Verify credentials in Google Cloud Console
2. Copy them again carefully (no extra spaces)
3. Update GitHub Secrets with correct values
4. Re-run deployment

### "access_denied" Error

**Problem:** User denied permission or app not verified.

**Solution:**
- For development: Add yourself as a test user in OAuth consent screen
- For production: Submit app for verification (optional for small user base)

## Publishing Your App (Optional)

By default, your app is in "Testing" mode and limited to 100 users.

**To publish:**
1. Go to OAuth consent screen
2. Click "Publish App"
3. Confirm

**Note:** You may need to submit for verification if you request sensitive scopes, but for basic profile info, verification is optional.

## Security Best Practices

✅ **Do:**
- Keep Client Secret in GitHub Secrets only
- Never commit credentials to git
- Use HTTPS in production (required by Google)
- Rotate credentials if they're ever exposed

❌ **Don't:**
- Share your Client Secret publicly
- Commit `.env` files with credentials
- Use HTTP in production (Google will reject it)

## Updating Credentials

If you need to update credentials later:

1. Generate new credentials in Google Cloud Console
2. Update GitHub Secrets with new values
3. Trigger a new deployment (push to main)

## Multiple Environments

For separate staging/production environments:

1. Create separate OAuth clients in Google Cloud Console:
   - "PSNES Production" → `https://YOUR_DOMAIN/auth/google/callback`
     Example: `https://snes.example.com/auth/google/callback`
   - "PSNES Staging" → `https://staging.YOUR_DOMAIN/auth/google/callback`
     Example: `https://staging.snes.example.com/auth/google/callback`
   - "PSNES Development" → `http://localhost:5173/auth/google/callback`

2. Use different GitHub Secrets for each environment

## Support Links

- **Google Cloud Console**: https://console.cloud.google.com/
- **OAuth 2.0 Documentation**: https://developers.google.com/identity/protocols/oauth2
- **Common OAuth Errors**: https://developers.google.com/identity/protocols/oauth2/web-server#handlingresponse

---

**Setup Complete!** Your Google OAuth authentication should now work when you deploy to production.
