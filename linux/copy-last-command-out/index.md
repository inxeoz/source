# `cwdsync` — Setup Guide

A pty wrapper that logs your shell session and keeps your terminal's cwd in sync, so `Ctrl+Shift+Enter` (new window) and `Ctrl+Shift+T` (new tab) open in the right directory even when you're running a logging wrapper.

---

## What you get

- Every shell session is logged to a file.
- `x` copies the last command's output to the clipboard.
- `x N` copies the output of the N-th most recent command.
- `Ctrl+Shift+Enter` / `Ctrl+Shift+T` open in the current directory.
- No tmux, no keybinding conflicts.

---

## 1. Create the wrapper source

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/cwdsync.c <<'EOF'
/* cwdsync.c — pty relay that logs output and syncs its own cwd to the child's */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <pty.h>
#include <signal.h>
#include <sys/select.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>

static volatile sig_atomic_t got_winch = 0;
static void on_winch(int sig) { (void)sig; got_winch = 1; }

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: %s LOGFILE CMD [ARGS...]\n", argv[0]);
        return 2;
    }
    const char *logpath = argv[1];

    struct winsize ws = {0};
    ioctl(STDIN_FILENO, TIOCGWINSZ, &ws);

    int master;
    pid_t pid = forkpty(&master, NULL, NULL, &ws);
    if (pid < 0) { perror("forkpty"); return 1; }
    if (pid == 0) {
        execvp(argv[2], &argv[2]);
        _exit(127);
    }

    FILE *log = fopen(logpath, "ab");
    if (!log) { perror("fopen"); return 1; }
    setvbuf(log, NULL, _IONBF, 0);

    struct termios orig, raw;
    tcgetattr(STDIN_FILENO, &orig);
    raw = orig; cfmakeraw(&raw);
    tcsetattr(STDIN_FILENO, TCSANOW, &raw);

    struct sigaction sa = {0};
    sa.sa_handler = on_winch;
    sigaction(SIGWINCH, &sa, NULL);

    char cwd_link[64];
    snprintf(cwd_link, sizeof(cwd_link), "/proc/%d/cwd", pid);

    char buf[8192];
    while (1) {
        if (got_winch) {
            got_winch = 0;
            struct winsize nw = {0};
            ioctl(STDIN_FILENO, TIOCGWINSZ, &nw);
            ioctl(master, TIOCSWINSZ, &nw);
        }

        fd_set rfds; FD_ZERO(&rfds);
        FD_SET(STDIN_FILENO, &rfds);
        FD_SET(master, &rfds);
        struct timeval tv = {0, 100000};
        int n = select(master + 1, &rfds, NULL, NULL, &tv);
        if (n < 0) {
            if (got_winch) continue;
            break;
        }

        if (FD_ISSET(STDIN_FILENO, &rfds)) {
            ssize_t r = read(STDIN_FILENO, buf, sizeof buf);
            if (r <= 0) break;
            if (write(master, buf, r) < 0) break;
        }
        if (FD_ISSET(master, &rfds)) {
            ssize_t r = read(master, buf, sizeof buf);
            if (r <= 0) break;
            if (write(STDOUT_FILENO, buf, r) < 0) break;
            fwrite(buf, 1, r, log);
        }

        char target[4096], cur[4096];
        ssize_t rl = readlink(cwd_link, target, sizeof target - 1);
        if (rl > 0) {
            target[rl] = 0;
            if (getcwd(cur, sizeof cur) && strcmp(cur, target) != 0)
                (void)chdir(target);
        }
    }

    tcsetattr(STDIN_FILENO, TCSANOW, &orig);
    fclose(log);

    int status = 0;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
EOF
```

## 2. Compile

```bash
cc -O2 -o ~/.local/bin/cwdsync ~/.local/bin/cwdsync.c -lutil
```

Verify:

```bash
~/.local/bin/cwdsync
# usage: /home/you/.local/bin/cwdsync LOGFILE CMD [ARGS...]
```

## 3. Test it standalone

```bash
~/.local/bin/cwdsync /tmp/test.log bash -l
```

Inside the shell:

```bash
cd /tmp
```

Now press `Ctrl+Shift+Enter` in kitty. The new window should open in `/tmp`. If it does, the wrapper works.

Exit that shell. Confirm the log was written:

```bash
grep -a hello /tmp/test.log
```

## 4. Replace `~/.x.sh`

Drop this in as your full `~/.x.sh`. It uses `cwdsync` instead of `script`.

```bash
# ~/.x.sh
[[ $- != *i* ]] && return

