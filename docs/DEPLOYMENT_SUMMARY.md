# GitHub Actions Deployment - Quick Reference

**Note:** Replace the following placeholders with your actual values:
- `YOUR_DOMAIN` - Your domain (e.g., `snes.example.com`)
- `YOUR_VPS_IP` - Your VPS IP address (e.g., `123.45.67.89`)
- `YOUR_SSH_USER` - Your VPS SSH username (e.g., `ubuntu`, `deploy`, etc.)
- `YOUR_EMAIL` - Your email address (e.g., `user@example.com`)

## 🎯 Overview

Your PSNES multiplayer emulator is now configured for automated deployment using GitHub Actions. Every push to the `main` branch will automatically deploy to your domain.

## 📋 Setup Checklist

Follow these steps in order:

### 1. DNS Configuration

Add an A record in your DNS provider:
```
subdomain 300 IN A YOUR_VPS_IP
```

Example:
```
snes 300 IN A 123.45.67.89
```

Verify: `dig YOUR_DOMAIN` should return `YOUR_VPS_IP`

Example:
```bash
dig snes.example.com  # Should return 123.45.67.89
```

### 2. SSH Key Setup (Required First)

**On your local machine**, generate SSH key pair:

```bash
# Generate key
ssh-keygen -t ed25519 -C "github-actions-psnes" -f ~/.ssh/github_actions_psnes
# No passphrase! (press Enter twice)

# Copy public key to VPS
ssh-copy-id -i ~/.ssh/github_actions_psnes.pub YOUR_SSH_USER@YOUR_VPS_IP

# Test it works
ssh -i ~/.ssh/github_actions_psnes YOUR_SSH_USER@YOUR_VPS_IP

# Get private key for GitHub (copy entire output)
cat ~/.ssh/github_actions_psnes
```

Example:
```bash
ssh-keygen -t ed25519 -C "github-actions-psnes" -f ~/.ssh/github_actions_psnes
ssh-copy-id -i ~/.ssh/github_actions_psnes.pub ubuntu@123.45.67.89
ssh -i ~/.ssh/github_actions_psnes ubuntu@123.45.67.89
cat ~/.ssh/github_actions_psnes
```

### 3. GitHub Secrets (Required)

Go to: `Repository Settings` → `Secrets and variables` → `Actions`

Add these 7 secrets:

