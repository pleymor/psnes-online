# Quick Start - Deploy PSNES

**Note:** Replace the following placeholders with your actual values:
- `YOUR_DOMAIN` - Your domain (e.g., `snes.example.com`)
- `YOUR_VPS_IP` - Your VPS IP address (e.g., `123.45.67.89`)
- `YOUR_SSH_USER` - Your VPS SSH username (e.g., `ubuntu`, `deploy`, etc.)
- `YOUR_EMAIL` - Your email address (e.g., `user@example.com`)

## Prerequisites Checklist

- [ ] VPS access: SSH to YOUR_SSH_USER@YOUR_VPS_IP
- [ ] DNS configured: A record for YOUR_DOMAIN → YOUR_VPS_IP
- [ ] Google OAuth credentials ready

## Step 1: Configure DNS (5 minutes)

Go to your DNS provider and add an A record:

```
subdomain 300 IN A YOUR_VPS_IP
```

Example:
```
snes 300 IN A 123.45.67.89
```

Verify DNS propagation:
```bash
dig YOUR_DOMAIN
```

Example:
```bash
dig snes.example.com
# Should show: 123.45.67.89
```

## Step 2: Get Google OAuth Credentials (5 minutes)

1. Visit: https://console.cloud.google.com/apis/credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Add Authorized redirect URI:
   ```
   https://YOUR_DOMAIN/auth/google/callback
   ```
   Example:
   ```
   https://snes.example.com/auth/google/callback
   ```
4. Save your Client ID and Client Secret

## Step 3: Generate Environment File (2 minutes)

From your local machine:

```bash
cd /path/to/your/psnes/deploy
./generate-env.sh
```

Example:
```bash
cd /home/user/projects/psnes/deploy
./generate-env.sh
```

Enter your Google OAuth credentials when prompted.

## Step 4: Deploy to VPS (One Command!)

Run the automated deployment:

```bash
cd /path/to/your/psnes/deploy
./deploy-from-local.sh
```

Example:
```bash
cd /home/user/projects/psnes/deploy
./deploy-from-local.sh
```

This script will:
- ✅ Test SSH connection
- ✅ Sync files to VPS
- ✅ Install Docker, Nginx, Certbot (if needed)
- ✅ Configure Nginx reverse proxy with WebSocket/WebRTC support
- ✅ Setup SSL with Let's Encrypt
- ✅ Build and start containers (Backend with WebRTC streaming)

## Step 5: Verify Deployment

Visit: **https://YOUR_DOMAIN**

Example: **https://snes.example.com**

Check backend logs:
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f backend'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f backend'
```

Check all services:
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml ps'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml ps'
```

## Troubleshooting

### DNS not resolving
Wait a few minutes for DNS propagation, then try again.

### SSL certificate failed
Ensure:
1. DNS points to correct IP
2. Ports 80 and 443 are open:
   ```bash
   ssh YOUR_SSH_USER@YOUR_VPS_IP 'sudo ufw allow 80/tcp && sudo ufw allow 443/tcp'
   ```

Example:
```bash
ssh ubuntu@123.45.67.89 'sudo ufw allow 80/tcp && sudo ufw allow 443/tcp'
```

### Services not starting
Check logs:
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs'
```

### Can't login with Google
Verify callback URL in Google Console matches exactly:
```
https://YOUR_DOMAIN/auth/google/callback
```

Example:
```
https://snes.example.com/auth/google/callback
```

## Common Commands

### View logs
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml logs -f'
```

### Restart services
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml restart'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml restart'
```

### Redeploy after changes
```bash
cd /path/to/your/psnes/deploy
./deploy-from-local.sh
```

Example:
```bash
cd /home/user/projects/psnes/deploy
./deploy-from-local.sh
```

### Stop services
```bash
ssh YOUR_SSH_USER@YOUR_VPS_IP 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml down'
```

Example:
```bash
ssh ubuntu@123.45.67.89 'cd /opt/psnes && docker-compose -f docker-compose.prod.yml down'
```

## That's it!

Your multiplayer SNES emulator should now be live at **https://YOUR_DOMAIN**

Example: **https://snes.example.com**