# ---- outer: re-exec into cwdsync once per terminal ----
if [ -z "${X_LOG:-}" ]; then
    X_LOG_DIR="$HOME/.local/state/x-logs"
    mkdir -p "$X_LOG_DIR"
    find "$X_LOG_DIR" -maxdepth 1 -name 'shell-*.log' -type f -mtime +7 -delete 2>/dev/null

    export X_LOG="$X_LOG_DIR/shell-$$.log"
    export X_INNER=1
    : > "$X_LOG"
    exec "$HOME/.local/bin/cwdsync" "$X_LOG" bash -l
fi

# ---- inner only ----

__x_prompt() {
    printf '\036\033]7;file://%s%s\007' "$HOSTNAME" "$PWD"
}

__x_enable_markers() {
    PS0=$'\037'
    PS1='\[\e[1;32m\]\u@\h\[\e[0m\] \[\e[1;34m\]\w\[\e[0m\] \[\e[1;33m\]❯\[\e[0m\] '

    case "${PROMPT_COMMAND:-}" in
        *__x_prompt*) ;;
        "")           PROMPT_COMMAND='__x_prompt' ;;
        *)            PROMPT_COMMAND="__x_prompt; ${PROMPT_COMMAND}" ;;
    esac
}


# ---- x: copy last (or N-th last) command output to clipboard ----
x() {
    local idx="${1:-1}"
    [ -r "$X_LOG" ] || { echo "x: no log" >&2; return 1; }
    local out
    out=$(perl -e '
        my $idx = shift @ARGV;
        my $log = shift @ARGV;
        open my $fh, "<", $log or die "open $log: $!";
        local $/;
        my $t = <$fh>;
        close $fh;

        my @c = split /\x1f/, $t;
        pop @c while @c && $c[-1] eq "";
        my $p = @c >= $idx ? $c[-$idx] : "";
        $p =~ s/\x1e[^\x1e]*$//s;
        $p =~ s/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)//gs;
        $p =~ s/\x1b\[[0-?]*[ -\/]*[@-~]//g;
        $p =~ s/\x1b[()*+][0-9A-Za-z]//g;
        $p =~ s/\x1b[=>78cDEHMNO].?//gs;
        $p =~ s/\x1b//g;
        $p =~ s/\r//g;
        $p =~ s/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]//g;
        $p =~ s/\s+$//;
        print $p;
    ' "$idx" "$X_LOG")
    [ -n "$out" ] || { echo "x: nothing" >&2; return 1; }
    printf '%s' "$out" | wl-copy
    printf 'x: copied %d bytes (block -%s)\n' "$(printf '%s' "$out" | wc -c)" "$idx" >&2
}

# ---- xl: list block boundaries ----
xl() {
    [ -r "$X_LOG" ] || { echo "xl: no log" >&2; return 1; }
    perl -e '
        my $log = shift @ARGV;
        open my $fh, "<", $log or die "open $log: $!";
        local $/;
        my $t = <$fh>;
        close $fh;

        my @c = split /\x1f/, $t;
        pop @c while @c && $c[-1] eq "";
        my $n = scalar @c;
        for my $i (0 .. $#c) {
            my $idx = $n - $i;
            my $p = $c[$i];
            $p =~ s/\x1e[^\x1e]*$//s;
            $p =~ s/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)//gs;
            $p =~ s/\x1b\[[0-?]*[ -\/]*[@-~]//g;
            $p =~ s/\x1b[()*+][0-9A-Za-z]//g;
            $p =~ s/\x1b[=>78cDEHMNO].?//gs;
            $p =~ s/\x1b//g;
            $p =~ s/\r//g;
            $p =~ s/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]//g;
            $p =~ s/^\s+//; $p =~ s/\s+$//;
            my $line = $p =~ /^(.*)$/m ? $1 : "";
            $line = substr($line, 0, 80);
            printf "%3d  %s\n", $idx, $line;
        }
    ' "$X_LOG"
}

