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
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

static volatile sig_atomic_t got_winch = 0;
static volatile sig_atomic_t got_signal = 0;

static void on_winch(int sig)
{
    (void)sig;
    got_winch = 1;
}

static void on_signal(int sig)
{
    (void)sig;
    got_signal = 1;
}

/*
 * Write exactly len bytes unless an error occurs.
 */
static int write_all(int fd, const void *buf, size_t len)
{
    const char *p = buf;

    while (len > 0) {
        ssize_t n = write(fd, p, len);

        if (n > 0) {
            p += n;
            len -= (size_t)n;
            continue;
        }

        if (n < 0 && errno == EINTR)
            continue;

        return -1;
    }

    return 0;
}

/*
 * Copy the terminal size from the real terminal to the child PTY.
 */
static void sync_winsize(int master)
{
    struct winsize ws;

    memset(&ws, 0, sizeof(ws));

    if (ioctl(STDIN_FILENO, TIOCGWINSZ, &ws) == -1)
        return;

    (void)ioctl(master, TIOCSWINSZ, &ws);
}

static void restore_terminal(const struct termios *orig, int have_orig)
{
    if (have_orig)
        tcsetattr(STDIN_FILENO, TCSANOW, orig);
}

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(
            stderr,
            "usage: %s LOGFILE CMD [ARGS...]\n",
            argv[0]
        );
        return 2;
    }

    const char *logpath = argv[1];

    /*
     * Get the size of the real terminal before creating the child PTY.
     */
    struct winsize ws;

    memset(&ws, 0, sizeof(ws));

    if (ioctl(STDIN_FILENO, TIOCGWINSZ, &ws) == -1) {
        memset(&ws, 0, sizeof(ws));
    }

    /*
     * Create PTY and child process.
     *
     * Child:
     *     becomes session leader
     *     gets slave PTY as controlling terminal
     *     executes requested command
     */
    int master = -1;

    pid_t pid = forkpty(
        &master,
        NULL,
        NULL,
        &ws
    );

    if (pid < 0) {
        perror("forkpty");
        return 1;
    }

    if (pid == 0) {
        execvp(argv[2], &argv[2]);

        perror("execvp");
        _exit(127);
    }

    /*
     * Open command-output log.
     */
    FILE *log = fopen(logpath, "ab");

    if (!log) {
        perror("fopen");

        /*
         * Don't leave the child running.
         */
        kill(pid, SIGHUP);
        close(master);
        waitpid(pid, NULL, 0);

        return 1;
    }

    /*
     * Disable stdio buffering so output reaches the log immediately.
     */
    setvbuf(log, NULL, _IONBF, 0);

    /*
     * Save the user's terminal state.
     */
    struct termios orig;
    int have_orig = 0;

    if (tcgetattr(STDIN_FILENO, &orig) == 0) {
        have_orig = 1;

        struct termios raw = orig;

        cfmakeraw(&raw);

        /*
         * Keep output processing on the real terminal.
         * Only input needs to be raw here.
         */
        tcsetattr(STDIN_FILENO, TCSANOW, &raw);
    }

    /*
     * Signal handlers.
     */
    struct sigaction sa;

    memset(&sa, 0, sizeof(sa));
    sigemptyset(&sa.sa_mask);

    sa.sa_handler = on_winch;
    sigaction(SIGWINCH, &sa, NULL);

    memset(&sa, 0, sizeof(sa));
    sigemptyset(&sa.sa_mask);

    sa.sa_handler = on_signal;

    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT,  &sa, NULL);
    sigaction(SIGHUP,  &sa, NULL);

    /*
     * Make sure the child PTY has the current terminal size.
     */
    sync_winsize(master);

    char buf[16384];

    int running = 1;

    while (running) {

        /*
         * Forward terminal resize.
         */
        if (got_winch) {
            got_winch = 0;
            sync_winsize(master);
        }

        /*
         * If we received a termination signal, tell the child.
         */
        if (got_signal) {
            got_signal = 0;

            /*
             * Sending SIGTERM to the child is enough for normal
             * shell shutdown. The child owns the PTY session.
             */
            kill(pid, SIGTERM);
        }

        fd_set readfds;

        FD_ZERO(&readfds);

        FD_SET(STDIN_FILENO, &readfds);
        FD_SET(master, &readfds);

        int maxfd =
            (STDIN_FILENO > master)
                ? STDIN_FILENO
                : master;

        struct timeval timeout;

        timeout.tv_sec = 0;
        timeout.tv_usec = 100000;

        int n = select(
            maxfd + 1,
            &readfds,
            NULL,
            NULL,
            &timeout
        );

        if (n < 0) {
            if (errno == EINTR)
                continue;

            break;
        }

        /*
         * User → child PTY
         */
        if (FD_ISSET(STDIN_FILENO, &readfds)) {

            ssize_t r = read(
                STDIN_FILENO,
                buf,
                sizeof(buf)
            );

            if (r > 0) {
                if (write_all(master, buf, (size_t)r) < 0) {
                    if (errno != EINTR)
                        running = 0;
                }
            }
            else if (r == 0) {
                /*
                 * Terminal input closed.
                 */
                break;
            }
            else if (errno != EINTR) {
                running = 0;
            }
        }

        /*
         * Child PTY → terminal + log
         */
        if (FD_ISSET(master, &readfds)) {

            ssize_t r = read(
                master,
                buf,
                sizeof(buf)
            );

            if (r > 0) {

                /*
                 * Display exactly what the child produced.
                 */
                if (write_all(
                        STDOUT_FILENO,
                        buf,
                        (size_t)r
                    ) < 0) {

                    running = 0;
                }

                /*
                 * Record exactly what the child produced.
                 */
                if (running) {
                    fwrite(
                        buf,
                        1,
                        (size_t)r,
                        log
                    );
                    fflush(log);
                }
            }
            else if (r == 0) {
                /*
                 * PTY closed normally.
                 */
                running = 0;
            }
            else {

                /*
                 * Linux PTY masters commonly return EIO when
                 * the slave side closes.
                 */
                if (errno == EIO) {
                    running = 0;
                }
                else if (errno != EINTR) {
                    running = 0;
                }
            }
        }

        /*
         * Check whether the child has exited.
         *
         * WNOHANG prevents us from blocking while the PTY still
         * has output waiting to be read.
         */
        int status;

        pid_t result = waitpid(
            pid,
            &status,
            WNOHANG
        );

        if (result == pid) {
            /*
             * Child exited. There may still be a small amount
             * of PTY output available, so do one final drain.
             */
            for (;;) {
                ssize_t r = read(
                    master,
                    buf,
                    sizeof(buf)
                );

                if (r > 0) {

                    (void)write_all(
                        STDOUT_FILENO,
                        buf,
                        (size_t)r
                    );

                    fwrite(
                        buf,
                        1,
                        (size_t)r,
                        log
                    );
                }
                else {
                    break;
                }
            }

            running = 0;
        }
        else if (result < 0 && errno != EINTR) {
            running = 0;
        }
    }

    /*
     * Restore the terminal BEFORE returning to the parent shell.
     */
    restore_terminal(&orig, have_orig);

    fclose(log);
    close(master);

    /*
     * Reap the child if it hasn't already been reaped.
     */
    int status;

    pid_t result = waitpid(
        pid,
        &status,
        WNOHANG
    );

    if (result == 0) {
        /*
         * Give the shell a moment to terminate normally.
         */
        kill(pid, SIGHUP);

        waitpid(pid, &status, 0);
    }

    if (WIFEXITED(status))
        return WEXITSTATUS(status);

    if (WIFSIGNALED(status))
        return 128 + WTERMSIG(status);

    return 1;
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
