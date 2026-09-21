---
title: "Fixing Common Frappe Docker Errors, Backing Up, and Restoring Databases"
date: 2026-01-27
draft: false
tags: ["docker", "frappe", "fixing", "common", "errors", "backing", "up", "restoring"]
categories: ["Tech"]
viewMode: docs
showToc: true
---

# Fixing Common Frappe Docker Errors, Backing Up, and Restoring Databases

## 🧠 Introduction

Running **Frappe** or **ERPNext** in Docker simplifies deployment, but real-world use often brings challenges — like missing CSS, password mismatches, and restoring backups correctly.

This guide explains how to:

* Back up your **database and site files**
* Restore a full Frappe instance on a fresh Docker setup
* Fix **common Frappe Docker errors**
* Solve the notorious **“CSS not loading”** issue after restore

Tested on **Arch Linux (Manjaro i3)** using **Frappe/ERPNext v15**.

---

## 🐳 1. Frappe Docker Overview

A typical `frappe_docker` setup runs these containers:

| Container                   | Role                                      |
| --------------------------- | ----------------------------------------- |
| `frappe_docker-frontend-1`  | Nginx web server (serves frontend assets) |
| `frappe_docker-backend-1`   | Bench and Python app server               |
| `frappe_docker-db-1`        | MariaDB database                          |
| `frappe_docker-redis-*`     | Redis for cache, queue, socketio          |
| `frappe_docker-scheduler-1` | Scheduled background jobs                 |
| `frappe_docker-queue-*`     | Workers handling background tasks         |

Each container is isolated — site data, database, and static files live in different volumes.

---

## 💾 2. Backing Up Frappe / ERPNext Data

A complete backup includes two parts:

1. **Database Dump (.sql)**
2. **Site Files (site folder with public/private/uploads)**

---

### 🔍 Step 1 — Find Your Database Info

Run inside the backend container:

```bash
docker exec -it frappe_docker-backend-1 cat /home/frappe/frappe-bench/sites/frontend/site_config.json
```

You’ll see something like:

```json
{
  "db_name": "_5e5899d8398b5f7b",
  "db_password": "8F9NalSR2to37McZ",
  "db_type": "mariadb"
}
```

---

### 💾 Step 2 — Backup the Database

Run on your **host**, not inside a container:

```bash
docker exec -i frappe_docker-db-1 mysqldump -u _5e5899d8398b5f7b -p'8F9NalSR2to37McZ' _5e5899d8398b5f7b > frappe_db_backup.sql
```

✅ Creates `frappe_db_backup.sql` on your host.

---

### 🗂 Step 3 — Backup Site Files

```bash
docker exec -t frappe_docker-backend-1 tar czf - -C /home/frappe/frappe-bench sites > frappe_sites_backup.tar.gz
```

✅ This saves your entire `sites/` directory (public, private, and configs).

---

### 🗓 Step 4 — Organize Backups

Keep things clean and dated:

```bash
mkdir -p backups/$(date +%F)
mv frappe_db_backup.sql frappe_sites_backup.tar.gz backups/$(date +%F)/
```

---

## 🔁 3. Restoring a Backup to a Fresh Instance

### Step 1 — Remove Old Setup

```bash
docker stop $(docker ps -aq --filter "name=frappe_docker-")
docker rm $(docker ps -aq --filter "name=frappe_docker-")
docker volume rm $(docker volume ls -q --filter "name=frappe_docker")
```

---

### Step 2 — Recreate the Stack

```bash
git clone https://github.com/frappe/frappe_docker.git
cd frappe_docker
docker compose -f compose.yaml -f overrides/compose.erpnext.yaml up -d
```

---

### Step 3 — Restore Database

Copy your SQL backup into the DB container:

```bash
docker cp frappe_db_backup.sql frappe_docker-db-1:/root/
```

Access the DB container:

```bash
docker exec -it frappe_docker-db-1 bash
```

Inside MariaDB:

```bash
mysql -u root -p
```

Then:

```sql
CREATE DATABASE _5e5899d8398b5f7b;
GRANT ALL PRIVILEGES ON _5e5899d8398b5f7b.* TO '_5e5899d8398b5f7b'@'%' IDENTIFIED BY '8F9NalSR2to37McZ';
FLUSH PRIVILEGES;
EXIT;
```

Now import:

```bash
mysql -u _5e5899d8398b5f7b -p'8F9NalSR2to37McZ' _5e5899d8398b5f7b < /root/frappe_db_backup.sql
exit
```

---

### Step 4 — Restore Site Files

