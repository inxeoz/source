---
title: "Running Frappe / ERPNext Docker Deployments Fully Offline"
date: 2026-01-27
draft: false
tags: ["frappe", "images", "tar", "running", "erpnext", "docker", "deployments", "fully"]
categories: ["Tech"]
viewMode: docs
showToc: true
---

# Running Frappe / ERPNext Docker Deployments Fully Offline

## Building, Exporting, Loading, and Serving Docker Images Without Internet

---

## 1. Purpose of This Guide

This article explains **how to deploy Docker applications in an offline / air-gapped environment**, using **Frappe / ERPNext** as a real example.

We specifically base this workflow on the official repository:

**[https://github.com/frappe/frappe_docker](https://github.com/frappe/frappe_docker)**

The same approach applies to **any Docker Compose–based system**, not just Frappe.

---

## 2. Why Offline Docker Deployment Is Hard

Docker is designed for **online registries**:

* Docker Hub
* GitHub Container Registry (GHCR)
* Private registries

By default:

* `docker compose up` will **pull images**
* `docker run` will **fail if image is missing**
* Production servers often **cannot access the internet**

**Goal:**
Prepare everything on an online machine, then run **100% offline**.

---

## 3. Source of Images (Frappe Docker)

All Frappe / ERPNext Docker images come from:

**Repository**

```
https://github.com/frappe/frappe_docker
```

**Published images**

* `frappe/erpnext:<version>`
* `frappe/base:<tag>`
* `frappe/build:<tag>`

Supporting services:

* `mariadb:10.6`
* `redis:6.2-alpine`

These images are normally pulled from Docker Hub.

---

## 4. Docker Basics Used in This Guide

These are the **only Docker commands you really need** for offline deployment.

### 4.1 Image Management

```bash
docker pull IMAGE
docker images
docker save IMAGE -o file.tar
docker load -i file.tar
docker rmi IMAGE
```

### 4.2 Container & Compose Management

```bash
docker compose up -d
docker compose up -d --pull=never
docker compose down
docker compose ps
docker compose logs SERVICE
docker compose exec SERVICE COMMAND
```

### 4.3 Debugging

```bash
docker ps
docker ps -a
docker logs CONTAINER
docker inspect CONTAINER
```

---

## 5. Phase 1 — Prepare on an Online Machine

### 5.1 Clone Frappe Docker Repository

```bash
git clone https://github.com/frappe/frappe_docker.git
cd frappe_docker
```

This repo provides:

* Official `compose.yaml`
* Reference configs
* Production-tested image versions

---

### 5.2 Identify Required Images

From your compose file (`compose.yaml` or `pwd.yml`), list **every image**:

Example:

```yaml
image: frappe/erpnext:v15.93.2
image: mariadb:10.6
image: redis:6.2-alpine
```

You **must include all of them** in the offline bundle.

---

### 5.3 Pull Images Online

```bash
docker pull frappe/erpnext:v15.93.2
docker pull mariadb:10.6
docker pull redis:6.2-alpine
```

Verify:

```bash
docker images
```

---

## 6. Phase 2 — Export Images as a TAR Bundle

### 6.1 Create Export Directory

```bash
mkdir -p docker_images
```

---

### 6.2 Save Images into a Single TAR

```bash
docker save \
  frappe/erpnext:v15.93.2 \
  mariadb:10.6 \
  redis:6.2-alpine \
  -o docker_images/frappe_offline_bundle.tar
```

This TAR now contains:

* All image layers
* All metadata
* No registry dependency

---

## 7. Phase 3 — Transfer to Offline Server

Copy these files to the offline server:

* `frappe_offline_bundle.tar`
* `docker-compose.yml` / `pwd.yml`
* `.env` file (if used)

Transfer methods:

* USB drive
* SCP
* Internal artifact server

---

## 8. Phase 4 — Load Images Offline

On the offline server:

```bash
docker load -i docker_images/frappe_offline_bundle.tar
```

Verify:

```bash
docker images
```

---

## 9. Phase 5 — Run Docker Without Internet

### 9.1 Critical Rule: Never Pull

Always run:

```bash
docker compose up -d --pull=never
```

This guarantees:

* Docker will not attempt registry access
* Deployment works in air-gapped environments

---

## 10. Networking & Startup Order (Important)

### 10.1 Docker DNS Is Name-Based

Services resolve each other using **service names**:

```yaml
BACKEND=backend:8000
```

If a service starts too early, DNS may fail:

```
host not found in upstream "backend:8000"
```

---

### 10.2 Always Use `depends_on`

Example (frontend service):

```yaml
frontend:
  depends_on:
    - backend
    - websocket
```

This prevents:

* nginx crash loops
* DNS resolution failures
* infinite restarts

---

## 11. Persistent Storage (Offline-Safe)

Images are immutable.
All **state must live in volumes**.

Example:

```yaml
volumes:
  db-data:
  redis-data:
  sites:
  logs:
```

Volumes:

* work offline
* survive restarts
* survive upgrades

---

## 12. Validation Checklist

### 12.1 Container Health

```bash
docker compose ps
```

All services should show:

```
Up
```

---

### 12.2 Logs

```bash
docker compose logs frontend
docker compose logs backend
docker compose logs db
```

Logs are the **single source of truth**.

---

### 12.3 HTTP Test

```bash
curl http://localhost:8080
```

Or open in browser:

```
http://<server-ip>:8080
```

---

## 13. Common Offline Mistakes

### Missing Image

**Fix:** Rebuild TAR including that image.

---

### Docker tries to pull

**Fix:** Always use `--pull=never`.

---

### Frontend restarting

**Fix:**

* Check `depends_on`
* Check service names
* Check logs for DNS errors

---

### “Works online, fails offline”

**Cause:** Hidden dependency not exported.

**Fix:**
Inspect compose file and export **every image explicitly**.

---

## 14. Production Offline Checklist

* [ ] Images pulled online
* [ ] TAR created via `docker save`
* [ ] TAR tested via `docker load`
* [ ] `--pull=never` enforced
* [ ] `depends_on` configured
* [ ] Volumes defined
* [ ] Logs clean after restart
* [ ] No registry access required

---

## 15. Conclusion

The official **frappe/frappe_docker** images are fully capable of offline operation.

Docker does not “break” offline — **it just doesn’t automate offline for you**.

Once you control:

* image lifecycle
* startup order
* DNS timing
* volumes

Offline deployments become **stable, predictable, and production-safe**.

---

### TL;DR

```bash
# Online
docker pull …
docker save … -o bundle.tar

# Offline
docker load -i bundle.tar
docker compose up -d --pull=never
```