# ---- xf: dump all blocks to files ----
xf() {
    local dir="${1:-/tmp/xblocks}"
    [ -r "$X_LOG" ] || { echo "xf: no log" >&2; return 1; }
    mkdir -p "$dir"
    rm -f "$dir"/*
    perl -e '
        my $dir = shift @ARGV;
        my $log = shift @ARGV;
        open my $fh, "<", $log or die "open $log: $!";
        local $/;
        my $t = <$fh>;
        close $fh;

        my @c = split /\x1f/, $t;
        pop @c while @c && $c[-1] eq "";
        my $n = scalar @c;
        for my $i (0 .. $#c) {
            my $idx = $n - $i;
            my $p = $c[$i];
            $p =~ s/\x1e[^\x1e]*$//s;
            $p =~ s/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)//gs;
            $p =~ s/\x1b\[[0-?]*[ -\/]*[@-~]//g;
            $p =~ s/\x1b[()*+][0-9A-Za-z]//g;
            $p =~ s/\x1b[=>78cDEHMNO].?//gs;
            $p =~ s/\x1b//g;
            $p =~ s/\r//g;
            $p =~ s/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]//g;
            $p =~ s/\s+$//;
            open my $out, ">", sprintf("%s/%04d.txt", $dir, $idx) or next;
            print $out $p;
            close $out;
        }
    ' "$dir" "$X_LOG"
    echo "xf: wrote blocks to $dir"
}

# ---- xc: count blocks ----
xc() {
    [ -r "$X_LOG" ] || { echo "xc: no log" >&2; return 1; }
    perl -e '
        my $log = shift @ARGV;
        open my $fh, "<", $log or die "open $log: $!";
        local $/;
        my $t = <$fh>;
        close $fh;
        my @c = split /\x1f/, $t;
        pop @c while @c && $c[-1] eq "";
        print scalar(@c), "\n";
    ' "$X_LOG"
}


# ---- activate markers in the inner shell ----
__x_enable_markers

```

## 5. Make sure `~/.bashrc` sources it

Add to the top of `~/.bashrc` if it isn't already there:

```bash
[[ -f "$HOME/.x.sh" ]] && source "$HOME/.x.sh"
```

Kitty starts a login shell (`bash -l`), which reads `~/.bash_profile` first, not `~/.bashrc`. If your `.bashrc` isn't sourced from `.bash_profile`, add this to `~/.bash_profile`:

```bash
[[ -f "$HOME/.bashrc" ]] && source "$HOME/.bashrc"
```

## 6. Open a fresh kitty window

Everything below assumes a fresh window so the new `~/.x.sh` is loaded.

---

# Usage

## Check that it's running

```bash
echo "$X_INNER"     # 1
echo "$X_LOG"       # /home/you/.local/state/x-logs/shell-<pid>.log
```

## Verify cwd sync

```bash
cd /tmp
```

Press `Ctrl+Shift+Enter`. The new window should open in `/tmp`.

## Copy last command's output

```bash
ls -la
x
```

Paste somewhere to verify. You should see the `ls -la` output without escape codes.

## Copy earlier output

```bash
echo one
echo two
echo three
x 1     # three
x 2     # two
x 3     # one
```

## List blocks

```bash
xl
```

Prints one line per block, numbered from oldest (1) to newest. The number on the left is the argument to pass to `x`.

Example:

```
  1  echo one
  2  echo two
  3  echo three
```

## Count blocks

```bash
xc
```

## Dump every block to files

```bash
xf                # writes to /tmp/xblocks/
xf ~/blocks       # writes to ~/blocks/
```

Each block becomes `NNNN.txt` where `NNNN` matches the number from `xl`. Useful for grepping historical sessions:

```bash
xf
grep -ril "some-string" /tmp/xblocks/
```

---

# Adding OSC 133 blocks (optional, more robust)

If you want exit codes and unambiguous block boundaries, add OSC 133 emission.

Replace `__x_enable_markers` in `~/.x.sh` with:

```bash
__x_preexec() { printf '\033]133;C\007'; }
__x_precmd() {
    local ec=$?
    printf '\033]133;D;%s\007\033]133;A\007' "$ec"
    __x_prompt
}

__x_enable_markers() {
    PS0=$'\037'
    PS1='\[\e[1;32m\]\u@\h\[\e[0m\] \[\e[1;34m\]\w\[\e[0m\] \[\e[1;33m\]❯\[\e[0m\] '
    trap '__x_preexec' DEBUG

    case "${PROMPT_COMMAND:-}" in
        *__x_precmd*) ;;
        "")           PROMPT_COMMAND='__x_precmd' ;;
        *)            PROMPT_COMMAND="__x_precmd; ${PROMPT_COMMAND}" ;;
    esac
}
```

Add a block printer that reads OSC 133 boundaries:

```bash
xb() {
    [ -r "$X_LOG" ] || { echo "xb: no log" >&2; return 1; }
    perl -0777 -ne '
        while (/\e\]133;C\a(.*?)\e\]133;D;(\d+)\a/gs) {
            my ($body, $ec) = ($1, $2);
            $body =~ s/\e\][^\a\e]*(?:\a|\e\\)//gs;
            $body =~ s/\e\[[0-?]*[ -\/]*[@-~]//g;
            $body =~ s/\e[()*+][0-9A-Za-z]//g;
            $body =~ s/\e[=>78cDEHMNO].?//gs;
            $body =~ s/\e//g;
            $body =~ s/\r//g;
            $body =~ s/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]//g;
            $body =~ s/^\s+//; $body =~ s/\s+$//;
            print "=== exit $ec ===\n$body\n";
        }
    ' "$X_LOG"
}
```

Now `xb` prints every block with its exit code.

---

# Log management

Logs live in `~/.local/state/x-logs/`. They are pruned on every new terminal: files older than 7 days are deleted.

To change the retention:

```bash
# in ~/.x.sh, outer block
find "$X_LOG_DIR" -maxdepth 1 -name 'shell-*.log' -type f -mtime +30 -delete
```

To see current disk usage:

```bash
du -sh ~/.local/state/x-logs
ls -lh ~/.local/state/x-logs | tail
```

To nuke everything:

```bash
rm -f ~/.local/state/x-logs/shell-*.log
```

---

# Troubleshooting

**New windows still open in `~`.**

Run the wrapper by hand and test:

```bash
~/.local/bin/cwdsync /tmp/t.log bash -l
```

Inside, `cd /tmp`, then `Ctrl+Shift+Enter`. If it opens in `/tmp`, the wrapper works and something in `~/.x.sh` is short-circuiting the `exec`. Check:

```bash
echo "$X_INNER"
```

If it prints `1` *before* you open a `cwdsync` shell, then `X_INNER` is being exported from a parent and the outer block never runs. Unset it and open a new terminal:

```bash
unset X_INNER X_LOG
```

**`x` says "no log".**

`X_LOG` isn't set. Check:

```bash
echo "$X_LOG"
```

If empty, the outer block never ran. Make sure `~/.bashrc` sources `~/.x.sh` and that kitty is starting a login shell that reads it.

**`x` copies empty output.**

Run `xl` to see what blocks exist. If the block you want is empty, the command produced nothing on stdout/stderr. If blocks are missing entirely, `PS0` is not being emitted — verify with:

```bash
declare -p PS0
```

It should contain `\037`.

**Compile errors.**

- `pty.h: No such file` — you're not on glibc. On Alpine (musl) you need `#include <utmp.h>` differently or install `libc-dev`.
- `undefined reference to forkpty` — add `-lutil`.
- `implicit declaration of readlink` — move `#define _GNU_SOURCE` to the very first line, before all `#include`s.

**Terminal is left in a broken state after exit.**

`tcsetattr` on exit failed, usually because the process was killed with `SIGKILL` (which cannot be caught). Restore manually:

```bash
stty sane
```

If it happens often, install a handler for `SIGTERM` that runs the same cleanup as normal exit.

**Double characters when typing.**

`cwdsync` failed to enter raw mode. Check with `stty -a` inside the shell — if it shows `icanon` and `echo`, raw mode wasn't installed. Ensure you're not running `cwdsync` from inside another wrapper.

---

# Summary of commands you'll use

| Command | What it does |
|---|---|
| `x` | Copy last command's output to clipboard |
| `x N` | Copy the N-th most recent command's output |
| `xl` | List all blocks with index numbers |
| `xc` | Count blocks in the current session |
| `xf [dir]` | Dump all blocks as numbered files (default `/tmp/xblocks`) |
| `xb` | Print every OSC 133 block with exit code (if enabled) |
| `echo "$X_LOG"` | Show the current session's log path |
| `echo "$X_INNER"` | Confirm you're inside the logged shell |

That's the whole setup. Once it's in place you don't touch it again: new terminals log automatically, `Ctrl+Shift+Enter` tracks directories correctly, and `x` gives you the last command's output whenever you need it.
