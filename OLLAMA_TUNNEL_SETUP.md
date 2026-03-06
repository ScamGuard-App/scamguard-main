# Ollama + Cloudflare Tunnel Setup Guide

This guide explains how to expose your local Ollama instance (running on your home PC) to the internet via Cloudflare Tunnel, so you can query it from Vercel-hosted ScamGuard at remote events.

## Architecture Overview

```
Event (Borrowed Device w/ Browser)
    ↓
Vercel Hosting (Running ScamGuard)
    ↓
Cloudflare Tunnel (Secure, Encrypted Connection)
    ↓
Your Home PC (Running Ollama)
```

---

## Prerequisites

- **Home PC**: Windows/Mac/Linux with Ollama installed
- **Cloudflare Account**: Free account (https://dash.cloudflare.com)
- **Domain**: Optional but recommended (free with Cloudflare)
- **Internet**: Stable connection on home PC and event location

---

## Step 1: Install Ollama on Home PC

### Windows:
1. Download from https://ollama.ai
2. Run installer and complete setup
3. Ollama will start automatically on `http://localhost:11434`

### Mac:
```bash
brew install ollama
brew services start ollama
```

### Linux:
```bash
curl https://ollama.ai/install.sh | sh
sudo systemctl start ollama
```

### Verify Installation:
```bash
# Test if Ollama is running
curl http://localhost:11434/api/tags

# Should return JSON with available models
```

## Step 2: Download a Model

Choose one based on your PC's specs:

**Lightweight (8GB RAM):**
```bash
ollama pull mistral
```

**Balanced (16GB RAM):**
```bash
ollama pull neural-chat
ollama pull dolphin-mistral
```

**Powerful (32GB+ RAM + GPU):**
```bash
ollama pull llama2
ollama pull dolphin-mixtral
```

This downloads the model (~5-15GB) - takes 5-15 minutes depending on internet.

---

## Step 3: Install Cloudflare Tunnel

### Windows (PowerShell as Administrator):
```powershell
# Download cloudflared
Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.zip" -OutFile "$env:TEMP\cloudflared.zip"
Expand-Archive -Path "$env:TEMP\cloudflared.zip" -DestinationPath $env:TEMP
Move-Item -Path "$env:TEMP\cloudflared.exe" -Destination "C:\Program Files\cloudflared.exe" -Force

# Verify installation
cloudflared --version
```

### Mac:
```bash
brew install cloudflare/cloudflare/cloudflared
cloudflared --version
```

### Linux:
```bash
sudo apt install cloudflared
# or
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.tar.gz | tar xz
sudo mv cloudflared /usr/local/bin
cloudflared --version
```

---

## Step 4: Set Up Cloudflare Tunnel

### A. Authenticate with Cloudflare:
```bash
cloudflared tunnel login
```

This opens a browser to authorize your computer. Click "Authorize" and return to terminal.

### B. Create a Tunnel:
```bash
cloudflared tunnel create scamguard-ollama
```

This creates a tunnel called `scamguard-ollama` and generates a UUID.

### C. Create Config File

Create `~/.cloudflared/config.yml` (or `C:\Users\YourUsername\.cloudflared\config.yml` on Windows):

**Option 1: Using a Domain (Recommended)**

If you have a domain (e.g., `scamguard.com`):

```yaml
tunnel: scamguard-ollama
credentials-file: C:\Users\YourUsername\.cloudflared\<UUID>.json  # Windows
# credentials-file: ~/.cloudflared/<UUID>.json  # Mac/Linux

ingress:
  - hostname: ollama.scamguard.com
    service: http://localhost:11434
  - service: http_status:404
```

Then create DNS record in Cloudflare dashboard:
- **Type**: CNAME
- **Name**: ollama
- **Target**: `scamguard-ollama.<your-tunnel-id>.cfargotunnel.com`
- **Proxy**: Proxied

**Option 2: Using Auto-Generated Cloudflare URL**

```yaml
tunnel: scamguard-ollama
credentials-file: C:\Users\YourUsername\.cloudflared\<UUID>.json

ingress:
  - service: http://localhost:11434
```

Then run:
```bash
cloudflared tunnel route dns scamguard-ollama localhost:11434
```

This auto-generates a URL like: `https://scamguard-ollama-<random>.cfargotunnel.com`

### D. Start the Tunnel

Terminal/PowerShell:
```bash
cloudflared tunnel run scamguard-ollama
```

**Output should show:**
```
Tunnel scamguard-ollama created with ID <UUID>
Routing traffic from: https://ollama.scamguard.com
```

### E. Test the Tunnel (From Another Device)

Open browser on a different device:
```
https://ollama.scamguard.com/api/tags
# or
https://scamguard-ollama-<random>.cfargotunnel.com/api/tags
```

Should return JSON with models like: `{"models": [{"name": "mistral"}]}`

---

## Step 5: Set Up Auto-Start (Optional but Recommended)

### Windows - Batch Script:

Create `start-ollama-tunnel.bat`:
```batch
@echo off
REM Start Ollama
start /min "Ollama" "C:\Program Files\ollama\ollama.exe"

REM Wait for Ollama to start
timeout /t 3 /nobreak

REM Start Cloudflare Tunnel
cloudflared tunnel run scamguard-ollama
```

Save in `Start Menu → Startup` folder (or run on login).

### Mac - LaunchAgent:

Create `~/Library/LaunchAgents/com.cloudflare.tunnel.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cloudflare.tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/cloudflared</string>
        <string>tunnel</string>
        <string>run</string>
        <string>scamguard-ollama</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

Then:
```bash
launchctl load ~/Library/LaunchAgents/com.cloudflare.tunnel.plist
```

---

## Step 6: Update ScamGuard Configuration

In your `.env` file:

```env
# Local development (Ollama on same PC):
LLM_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=mistral

# For event (Ollama from Vercel/remote):
LLM_PROVIDER=ollama
OLLAMA_URL=https://ollama.scamguard.com
# or
OLLAMA_URL=https://scamguard-ollama-<random>.cfargotunnel.com
OLLAMA_MODEL=mistral
```

---

## Troubleshooting

### "Connection refused" at event
- **Check**: Is home PC on and connected to internet?
- **Check**: Is `cloudflared tunnel run` still running?
- **Check**: Is Ollama running? (`curl http://localhost:11434/api/tags`)

### Tunnel URL not responding
```bash
# Verify tunnel is running
cloudflared tunnel list

# Check logs
cloudflared tunnel info scamguard-ollama

# Restart tunnel
cloudflared tunnel run scamguard-ollama
```

### Slow responses
- **Model size**: Smaller models are faster (mistral vs llama2)
- **Home PC specs**: Queries run slower on CPU vs GPU
- **Network latency**: Encrypted tunnel adds ~100-200ms

### See available models
```bash
ollama list
```

### Change model
```bash
ollama pull neural-chat
# Then update OLLAMA_MODEL in .env
```

---

## Performance Tips

1. **Use faster models for events**:
   - `mistral` (7B) - Fast, good quality
   - `neural-chat` (7B) - Optimized for Q&A
   - Avoid: `llama2` (70B) - Slow on CPU

2. **Keep home PC plugged in**: Prevents sleep mode

3. **Use hardwired Ethernet**: More stable than WiFi

4. **Monitor Ollama performance**:
   ```bash
   # Check resource usage while running queries
   # Windows: Open Task Manager
   # Mac: top -p (ollama process id)
   # Linux: htop
   ```

---

## Fallback: Gemini API

If Ollama tunnel fails at the event, the system **automatically falls back** to Gemini API if `GOOGLE_API_KEY` is set.

Set both in your `.env`:
```env
LLM_PROVIDER=ollama
OLLAMA_URL=https://your-tunnel-url.com
GOOGLE_API_KEY=your_gemini_key  # Fallback
```

If Ollama doesn't respond, analysis will attempt Gemini instead (requires internet and available quota).

---

## Event Checklist

- [ ] Home PC is on and plugged in
- [ ] Ollama running and model loaded
- [ ] Cloudflare tunnel running (`cloudflared tunnel run scamguard-ollama`)
- [ ] Tunnel URL responds (test in browser)
- [ ] ScamGuard `.env` has correct `OLLAMA_URL`
- [ ] ScamGuard deployed to Vercel
- [ ] Event location has internet
- [ ] Backup: Gemini API key set in `.env`

---

## Questions?

Check logs:
- **Tunnel logs**: Look at cloudflared terminal output
- **Ollama logs**: Windows event viewer or `ollama serve` output
- **ScamGuard logs**: Check worker terminal and Vercel logs

