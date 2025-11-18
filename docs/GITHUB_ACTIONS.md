# GitHub Actions Deployment Guide

Automated CI/CD deployment using GitHub Actions.

**Note:** Replace the following placeholders with your actual values:
- `YOUR_DOMAIN` - Your domain (e.g., `snes.example.com`)
- `YOUR_VPS_IP` - Your VPS IP address (e.g., `123.45.67.89`)
- `YOUR_SSH_USER` - Your VPS SSH username (e.g., `ubuntu`, `deploy`, etc.)
- `YOUR_EMAIL` - Your email address

## Overview

- **Initial Setup**: Run once to prepare VPS (manual workflow)
- **Auto Deploy**: Automatically deploys on every push to `main` branch
- **Manual Deploy**: Can trigger deployment manually anytime

## Step 1: Add DNS Record

Add an A record to your DNS provider:
```
subdomain 300 IN A YOUR_VPS_IP
```

Example:
```
snes 300 IN A 123.45.67.89
```

Verify:
```bash
dig YOUR_DOMAIN
# Example: dig snes.example.com
```

## Step 2: Setup SSH Key for GitHub Actions

**On your LOCAL machine** (not on the VPS):

```bash
# Generate SSH key pair
ssh-keygen -t ed25519 -C "github-actions-psnes" -f ~/.ssh/github_actions_psnes

# When prompted:
# - Enter file location: (press Enter to use default)
# - Enter passphrase: (press Enter for no passphrase - GitHub Actions can't use passphrases)

# Copy the PUBLIC key to VPS
ssh-copy-id -i ~/.ssh/github_actions_psnes.pub YOUR_SSH_USER@YOUR_VPS_IP

# Verify you can SSH with this key
ssh -i ~/.ssh/github_actions_psnes YOUR_SSH_USER@YOUR_VPS_IP

# Display the PRIVATE key (copy this entire output to GitHub Secrets)
cat ~/.ssh/github_actions_psnes
# Copy everything from "-----BEGIN OPENSSH PRIVATE KEY-----" to "-----END OPENSSH PRIVATE KEY-----"
```

