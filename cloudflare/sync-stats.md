# Building a Self-Hosted Live Repo Stats Dashboard with Cloudflare Tunnel, Nginx, Google OAuth, and systemd

A complete walkthrough for exposing local git repository statistics to selected colleagues over the internet — no public IP, no VPS, no port forwarding, and no third-party SaaS.

---

## Table of Contents

1. [What We're Building](#what-were-building)
2. [Architecture Overview](#architecture-overview)
3. [Prerequisites](#prerequisites)
4. [Step 1 — The Stats Generator Script](#step-1--the-stats-generator-script)
5. [Step 2 — The Dashboard UI](#step-2--the-dashboard-ui)
6. [Step 3 — Nginx Configuration](#step-3--nginx-configuration)
7. [Step 4 — Cloudflare Tunnel Setup](#step-4--cloudflare-tunnel-setup)
8. [Step 5 — Google OAuth via Cloudflare Access](#step-5--google-oauth-via-cloudflare-access)
9. [Step 6 — systemd Timer for Auto-Refresh](#step-6--systemd-timer-for-auto-refresh)
10. [Verification and Testing](#verification-and-testing)
11. [Troubleshooting](#troubleshooting)
12. [Design Notes and Trade-offs](#design-notes-and-trade-offs)

---

## What We're Building

A live web dashboard that shows the current state of one or more local git repositories:

- Current branch and HEAD commit
- Uncommitted changes (modified, staged, untracked)
- Diff stats (lines added / deleted vs HEAD)
- Unpushed commits
- Working tree status (`git status --short`)
- Recent commit history

The dashboard updates every 15 seconds and is only accessible to specific people (verified via Google login) through a custom domain, even though the data lives on a laptop with no public IP.

**Use case:** You're working locally on a feature, and you want your colleague — who uses a completely different IDE (or no IDE at all) — to see your current state in a browser without installing anything.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Your Laptop                                                │
│                                                             │
│  ┌─────────────────┐    ┌───────────────────────┐           │
│  │ generate-stats  │───▶│  stats.json           │           │
│  │ .sh (systemd    │    │  index.html           │           │
│  │  timer, 15s)    │    │  (in project dir)     │           │
│  └─────────────────┘    └───────────┬───────────┘           │
│                                     │                       │
│                                     ▼                       │
│                         ┌─────────────────────┐             │
│                         │  nginx              │             │
│                         │  127.0.0.1:12095    │             │
│                         └──────────┬──────────┘             │
│                                    │                        │
│                                    ▼                        │
│                         ┌─────────────────────┐             │
│                         │  cloudflared tunnel │             │
│                         └──────────┬──────────┘             │
└────────────────────────────────────┼────────────────────────┘
                                     │
                                     ▼
                        ┌────────────────────────┐
                        │  Cloudflare Edge       │
                        │  · DNS: stats.…com     │
                        │  · Access: Google OAuth│
                        │  · Tunnel routing      │
                        └───────────┬────────────┘
                                    │
                                    ▼
                        ┌────────────────────────┐
                        │  Colleague's browser   │
                        │  (Google-verified)     │
                        └────────────────────────┘
```

**Why this stack:**

- **Local HTTP server (nginx)** — anything serving HTTP works; nginx is stable and easy to configure.
- **Cloudflare Tunnel (cloudflared)** — outbound-only connection to Cloudflare's edge. No inbound ports on your firewall, no public IP needed.
- **Cloudflare Access** — sits in front of the tunnel and enforces identity. Works with Google, GitHub, Microsoft, Okta, etc. The free tier supports up to 50 users.
- **systemd timer** — regenerates the JSON every 15 seconds, using only OS-native tooling.

---

## Prerequisites

- A Linux machine (tested on Arch-based distros, but any systemd distro works).
- `git`, `bash`, `python3`, `nginx`, `cloudflared` installed.
- A domain managed by Cloudflare (free plan is sufficient).
- A Cloudflare account with Zero Trust enabled (free for up to 50 users).
- A Google account for OAuth.

---

## Step 1 — The Stats Generator Script

The generator produces a JSON snapshot of one or more git repos. It's the only piece that touches git.

### Directory Layout

Create a project folder for the whole dashboard:

```
/home/inxeoz/Work/tries/2026-09-29-stats.inxeoz.com/
├── generate-stats.sh
├── index.html
├── stats.json         (generated)
├── repo-stats.service (symlinked into /etc/systemd/system)
└── repo-stats.timer   (symlinked into /etc/systemd/system)
```

### `generate-stats.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

REPOS=(
  "/home/inxeoz/Work/tries/2026-07-23-bench/prob/apps/alis"
  "/home/inxeoz/Work/tries/2026-08-31-alis-frontend"
)
OUT_DIR="/home/inxeoz/Work/tries/2026-09-29-stats.inxeoz.com"
OUT_FILE="$OUT_DIR/stats.json"
HOSTNAME_LABEL="$(hostname)"

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

collect_repo() {
  local repo="$1"
  if [[ ! -d "$repo/.git" ]]; then
    printf '{"name":"%s","error":"not a git repo"}' "$(basename "$repo")"
    return
  fi
  cd "$repo"

  local name branch commit commit_short commit_subject commit_author commit_date
  local modified staged untracked unpushed ahead behind total_commits
  local additions deletions last_commit_rel status_lines recent status_json

  name="$(basename "$repo")"
  branch="$(git branch --show-current 2>/dev/null || echo detached)"
  commit="$(git rev-parse HEAD 2>/dev/null || true)"
  commit_short="$(git rev-parse --short HEAD 2>/dev/null || true)"
  commit_subject="$(git log -1 --pretty=%s 2>/dev/null || true)"
  commit_author="$(git log -1 --pretty=%an 2>/dev/null || true)"
  commit_date="$(git log -1 --pretty=%cI 2>/dev/null || true)"
  last_commit_rel="$(git log -1 --pretty=%cr 2>/dev/null || true)"
  total_commits="$(git rev-list --count HEAD 2>/dev/null || echo 0)"

  modified="$(git status --porcelain | grep -c '^ M\|^M ' || true)"
  staged="$(git status --porcelain | grep -c '^M \|^A ' || true)"
  untracked="$(git status --porcelain | grep -c '^??' || true)"
  status_lines="$(git status --short 2>/dev/null || true)"

  additions="$(git diff --numstat HEAD 2>/dev/null | awk '{a+=$1} END {print a+0}')"
  deletions="$(git diff --numstat HEAD 2>/dev/null | awk '{d+=$2} END {print d+0}')"

  if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
    ahead="$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
    behind="$(git rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)"
    unpushed="$ahead"
  else
    ahead=0; behind=0
    unpushed="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
  fi

  recent="$(git log -5 --pretty=format:'%h%x1f%s%x1f%an%x1f%cr' 2>/dev/null \
    | python3 -c '
import sys, json
rows = []
for line in sys.stdin.read().splitlines():
    if not line.strip(): continue
    parts = line.split("\x1f")
    if len(parts) == 4:
        rows.append({"hash": parts[0], "subject": parts[1], "author": parts[2], "when": parts[3]})
print(json.dumps(rows))
')"
  recent="${recent:-[]}"

  status_json="$(printf '%s' "$status_lines" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"

  cat <<EOF
{
  "name": $(printf '%s' "$name" | json_escape),
  "path": $(printf '%s' "$repo" | json_escape),
  "branch": $(printf '%s' "$branch" | json_escape),
  "commit": $(printf '%s' "$commit" | json_escape),
  "commitShort": $(printf '%s' "$commit_short" | json_escape),
  "subject": $(printf '%s' "$commit_subject" | json_escape),
  "author": $(printf '%s' "$commit_author" | json_escape),
  "commitDate": $(printf '%s' "$commit_date" | json_escape),
  "lastCommitRel": $(printf '%s' "$last_commit_rel" | json_escape),
  "totalCommits": $total_commits,
  "modified": $modified,
  "staged": $staged,
  "untracked": $untracked,
  "additions": $additions,
  "deletions": $deletions,
  "unpushed": $unpushed,
  "ahead": $ahead,
  "behind": $behind,
  "status": $status_json,
  "recent": $recent
}
EOF
}

mkdir -p "$OUT_DIR"

{
  printf '{\n'
  printf '  "generatedAt": %s,\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ | json_escape)"
  printf '  "generatedAtLocal": %s,\n' "$(date '+%Y-%m-%d %H:%M:%S %Z' | json_escape)"
  printf '  "host": %s,\n' "$(printf '%s' "$HOSTNAME_LABEL" | json_escape)"
  printf '  "repos": [\n'
  first=1
  for repo in "${REPOS[@]}"; do
    [[ $first -eq 0 ]] && printf ',\n'
    first=0
    collect_repo "$repo"
  done
  printf '\n  ]\n'
  printf '}\n'
} > "$OUT_FILE.tmp"

if python3 -c "import json,sys; json.load(open('$OUT_FILE.tmp'))" 2>/dev/null; then
  mv "$OUT_FILE.tmp" "$OUT_FILE"
else
  echo "ERROR: invalid JSON" >&2
  cat "$OUT_FILE.tmp" >&2
  rm -f "$OUT_FILE.tmp"
  exit 1
fi
```

Make it executable:

```bash
chmod +x generate-stats.sh
```

### Why These Choices

- **`set -euo pipefail`** — fail fast. Catch typos before they silently corrupt your JSON.
- **JSON via `python3 -c 'json.dumps(...)'`** — never hand-roll JSON escaping in bash. Commit messages with quotes, newlines, or unicode will break naive `sed`-based escaping.
- **Atomic write** (`tmp` → `mv`) — nginx will never serve a half-written file.
- **Validation before publish** — if the generated JSON is invalid, the previous valid one stays in place.
- **`Type=oneshot` friendly** — the script runs once and exits cleanly with code 0.

---

## Step 2 — The Dashboard UI

A single self-contained `index.html` that fetches `/stats.json` every 15 seconds and renders it. No build step, no framework, no CDN.

### Design Principles

- **GitHub dark theme** — familiar, low-contrast, easy on the eyes.
- **Monospace where it belongs** — hashes, paths, counts, status lines.
- **No decoration** — no gradients, no glowing dots, no animated banners.
- **Information density over whitespace** — this is a developer tool, not a marketing page.
- **Fails loudly** — if the fetch fails or the JSON is stale, show it clearly.

### `index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Repo Stats</title>
<style>
  :root {
    --bg: #0d1117;
    --bg-2: #161b22;
    --bg-3: #1c2128;
    --border: #30363d;
    --text: #c9d1d9;
    --muted: #8b949e;
    --dim: #6e7681;
    --blue: #58a6ff;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --purple: #bc8cff;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 14px; line-height: 1.5;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  header {
    display: flex; align-items: baseline; justify-content: space-between;
    padding-bottom: 16px; margin-bottom: 20px;
    border-bottom: 1px solid var(--border); gap: 16px; flex-wrap: wrap;
  }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  .meta { font-family: var(--mono); font-size: 12px; color: var(--muted); }
  .meta .stale { color: var(--yellow); }
  .repos { display: grid; gap: 16px; }
  .repo {
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg-2); overflow: hidden;
  }
  .repo-head {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 16px; background: var(--bg-3);
    border-bottom: 1px solid var(--border); gap: 12px;
  }
  .repo-id { min-width: 0; }
  .repo-name { font-weight: 600; font-size: 13px; font-family: var(--mono); }
  .repo-path {
    font-family: var(--mono); font-size: 11px; color: var(--dim);
    margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .branch {
    font-family: var(--mono); font-size: 11px; color: var(--muted);
    padding: 2px 8px; border: 1px solid var(--border);
    border-radius: 4px; background: var(--bg); white-space: nowrap;
  }
  .repo-body { padding: 14px 16px; }
  .commit {
    display: flex; gap: 10px; align-items: baseline; font-size: 13px;
    padding-bottom: 12px; border-bottom: 1px solid var(--border); margin-bottom: 12px;
  }
  .commit .hash { font-family: var(--mono); font-size: 12px; color: var(--purple); flex-shrink: 0; }
  .commit .subject { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commit .author { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
  .stat .v { font-family: var(--mono); font-size: 16px; font-weight: 600; }
  .stat .k { font-size: 11px; color: var(--muted); margin-top: 1px; }
  .stat.mod .v { color: var(--yellow); }
  .stat.add .v { color: var(--green); }
  .stat.del .v { color: var(--red); }
  .stat.unp .v { color: var(--blue); }
  .section {
    font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--dim); margin: 16px 0 6px;
  }
  .section:first-child { margin-top: 0; }
  pre {
    margin: 0; padding: 10px 12px; background: var(--bg);
    border: 1px solid var(--border); border-radius: 4px;
    font-family: var(--mono); font-size: 12px; line-height: 1.55;
    color: var(--text); overflow: auto; max-height: 200px;
  }
  pre.clean { color: var(--dim); font-style: italic; }
  ul.commits { list-style: none; margin: 0; padding: 0; font-size: 13px; }
  ul.commits li {
    display: flex; gap: 10px; align-items: baseline;
    padding: 5px 0; border-bottom: 1px solid var(--border);
  }
  ul.commits li:last-child { border-bottom: none; padding-bottom: 0; }
  ul.commits .h { font-family: var(--mono); font-size: 12px; color: var(--purple); flex-shrink: 0; }
  ul.commits .s { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ul.commits .w { font-size: 11px; color: var(--muted); white-space: nowrap; }
  .error { color: var(--red); font-family: var(--mono); font-size: 12px; }
  .empty { color: var(--dim); font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>repo stats</h1>
    <div class="meta">
      <span id="host">—</span> · <span id="updated">—</span><span id="stale" class="stale"></span>
    </div>
  </header>
  <div class="repos" id="repos">
    <div class="empty">loading…</div>
  </div>
</div>

<script>
const REFRESH_MS = 15000;
let lastGeneratedAt = 0;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));

function renderRepo(r) {
  if (r.error) {
    return `<div class="repo">
      <div class="repo-head"><div class="repo-id"><div class="repo-name">${esc(r.name)}</div></div></div>
      <div class="repo-body"><div class="error">${esc(r.error)}</div></div>
    </div>`;
  }
  const statusClean = !r.status || !r.status.trim();
  const statusHtml = statusClean
    ? `<pre class="clean">clean</pre>`
    : `<pre>${esc(r.status.trimEnd())}</pre>`;
  const recent = (r.recent || []).map(c =>
    `<li><span class="h">${esc(c.hash)}</span><span class="s" title="${esc(c.subject)}">${esc(c.subject)}</span><span class="w">${esc(c.when)}</span></li>`
  ).join('');
  return `
    <div class="repo">
      <div class="repo-head">
        <div class="repo-id">
          <div class="repo-name">${esc(r.name)}</div>
          <div class="repo-path">${esc(r.path)}</div>
        </div>
        <span class="branch">${esc(r.branch)}</span>
      </div>
      <div class="repo-body">
        <div class="commit">
          <span class="hash">${esc(r.commitShort)}</span>
          <span class="subject">${esc(r.subject)}</span>
          <span class="author">${esc(r.author)} · ${esc(r.lastCommitRel)}</span>
        </div>
        <div class="stats">
          <div class="stat mod"><div class="v">${r.modified}</div><div class="k">modified</div></div>
          <div class="stat add"><div class="v">+${r.additions}</div><div class="k">added</div></div>
          <div class="stat del"><div class="v">−${r.deletions}</div><div class="k">deleted</div></div>
          <div class="stat unp"><div class="v">${r.unpushed}</div><div class="k">unpushed</div></div>
        </div>
        <div class="section">working tree</div>
        ${statusHtml}
        <div class="section">recent commits · ${r.totalCommits} total</div>
        <ul class="commits">${recent || '<li class="empty">no commits</li>'}</ul>
      </div>
    </div>
  `;
}

async function load() {
  try {
    const res = await fetch('/stats.json?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    document.getElementById('host').textContent = data.host;
    document.getElementById('updated').textContent = data.generatedAtLocal;
    lastGeneratedAt = new Date(data.generatedAt).getTime();
    document.getElementById('repos').innerHTML =
      (data.repos || []).map(renderRepo).join('') ||
      '<div class="empty">no repos configured</div>';
  } catch (e) {
    document.getElementById('repos').innerHTML =
      `<div class="repo"><div class="repo-body"><div class="error">failed to load: ${esc(e.message)}</div></div></div>`;
  }
}

function tick() {
  const el = document.getElementById('stale');
  if (!lastGeneratedAt) return;
  const age = Math.floor((Date.now() - lastGeneratedAt) / 1000);
  el.textContent = age > 45 ? ` · stale ${age}s` : '';
}

load();
setInterval(load, REFRESH_MS);
setInterval(tick, 1000);
</script>
</body>
</html>
```

---

## Step 3 — Nginx Configuration

Serve the dashboard on **localhost only** — Cloudflare Tunnel is the only thing that needs to reach it.

### Choosing a Port

Avoid common ports (80, 443, 3000, 8000, 8080). Pick something in the ephemeral range that's unlikely to collide:

```bash
sudo ss -tlnp | grep 12095     # verify nothing is listening
```

### `/etc/nginx/sites-available/stats.conf`

```nginx
server {
    listen 127.0.0.1:12095;
    server_name stats.inxeoz.com;

    root  /home/inxeoz/Work/tries/2026-09-29-stats.inxeoz.com;
    index index.html;

    # Live stats — never cache
    add_header Cache-Control "no-store, no-cache, must-revalidate";

    # Hashed/static assets (if you add any later)
    location ~* \.(?:js|mjs|css|map|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|webp|avif)$ {
        try_files $uri =404;
        expires 1y;
        access_log off;
        add_header Cache-Control "public, immutable";
    }

    # stats.json — always fresh
    location = /stats.json {
        default_type application/json;
        add_header Cache-Control "no-store";
    }

    # index.html — no cache
    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        expires -1;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/stats.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Permission Note

Nginx runs as `www-data` (or `http` on some distros). It must be able to read the directory. If the project lives under your home folder:

```bash
sudo chmod -R o+rX /home/inxeoz/Work/tries/2026-09-29-stats.inxeoz.com
sudo chmod o+x /home /home/inxeoz /home/inxeoz/Work /home/inxeoz/Work/tries
```

Verify locally:

```bash
curl -I http://127.0.0.1:12095/
curl -s http://127.0.0.1:12095/stats.json | jq
```

---

## Step 4 — Cloudflare Tunnel Setup

Cloudflare Tunnel creates an outbound-only connection to Cloudflare's edge. Your machine never accepts inbound traffic.

### Create the Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create my-tunnel
```

Note the UUID it prints (e.g., `a80f5f22-bc4b-4890-b453-fa1f9c62b88c`).

### DNS Route

```bash
cloudflared tunnel route dns my-tunnel stats.inxeoz.com
```

This creates a `CNAME` from `stats.inxeoz.com` → `<UUID>.cfargotunnel.com`, proxied through Cloudflare.

> If DNS already has an `A`/`AAAA`/`CNAME` record for that hostname, delete it first or edit it to point to `<UUID>.cfargotunnel.com`.

### Config File

**`~/.cloudflared/config.yml`** (or `/etc/cloudflared/config.yml` if running as root):

```yaml
tunnel: a80f5f22-bc4b-4890-b453-fa1f9c62b88c
credentials-file: /home/inxeoz/.cloudflared/a80f5f22-bc4b-4890-b453-fa1f9c62b88c.json

ingress:
  - hostname: stats.inxeoz.com
    service: http://127.0.0.1:12095
  - service: http_status:404
```

**Important:** the catch-all `- service: http_status:404` must be last. cloudflared matches rules top-to-bottom and refuses to start without a terminal catch-all.

### Install as a systemd Service

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Or restart if already installed:

```bash
sudo systemctl restart cloudflared
```

### Validate

```bash
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://stats.inxeoz.com
```

The second command should print the matching service (`http://127.0.0.1:12095`).

Test:

```bash
curl -I https://stats.inxeoz.com
```

You'll get a Cloudflare response. At this point the page is public unless we add Access (next step).

---

## Step 5 — Google OAuth via Cloudflare Access

Cloudflare Access is a Zero Trust identity proxy that sits in front of your tunnel hostname. Only users who pass the configured identity check reach your backend.

### 5.1 — Create Google OAuth Credentials

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or reuse one).
3. **APIs & Services → OAuth consent screen**:
   - User Type: **External**
   - App name: whatever you like (e.g., `Repo Stats`)
   - Support email + Developer contact: your email
   - Save through the "Scopes" and "Test Users" sections (skip both).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Name: `Cloudflare Access`
   - Authorized redirect URI: `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback`
5. Copy the **Client ID** and **Client Secret**.

> The team name is visible in the Zero Trust dashboard → Settings → **Team name**. If your team name is `inxeoz`, the redirect URI is exactly:
> ```
> https://inxeoz.cloudflareaccess.com/cdn-cgi/access/callback
> ```

### 5.2 — Add Google as an Identity Provider in Cloudflare

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com/).
2. **Settings → Authentication → Login methods → Add new → Google**.
3. Paste the Client ID and Client Secret.
4. Save.

### 5.3 — Create the Access Application

1. **Access → Applications → Add an application → Self-hosted**.
2. Application name: `repo stats`.
3. Session duration: `24 hours` (or your preference).
4. **Public hostname**: `stats.inxeoz.com` (path `/`).
5. Save.

### 5.4 — Add a Policy

Inside the application → **Policies → Add a policy**:

- **Name**: `allow teammates`
- **Action**: `Allow`
- **Rules**:
  - **Include → Emails** → `you@gmail.com`, `colleague@gmail.com`
  - or **Include → Emails ending in** → `@yourcompany.com`

Save.

### 5.5 — Force Google-Only Login (Optional)

By default, Cloudflare Access offers One-Time PIN as a fallback. To restrict to Google only:

- Application → **Authentication** tab
- Turn **Accept all available identity providers** → **Off**
- Under "Choose available identity providers", select **Google** only
- Save

### Test

Open `https://stats.inxeoz.com` in an **incognito window**:

1. You should be redirected to `inxeoz.cloudflareaccess.com` → Google login.
2. Log in with an allowlisted account → you land on the dashboard.
3. Log in with a **non**-allowlisted account → "Access denied".

---

## Step 6 — systemd Timer for Auto-Refresh

We need `generate-stats.sh` to run every 15 seconds, forever, from boot. The idiomatic systemd approach is **one oneshot service + one timer**.

### Why Timer + Oneshot, Not a Loop Service

| | Timer + oneshot | Loop service (`while true`) |
|---|---|---|
| Timing accuracy | systemd-scheduled, no drift | `script_time + sleep 15` drifts |
| Failure visibility | Each failed run is a discrete failed unit | Swallowed inside bash |
| Logs | Clean per-run blocks in journal | One endless stream |
| Interval change | Edit one line, reload | Edit `ExecStart`, restart |

### 6.1 — The Service Unit

Create in your **project folder** (not `/etc/systemd/system/` — we'll symlink later):

**`/home/inxeoz/Work/tries/2026-09-29-stats.inxeoz.com/repo-stats.service`**

```ini
[Unit]
Description=Generate repo stats JSON

[Service]
Type=oneshot
User=inxeoz
Group=inxeoz
WorkingDirectory=/home/inxeoz/Work/tries/2026-09-29-stats.inxeoz.com
ExecStart=/home/inxeoz/Work/tries/2026-09-29-stats.inxeoz.com/generate-stats.sh
```

**Line-by-line:**

- `Type=oneshot` — this unit runs to completion and exits. It's not a daemon.
- `User=`/`Group=` — run as `inxeoz`, not root. Files written will be owned by `inxeoz`.
- `WorkingDirectory=` — sets cwd before exec. Not strictly needed since the script uses absolute paths, but good hygiene.
- `ExecStart=` — **must be an absolute path**.
- **No `[Install]` section** — this unit is never enabled or started directly. The timer triggers it.

### 6.2 — The Timer Unit

**`/home/inxeoz/Work/tries/2026-09-29-stats.inxeoz.com/repo-stats.timer`**

```ini
[Unit]
Description=Run repo-stats every 15s

[Timer]
OnBootSec=10s
OnUnitActiveSec=15s
AccuracySec=1s
Unit=repo-stats.service

[Install]
WantedBy=timers.target
```

**Line-by-line:**

- `OnBootSec=10s` — first run 10 seconds after boot (lets the system settle).
- `OnUnitActiveSec=15s` — subsequent runs fire 15 seconds after the *previous activation*, so drift never accumulates.
- `AccuracySec=1s` — systemd coalesces timer wakeups by default (up to 1 minute). Setting this to 1s forces precision, important for a 15s cadence.
- `Unit=` — explicit link to the service. Without this, systemd would infer `repo-stats.service` from the matching name.
- `WantedBy=timers.target` — the timer itself is enabled at boot.

### 6.3 — Symlink into systemd

Keeping unit files in the project folder lets you version them alongside the code.

```bash
sudo ln -sf /home/inxeoz/Work/tries/2026-09-29-stats.inxeoz.com/repo-stats.service \
            /etc/systemd/system/repo-stats.service
sudo ln -sf /home/inxeoz/Work/tries/2026-09-29-stats.inxeoz.com/repo-stats.timer \
            /etc/systemd/system/repo-stats.timer
```

### 6.4 — Enable and Start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now repo-stats.timer
```

**Enable only the timer.** Do not `systemctl enable repo-stats.service` — that would run the script twice at boot (once from the timer, once from the autostart).

### 6.5 — Verify

```bash
systemctl list-timers | grep repo-stats
```

Expected:
```
NEXT                         LEFT     LAST                         PASSED    UNIT              ACTIVATES
Tue … 17:20:17 IST          11s left Tue … 17:20:02 IST          3s ago    repo-stats.timer  repo-stats.service
```

```bash
systemctl status repo-stats.service
```

Expected between ticks:
```
Active: inactive (dead) since Tue …
Main PID: 628356 (code=exited, status=0/SUCCESS)
TriggeredBy: ● repo-stats.timer
```

Watch the journal live:

```bash
journalctl -u repo-stats.service -f
```

You should see one block every 15 seconds:
```
Starting Generate repo stats JSON...
Deactivated successfully.
Finished