```bash
docker cp frappe_sites_backup.tar.gz frappe_docker-backend-1:/home/frappe/
docker exec -it frappe_docker-backend-1 bash
cd /home/frappe/frappe-bench
tar -xzf /home/frappe/frappe_sites_backup.tar.gz
exit
```

---

### Step 5 — Sync Passwords

If `db_password` mismatches:

```bash
docker exec -it frappe_docker-db-1 mysql -u root -p
```

Then:

```sql
ALTER USER '_5e5899d8398b5f7b'@'%' IDENTIFIED BY 'k8INrBbWUX3RrGNB';
FLUSH PRIVILEGES;
EXIT;
```

---

### Step 6 — Migrate and Rebuild

```bash
docker exec -it frappe_docker-backend-1 bash
cd /home/frappe/frappe-bench
bench --site frontend migrate
bench build
exit
docker compose restart
```

---

## 🎨 4. Fix: CSS or JS Not Loading After Restore

**Symptom:**
ERPNext loads as plain text with no CSS or theme — “unstyled” page.

**Root Causes:**

* Missing or outdated assets in `/sites/assets/`
* Version mismatch between your site and current image
* Nginx serving cached or broken links

---

### ✅ Solution 1 — Rebuild Assets

```bash
docker exec -it frappe_docker-backend-1 bash
cd /home/frappe/frappe-bench
bench build
bench clear-cache
bench clear-website-cache
exit
docker restart frappe_docker-frontend-1
```

---

### ✅ Solution 2 — Delete Old Assets and Rebuild

```bash
docker exec -it frappe_docker-backend-1 bash
cd /home/frappe/frappe-bench/sites
rm -rf assets
cd /home/frappe/frappe-bench
bench build
exit
docker restart frappe_docker-frontend-1
```

---

### ✅ Solution 3 — Clear Browser + Nginx Cache

1. In your browser → **DevTools → Network → Disable cache**
2. Hard-refresh (`Ctrl+Shift+R` or `Cmd+Shift+R`)
3. Restart containers again if necessary:

   ```bash
   docker compose restart
   ```

---

### ✅ Solution 4 — Version Sync Fix (Advanced)

If you restored a site from a different ERPNext/Frappe version, you may need to rebuild the assets with matching code:

```bash
docker exec -it frappe_docker-backend-1 bash
cd /home/frappe/frappe-bench
bench setup requirements
bench build
exit
docker restart frappe_docker-frontend-1
```

---

### ✅ Solution 5 — Check Assets Path in Nginx

Inside the frontend container:

```bash
docker exec -it frappe_docker-frontend-1 cat /etc/nginx/conf.d/default.conf | grep assets
```

Ensure it points to `/usr/share/nginx/html/assets` or the correct mounted site assets volume.

---

## ⚙️ 5. Common Frappe Docker Errors & Fixes

| Problem                       | Cause                     | Fix                                                     |
| ----------------------------- | ------------------------- | ------------------------------------------------------- |
| **Access denied for user**    | DB password mismatch      | Update `site_config.json` or run `ALTER USER`           |
| **Redis connection refused**  | Redis container not ready | `docker restart frappe_docker-redis-*`                  |
| **Bench commands restricted** | Production mode           | Use `docker exec -it frappe_docker-backend-1 bash`      |
| **Missing site error**        | Site folder not restored  | Copy site folder into `/home/frappe/frappe-bench/sites` |
| **No CSS / unstyled site**    | Broken assets             | Run `bench build` and restart Nginx                     |
| **Port 8080 already in use**  | Conflict with another app | Change port mapping in compose file                     |

---

## 🔍 6. Verify the Restore

1. Open [http://localhost:8080](http://localhost:8080)
2. Log in with your old credentials
3. Run:

   ```bash
   docker exec -it frappe_docker-backend-1 bench doctor
   ```

   Ensure all services are **green (OK)**.

---

## 🧹 7. Cleanup

Once restored successfully:

```bash
docker exec -it frappe_docker-db-1 rm /root/frappe_db_backup.sql
docker exec -it frappe_docker-backend-1 rm /home/frappe/frappe_sites_backup.tar.gz
```

---

## 🧠 8. Summary

| Task          | Command                                                             |
| ------------- | ------------------------------------------------------------------- |
| Backup DB     | `docker exec -i frappe_docker-db-1 mysqldump ... > backup.sql`      |
| Backup Site   | `docker exec -t frappe_docker-backend-1 tar czf ... > sites.tar.gz` |
| Restore DB    | `mysql -u user -p'pass' db < backup.sql`                            |
| Restore Files | `tar -xzf sites.tar.gz -C /home/frappe/frappe-bench`                |
| Fix CSS       | `bench build && docker restart frappe_docker-frontend-1`            |
| Verify        | `bench doctor`                                                      |

---



---