**Important:**
- ✅ Generate on your **local machine**
- ✅ **No passphrase** (GitHub Actions can't enter passphrases)
- ✅ **Public key** (`.pub`) goes to VPS → `~/.ssh/authorized_keys`
- ✅ **Private key** (no extension) goes to GitHub Secrets → `SSH_PRIVATE_KEY`

## Step 3: Configure GitHub Secrets

Go to your GitHub repository:
`Settings` → `Secrets and variables` → `Actions` → `New repository secret`

Add these secrets:

### Required Secrets

| Secret Name | Value | Description |
|------------|-------|-------------|
| `SSH_PRIVATE_KEY` | Contents of private key | The entire private key from step 2 |
| `VPS_HOST` | `YOUR_VPS_IP` | Your VPS IP address (e.g., `123.45.67.89`) |
| `VPS_USER` | `YOUR_SSH_USER` | SSH user for VPS (e.g., `ubuntu`, `deploy`) |
| `GOOGLE_CLIENT_ID` | Your Google OAuth Client ID | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Your Google OAuth Client Secret | From Google Cloud Console |
| `SESSION_SECRET` | Generate secure random string | See below |
| `LETSENCRYPT_EMAIL` | `YOUR_EMAIL` | Your email for SSL certificate notifications |

### Generate SESSION_SECRET

```bash
# Generate a secure random string
openssl rand -base64 32
```

Copy the output and use it as `SESSION_SECRET`.

### Get Google OAuth Credentials

**Quick steps:**
1. Go to: https://console.cloud.google.com/apis/credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Add Authorized redirect URI:
   ```
   https://YOUR_DOMAIN/auth/google/callback
   ```
   Example:
   ```
   https://snes.example.com/auth/google/callback
   ```
4. Copy Client ID and Client Secret

**Need detailed instructions?** See `deploy/GOOGLE_OAUTH_SETUP.md` for complete step-by-step guide.

## Step 4: Initial VPS Setup (One-Time)

Go to GitHub Actions tab in your repository:
- Select "Initial VPS Setup" workflow
- Click "Run workflow"
- Select branch: `main`
- Click "Run workflow"

This will:
- ✅ Install Docker & Docker Compose
- ✅ Install Nginx
- ✅ Install Certbot
- ✅ Configure Nginx reverse proxy
- ✅ Setup SSL with Let's Encrypt

Wait for the workflow to complete (~5-10 minutes).

## Step 5: Deploy Application

### Option A: Automatic Deployment

Just push to main branch:
```bash
git add .
git commit -m "Deploy to production"
git push origin main
```

GitHub Actions will automatically deploy your changes!

### Option B: Manual Deployment

Go to GitHub Actions tab:
- Select "Deploy to Production" workflow
- Click "Run workflow"
- Select branch: `main`
- Click "Run workflow"

## Step 6: Verify Deployment

Visit: **https://YOUR_DOMAIN**

Example: **https://snes.example.com**

Check deployment logs on GitHub:
- Go to Actions tab
- Click on latest "Deploy to Production" workflow run
- View logs

Check application logs on VPS:
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f'
```

## Workflow Files

### `.github/workflows/deploy.yml`
- Triggers on push to `main` branch
- Can be triggered manually
- Deploys application automatically

### `.github/workflows/setup-vps.yml`
- Manual workflow only
- Sets up fresh VPS
- Run once per VPS

## Common Tasks

### View Deployment Status
- Go to GitHub repository
- Click "Actions" tab
- View latest workflow runs

### Re-deploy Current Version
- Go to Actions → Deploy to Production
- Click "Run workflow"

### Update Environment Variables
1. Update secrets in GitHub Settings
2. Re-run deployment workflow

### Check VPS Logs
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f backend'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f backend'
```

### Restart Services
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml restart'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml restart'
```

### SSH into VPS
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP
cd /opt/psnes
docker-compose -f docker-compose.prod.yml ps
```

Example:
```bash
ssh ubuntu@123.45.67.89
cd /opt/psnes
docker-compose -f docker-compose.prod.yml ps
```

## Troubleshooting

### Deployment Fails with SSH Error
- Verify `SSH_PRIVATE_KEY` is correctly set in GitHub Secrets
- Ensure public key is in VPS `~/.ssh/authorized_keys`
- Check VPS firewall allows SSH (port 22)

### SSL Certificate Fails
- Verify DNS is pointing to correct IP
- Ensure ports 80 and 443 are open on VPS
- Check `LETSENCRYPT_EMAIL` is set

### Services Don't Start
- Check GitHub Actions logs for errors
- SSH into VPS and check Docker logs:
  ```bash
  ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs'
  ```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs'
```

### Can't Login with Google
- Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are correct
- Check redirect URI in Google Console:
  ```
  https://YOUR_DOMAIN/auth/google/callback
  ```

Example:
```
https://snes.example.com/auth/google/callback
```

## Security Best Practices

✅ **Do:**
- Use dedicated SSH key for GitHub Actions
- Rotate secrets periodically
- Use least-privilege VPS user (not root) if possible
- Keep dependencies updated

❌ **Don't:**
- Commit `.env` files to git
- Share GitHub Secrets
- Use same SSH key for multiple services

## Updating the Application

1. Make changes locally
2. Test locally with `docker-compose up`
3. Commit changes
4. Push to main:
   ```bash
   git push origin main
   ```

GitHub Actions will automatically:
- Build new Docker images
- Deploy to VPS
- Restart services
- Verify deployment

## Rollback

If deployment fails or has issues:

```bash
# SSH into VPS
ssh YOUR_SSH_USER@YOUR_VPS_IP
cd /opt/psnes

# View commit history
git log --oneline -10

# Checkout previous version
git checkout <previous-commit-hash>

# Rebuild and restart
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml build --no-cache
docker-compose -f docker-compose.prod.yml up -d
```

Example:
```bash
ssh ubuntu@123.45.67.89
cd /opt/psnes
git log --oneline -10
git checkout abc1234
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml build --no-cache
docker-compose -f docker-compose.prod.yml up -d
```

Or trigger a re-deployment from GitHub Actions with the previous commit.

## Monitoring

### Check Service Health
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml ps'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml ps'
```

### View Nginx Logs
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'sudo tail -f /var/log/nginx/YOUR_DOMAIN.access.log'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'sudo tail -f /var/log/nginx/snes.example.com.access.log'
```

### View Application Logs
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f --tail=100'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f --tail=100'
```

## Support

For issues:
1. Check GitHub Actions workflow logs
2. Check VPS application logs
3. Check Nginx error logs: `/var/log/nginx/YOUR_DOMAIN.error.log`

Example: `/var/log/nginx/snes.example.com.error.log`

---

**That's it!** Push to main and watch your application deploy automatically. 🚀