| Secret | How to Get |
|--------|------------|
| `SSH_PRIVATE_KEY` | Generate on local machine (see GITHUB_ACTIONS.md Step 2) |
| `VPS_HOST` | Your VPS IP address (e.g., `123.45.67.89`) |
| `VPS_USER` | Your SSH username (e.g., `ubuntu`, `deploy`) |
| `GOOGLE_CLIENT_ID` | Get from [Google Console](https://console.cloud.google.com/apis/credentials) |
| `GOOGLE_CLIENT_SECRET` | Get from [Google Console](https://console.cloud.google.com/apis/credentials) |
| `SESSION_SECRET` | Generate: `openssl rand -base64 32` |
| `LETSENCRYPT_EMAIL` | Your email (e.g., `user@example.com`) |

### 4. Google OAuth Setup

**Quick steps:**
1. Visit: https://console.cloud.google.com/apis/credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Add redirect URI: `https://YOUR_DOMAIN/auth/google/callback`
   Example: `https://snes.example.com/auth/google/callback`
4. Copy Client ID and Client Secret for GitHub Secrets (Step 3)

**📖 Need help?** See detailed guide: `deploy/GOOGLE_OAUTH_SETUP.md`

### 5. Initial VPS Setup (First Time Only)

1. Go to GitHub Actions tab
2. Select "Initial VPS Setup"
3. Click "Run workflow"
4. Select branch: `main`
5. Click "Run workflow"

This installs Docker, Nginx, Certbot, and configures SSL.

## 🚀 Deployment Methods

### Method 1: Automatic (Recommended)

Just push to main:
```bash
git add .
git commit -m "Your changes"
git push origin main
```

GitHub Actions automatically deploys! ✨

### Method 2: Manual Trigger

1. Go to GitHub Actions tab
2. Select "Deploy to Production"
3. Click "Run workflow"
4. Select branch: `main`
5. Click "Run workflow"

## 📁 Files Created

### Workflows
- `.github/workflows/deploy.yml` - Auto-deploy on push to main
- `.github/workflows/setup-vps.yml` - Initial VPS setup (manual)

### Docker
- `docker-compose.prod.yml` - Production configuration
- `backend/Dockerfile.prod` - Backend production build
- `frontend/Dockerfile.prod` - Frontend production build
- `frontend/nginx.conf` - Frontend web server config

### Deployment Scripts (Backup/Manual)
- `deploy/setup-vps.sh` - VPS setup script
- `deploy/deploy.sh` - Deployment script
- `deploy/deploy-from-local.sh` - Deploy from local machine
- `deploy/generate-env.sh` - Generate .env.production
- `deploy/nginx-site.conf` - Nginx reverse proxy config

### Documentation
- `deploy/GITHUB_ACTIONS.md` - Complete GitHub Actions guide
- `deploy/README.md` - Comprehensive deployment guide
- `deploy/QUICKSTART.md` - Quick start guide
- `deploy/DEPLOYMENT_SUMMARY.md` - This file

## 🔍 Monitoring

### View GitHub Actions Logs
1. Go to repository on GitHub
2. Click "Actions" tab
3. Click latest workflow run

### View Application Logs
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f'
```

### Check Service Status
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml ps'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml ps'
```

## ⚡ Common Commands

### Restart Services
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml restart'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml restart'
```

### View Backend Logs
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f backend'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f backend'
```

### View Nginx Logs
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'sudo tail -f /var/log/nginx/YOUR_DOMAIN.access.log'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'sudo tail -f /var/log/nginx/snes.example.com.access.log'
```

## 🎮 Application URLs

- **Production**: https://YOUR_DOMAIN
- **Health Check**: https://YOUR_DOMAIN/health
- **Backend API**: https://YOUR_DOMAIN/api/
- **WebSocket**: wss://YOUR_DOMAIN/socket.io/

Example:
- **Production**: https://snes.example.com
- **Health Check**: https://snes.example.com/health
- **Backend API**: https://snes.example.com/api/
- **WebSocket**: wss://snes.example.com/socket.io/

## 🔒 Security Features

✅ **Enabled:**
- SSL/TLS with Let's Encrypt
- Secure session cookies (HTTPS only)
- HSTS headers
- Rate limiting on API endpoints
- WebSocket authentication
- Environment-based secrets
- Redis session storage

## 🐛 Troubleshooting

### Deployment Failed
1. Check GitHub Actions logs
2. Verify all secrets are set correctly
3. Check VPS is accessible: `ssh YOUR_SSH_USER@YOUR_VPS_IP`

Example: `ssh ubuntu@123.45.67.89`

### SSL Certificate Failed
1. Verify DNS points to YOUR_VPS_IP
2. Check ports 80/443 are open
3. Wait for DNS propagation (use `dig YOUR_DOMAIN`)

Example: `dig snes.example.com` should return `123.45.67.89`

### Can't Login
1. Verify Google OAuth credentials in GitHub Secrets
2. Check redirect URI: `https://YOUR_DOMAIN/auth/google/callback`
   Example: `https://snes.example.com/auth/google/callback`
3. Check backend logs for errors

## 📊 Deployment Workflow

```
┌─────────────────┐
│  git push main  │
└────────┬────────┘
         │
         ▼
┌─────────────────────┐
│  GitHub Actions     │
│  - Build images     │
│  - Create .env      │
│  - Sync to VPS      │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  VPS                │
│  - docker-compose   │
│  - Build & restart  │
│  - Health check     │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  ✅ Live at         │
│  YOUR_DOMAIN        │
└─────────────────────┘
```

## 🎯 Next Steps

1. **Add DNS record** for your subdomain (Step 1)
2. **Generate SSH key** and add to VPS (Step 2)
3. **Configure GitHub Secrets** - 7 required (Step 3)
4. **Setup Google OAuth** redirect URI (Step 4)
5. **Run "Initial VPS Setup"** workflow - first time only (Step 5)
6. **Push to main** and watch it deploy automatically!
7. **Visit** https://YOUR_DOMAIN (e.g., https://snes.example.com)

## 📚 Documentation

- **Quick Reference**: `deploy/DEPLOYMENT_SUMMARY.md` (this file)
- **GitHub Actions Guide**: `deploy/GITHUB_ACTIONS.md` - Complete CI/CD setup
- **Google OAuth Setup**: `deploy/GOOGLE_OAUTH_SETUP.md` - Detailed OAuth configuration
- **Quick Start**: `deploy/QUICKSTART.md` - Manual deployment
- **Full Details**: `deploy/README.md` - Comprehensive guide

---

**Ready to deploy?** Add the DNS record, configure GitHub Secrets, and push to main! 🚀
