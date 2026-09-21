---
title: "Managing Docker Containers Like a Pro"
date: 2026-01-27
draft: true
tags: ["docker", "container", "managing", "containers", "like", "pro"]
categories: ["Tech"]
viewMode: docs
showToc: true
---

# Managing Docker Containers Like a Pro

---

## 1. What is a Docker Container?

A **container** is a running instance of a **Docker image** — a lightweight, isolated environment that can hold your software, tools, and files.

* **Image** = the blueprint (a frozen snapshot, like an OS or preconfigured setup)
* **Container** = the living instance of that image

When you stop or delete a container, your data and changes can vanish — unless you know how to make them persistent.

---

## 2. Creating and Running a Container

To start a container interactively:

```bash
docker run -it ubuntu:22.04 bash
```

Here’s what each flag does:

* `-i` → Interactive mode (keeps STDIN open)
* `-t` → Allocates a pseudo-TTY (makes it feel like a real terminal)
* `ubuntu:22.04` → The image to base the container on
* `bash` → The command to run inside (the shell)

You’ll now be inside the container’s terminal (`root@containerID:/#`).

---

## 3. Creating a Named Container (for Persistence)

If you don’t name your container, Docker gives it a random name.
You can assign your own with `--name` so you can reopen it later.

```bash
docker run -it --name myubuntu ubuntu:22.04 bash
```

Exit when you’re done:

```bash
exit
```

Later, restart it and reattach with:

```bash
docker start -ai myubuntu
```

All files and installed packages will still be there.

---

## 4. Making Data Persistent (Volumes)

By default, container files live *inside* the container — so if it’s removed, data is gone.
You can **mount a directory from your host** to the container using `-v`.

Example:

```bash
docker run -it -v ~/mydata:/root/data ubuntu:22.04 bash
```

* `~/mydata` → folder on your host
* `/root/data` → folder inside the container

Now, anything you save in `/root/data` is stored *on your host system* — even if the container is deleted.

---

## 5. Mapping Ports (Accessing Apps from Host)

If your container runs a web server or service (like mdserve, Flask, etc.), you’ll need to map its ports to the host system.

Use `-p` to map ports:

```bash
docker run -it -p 8000:8000 ubuntu:22.04 bash
```

* `8000:8000` → host_port:container_port
  So if your app listens on port 8000 inside, you can visit it on your host at `http://localhost:8000`.

---

## 6. Saving Changes (Committing a Container)

When you customize a container (install software, edit configs, etc.), you can **commit** it to save the state as a new image.

```bash
docker commit myubuntu myubuntu:custom
```

Now you can start new containers from your saved configuration:

```bash
docker run -it --name myclone myubuntu:custom bash
```

This creates a new container with all your changes already baked in — like a snapshot.

---

## 7. Running a Specific Commit

Each commit you make creates a **new image layer**, identified by an **image ID** or tag.

To list your images:

```bash
docker images
```

Output:

```
REPOSITORY       TAG        IMAGE ID       CREATED          SIZE
myubuntu         custom     e21a34bfb3a4   2 minutes ago    480MB
```

To run a specific version by ID or tag:

```bash
docker run -it e21a34bfb3a4 bash
# or
docker run -it myubuntu:custom bash
```

---

## 8. Removing Containers and Images

Over time, you may accumulate old containers or images.
Here’s how to clean up safely.

### Remove a single container:

```bash
docker rm myubuntu
```

### Remove all stopped containers:

```bash
docker container prune
```

### Remove an image:

```bash
docker rmi myubuntu:custom
```

### Remove all unused data (CAUTION):

```bash
docker system prune -a
```

---

## 9. Running a Container Again by Name

If you used `--name`, you can easily restart your container later.

Example:

```bash
docker start -ai myubuntu
```

That’s shorthand for:

* `start` → start the container
* `-a` → attach to it (see output)
* `-i` → interactive (so you can type commands)

You’ll be dropped back into your previous environment instantly.

---

## 10. Quick Reference Summary

| Task                         | Command                                  | Description                          |
| ---------------------------- | ---------------------------------------- | ------------------------------------ |
| Run container interactively  | `docker run -it ubuntu:22.04 bash`       | Start Ubuntu with a shell            |
| Name your container          | `--name myubuntu`                        | Allows reusing it later              |
| Restart container            | `docker start -ai myubuntu`              | Reattach to existing one             |
| Commit container             | `docker commit myubuntu myubuntu:custom` | Save current state                   |
| Run from commit              | `docker run -it myubuntu:custom bash`    | Create new instance from saved image |
| Map host port                | `-p 8000:8000`                           | Access container service from host   |
| Mount folder                 | `-v ~/mydata:/root/data`                 | Persist files outside container      |
| Delete container             | `docker rm myubuntu`                     | Remove container                     |
| Clean all stopped containers | `docker container prune`                 | Free space safely                    |
| Clean all unused images      | `docker image prune -a`                  | Remove unused images                 |

---

## Bonus Tips

* Use `--rm` **only for temporary** testing containers (it auto-deletes after exit).
* Always **commit** after large configuration changes.
* Combine volumes (`-v`) and ports (`-p`) for realistic app testing.
* Use descriptive names (`--name devserver`, `--name docs`, etc.) to stay organized.

---



---
