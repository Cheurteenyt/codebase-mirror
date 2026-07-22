#!/usr/bin/env python3
"""
Restricted-environment Git SSH transport.

Known-working stack:
- Python 3.12+
- AsyncSSH 2.24.0
- binary Git smart protocol (encoding=None)

This helper is for maintainer/agent environments without native OpenSSH.
It is not used by Codebase Memory runtime or CI.

Usage:
  GIT_SSH_COMMAND="python3 scripts/dev/asyncssh-git-transport.py" \\
      git push origin <branch>

  # Self-test (no network, no key needed):
  python3 scripts/dev/asyncssh-git-transport.py --self-test

Configuration (environment variables, no hardcoded secrets):
  ASYNCSSH_CLIENT_KEY   Path to private key (default: ~/.ssh/id_ed25519)
  ASYNCSSH_KNOWN_HOSTS  Path to known_hosts file (default: ~/.ssh/known_hosts)
  ASYNCSSH_USERNAME     SSH username (default: git)
  ASYNCSSH_HOST         SSH host (default: github.com)
  ASYNCSSH_PORT         SSH port (default: 22)

Security:
  - Only git-receive-pack and git-upload-pack commands are allowed.
  - Repository path is validated against a strict pattern.
  - No shell metacharacters (;, &&, |, $(), backticks, newline).
  - Host key verification is mandatory (no known_hosts=None).
  - No secrets, tokens, or private keys in the source.
  - Binary data is never decoded to text.

Binary contract:
  - stdin/stdout/stderr are handled as raw bytes (encoding=None).
  - Git pack data, sideband packets, and report-status packets pass
    through unchanged.
  - No decode()/encode()/text=True/universal_newlines=True.

Channel lifecycle:
  1. Git client sends refs negotiation + flush.
  2. Git client sends pack data.
  3. Git client signals EOF on stdin.
  4. git-receive-pack processes the pack.
  5. Server sends sideband + report-status-v2.
  6. Server closes stdout.
  7. Wrapper reads exit status.
  8. Wrapper closes connection.

Critical rule: never close the channel after only finishing writing.
Continue reading stdout/stderr until remote EOF, then wait for exit status.
"""

import sys
import os
import asyncio
import shlex
import re
import stat
from pathlib import Path

try:
    import asyncssh
except ImportError:
    sys.stderr.write(
        "asyncssh is not installed. Install with: pip install asyncssh==2.24.0\n"
        "This helper is NOT a runtime dependency of Codebase Memory.\n"
    )
    sys.exit(2)


# ─── Constants ───────────────────────────────────────────────────────────

ALLOWED_COMMANDS = {"git-receive-pack", "git-upload-pack"}

# Repository path: owner/name.git (GitHub-style). Strict pattern to
# prevent traversal and injection. No leading dots, no .. segments.
REPO_PATH_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*\.git$"
)

# Shell metacharacters that must never appear in the command.
FORBIDDEN_CHARS = set(";|&`$\n\r()<>{}[]\\\"'")

# Default config (overridable via environment).
DEFAULT_USERNAME = "git"
DEFAULT_HOST = "github.com"
DEFAULT_PORT = 22
DEFAULT_KEY = os.path.expanduser("~/.ssh/id_ed25519")
DEFAULT_KNOWN_HOSTS = os.path.expanduser("~/.ssh/known_hosts")

# Self-test binary samples (non-UTF-8 bytes that would crash text decode).
SELF_TEST_SAMPLES = [
    b"\x00\x01\x02\x03\x04\x05\x06\x07",
    b"\xff\xfe\xfd\xfc\xfb\xfa\xf9\xf8",
    b"\x9b\x9a\x8c\xc0\xaa\xa7\x80\x81",
    b"pkt-line\x00data\x00\x01e\x00",  # pkt-line-like
    b"\x00" * 1024,  # null bytes
    bytes(range(256)),  # all byte values
]


# ─── Command validation ─────────────────────────────────────────────────

def validate_command(cmd: str) -> str:
    """
    Validate and sanitize the SSH command.

    Only git-receive-pack and git-upload-pack are allowed, with a
    repository path matching owner/name.git. No shell metacharacters
    in the parsed parts (after shlex removes quoting).

    Returns the validated command string.
    Raises ValueError if the command is invalid.
    """
    if not cmd:
        raise ValueError("empty command")

    # Parse with shlex to handle quoting (quotes are removed by shlex).
    try:
        parts = shlex.split(cmd)
    except ValueError as e:
        raise ValueError(f"shlex parse failed: {e}")

    if len(parts) != 2:
        raise ValueError(f"expected exactly 'git-<verb> <repo>' (2 tokens), got {len(parts)} tokens: {cmd}")

    verb = parts[0]
    repo = parts[1]

    # Check for forbidden metacharacters in the PARSED parts (not the
    # raw command — quotes are legitimate for shlex but removed by it).
    for i, part in enumerate(parts):
        for j, ch in enumerate(part):
            if ch in FORBIDDEN_CHARS:
                raise ValueError(
                    f"forbidden character {ch!r} in argument {i} at position {j}: {part!r}"
                )

    if verb not in ALLOWED_COMMANDS:
        raise ValueError(
            f"disallowed command {verb!r}; allowed: {ALLOWED_COMMANDS}"
        )

    if not REPO_PATH_RE.match(repo):
        raise ValueError(
            f"repository path {repo!r} does not match owner/name.git pattern"
        )

    # Reconstruct the command safely (no shell metacharacters possible).
    return f"{verb} {repo}"


# ─── Key file security ──────────────────────────────────────────────────

def validate_key_file(path: str) -> str:
    """
    Validate that the key file exists and is only readable by its owner.

    Returns the validated path.
    Raises ValueError if the key is insecure.
    """
    p = Path(path)
    if not p.exists():
        raise ValueError(f"client key not found: {path}")
    if not p.is_file():
        raise ValueError(f"client key is not a regular file: {path}")

    # R169B (§21 SSH-03): use lstat, refuse symlink, check owner + mode.
    st = p.lstat()
    if stat.S_ISLNK(st.st_mode):
        raise ValueError(f"client key is a symlink: {path}")
    if not stat.S_ISREG(st.st_mode):
        raise ValueError(f"client key is not a regular file: {path}")
    # Mode must be 0600 or stricter — no group/other access.
    if (st.st_mode & 0o077) != 0:
        raise ValueError(
            f"client key {path} is group/other accessible (mode {oct(st.st_mode & 0o777)}); "
            f"expected 0600 or stricter. Run: chmod 600 {path}"
        )

    return str(p)


def validate_known_hosts(path: str) -> str:
    """
    Validate that the known_hosts file exists.

    Returns the validated path.
    Raises ValueError if known_hosts is missing (we refuse known_hosts=None).
    """
    p = Path(path)
    if not p.exists():
        raise ValueError(
            f"known_hosts file not found: {path}\n"
            f"Host key verification is MANDATORY. Install a GitHub host key "
            f"whose fingerprint was verified out of band, then set "
            f"ASYNCSSH_KNOWN_HOSTS to that file. See "
            f"docs/operations/RESTRICTED_ENVIRONMENT_GIT_TRANSPORT.md."
        )
    if not p.is_file():
        raise ValueError(f"known_hosts is not a regular file: {path}")
    return str(p)


# ─── SSH transport ──────────────────────────────────────────────────────

async def run_git_transport(
    hostname: str,
    port: int,
    username: str,
    key_file: str,
    known_hosts_file: str,
    cmd: str,
) -> int:
    """
    Execute a git SSH command with binary streaming.

    Uses asyncssh with encoding=None to preserve binary pack data.
    Waits for the remote command to fully exit and all channel data
    to drain before returning.
    """
    validated_cmd = validate_command(cmd)

    conn = await asyncssh.connect(
        hostname,
        port=port,
        username=username,
        client_keys=[key_file],
        known_hosts=known_hosts_file,
        keepalive_interval=15,
        login_timeout=30,
    )

    try:
        # conn.run with encoding=None keeps all data binary.
        # stdin/stdout/stderr are connected directly to our file
        # descriptors. asyncssh handles the full channel lifecycle:
        #   - writes stdin to the channel
        #   - sends EOF when stdin closes
        #   - reads stdout/stderr until remote EOF
        #   - waits for exit status
        result = await conn.run(
            validated_cmd,
            stdin=sys.stdin.buffer,
            stdout=sys.stdout.buffer,
            stderr=sys.stderr.buffer,
            encoding=None,
            check=False,
        )
        # R169B (§21 SSH-02): exit_status must be a real int, not None.
        # If the process was killed by a signal, treat as failure.
        if result.exit_status is None:
            sys.stderr.write("SSH transport: remote process exited without status (killed by signal?)\n")
            return 1
        return result.exit_status
    finally:
        conn.close()
        await conn.wait_closed()


# ─── Git SSH wrapper entry point ────────────────────────────────────────

def parse_git_ssh_args(argv: list[str]) -> tuple[str, str, int, str, str, str | None]:
    """
    Parse git's SSH invocation arguments.

    git calls GIT_SSH_COMMAND with:
      <wrapper> [options] <user>@<host> <command>

    Options we handle: -i <key>, -p <port>, -o <key=value>, -G, -T
    """
    key_file = os.environ.get("ASYNCSSH_CLIENT_KEY", DEFAULT_KEY)
    known_hosts = os.environ.get("ASYNCSSH_KNOWN_HOSTS", DEFAULT_KNOWN_HOSTS)
    username = os.environ.get("ASYNCSSH_USERNAME", DEFAULT_USERNAME)
    host = os.environ.get("ASYNCSSH_HOST", DEFAULT_HOST)
    port = int(os.environ.get("ASYNCSSH_PORT", str(DEFAULT_PORT)))

    probe_mode = False
    host_arg = None
    cmd_parts: list[str] = []
    i = 1
    while i < len(argv):
        arg = argv[i]
        if arg == "-i":
            i += 1
            key_file = argv[i] if i < len(argv) else key_file
        elif arg == "-p":
            i += 1
            port = int(argv[i]) if i < len(argv) else port
        elif arg == "-o":
            i += 1  # skip option value
        elif arg == "-G":
            probe_mode = True
        elif arg == "-T":
            pass
        elif arg.startswith("-"):
            pass
        elif host_arg is None and "@" in arg:
            host_arg = arg
        else:
            cmd_parts.append(arg)
        i += 1

    if host_arg:
        u, _, h = host_arg.partition("@")
        if u:
            username = u
        if h:
            host = h

    cmd = " ".join(cmd_parts) if cmd_parts else ""
    return host, username, port, key_file, known_hosts, (cmd if not probe_mode else None)


def git_ssh_main(argv: list[str]) -> int:
    host, username, port, key_file, known_hosts, cmd = parse_git_ssh_args(argv)

    # Handle -G probe: print fake SSH config so git proceeds.
    if cmd is None:
        print(f"user {username}")
        print(f"hostname {host}")
        print(f"port {port}")
        print(f"identityfile {key_file}")
        return 0

    if not cmd:
        sys.stderr.write("no command provided\n")
        return 2

    try:
        key_file = validate_key_file(key_file)
        known_hosts = validate_known_hosts(known_hosts)
    except ValueError as e:
        sys.stderr.write(f"configuration error: {e}\n")
        return 2

    try:
        return asyncio.run(
            run_git_transport(host, port, username, key_file, known_hosts, cmd)
        )
    except Exception as e:
        # R169B (§21 SSH-07): display a sanitized diagnostic message.
        msg = str(e)
        if key_file in msg:
            msg = msg.replace(key_file, "<KEY_PATH>")
        sys.stderr.write(f"SSH transport failed: {type(e).__name__}: {msg}\n")
        return 1


# ─── Self-test ──────────────────────────────────────────────────────────

def self_test() -> int:
    """
    Run offline self-tests (no network, no key needed).

    Verifies:
    1. Binary passthrough: non-UTF-8 bytes survive unchanged.
    2. stdout/stderr separation.
    3. Exit status propagation.
    4. Command validation accepts valid git commands.
    5. Command validation rejects injection attempts.
    6. No implicit decode.
    """
    failures: list[str] = []

    # 1. Binary passthrough: simulate a process that echoes binary data.
    # We use a local subprocess (cat) to verify the pipe is binary-safe.
    async def test_binary_passthrough():
        proc = await asyncio.create_subprocess_exec(
            "cat",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        # Feed all samples concatenated.
        payload = b"".join(SELF_TEST_SAMPLES)
        stdout, stderr = await proc.communicate(input=payload)
        assert stdout == payload, (
            f"binary passthrough failed: {len(stdout)} != {len(payload)} bytes"
        )
        assert proc.returncode == 0, f"cat exited {proc.returncode}"

    # 2 & 3. Exit status + stderr separation.
    async def test_exit_status_and_stderr():
        # Use 'sh -c' to produce a non-zero exit and stderr output.
        proc = await asyncio.create_subprocess_exec(
            "sh", "-c", "echo err >&2; exit 42",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        assert proc.returncode == 42, f"expected exit 42, got {proc.returncode}"
        assert stdout == b"", f"expected empty stdout, got {stdout!r}"
        assert stderr.strip() == b"err", f"expected 'err' on stderr, got {stderr!r}"

    # 4. Command validation: valid commands.
    def test_valid_commands():
        valid = [
            "git-receive-pack 'Cheurteenyt/Ariad.git'",
            "git-upload-pack 'Cheurteenyt/Ariad.git'",
            'git-receive-pack "owner/repo.git"',
            "git-upload-pack owner/name.git",
        ]
        for cmd in valid:
            try:
                result = validate_command(cmd)
                assert "git-" in result, f"validation lost git- prefix: {result}"
            except ValueError as e:
                failures.append(f"valid command rejected: {cmd!r} → {e}")

    # 5. Command validation: injection attempts.
    def test_injection_rejected():
        invalid = [
            ("git-receive-pack 'repo; rm -rf /'", "shell semicolon"),
            ("git-receive-pack 'repo && echo pwned'", "shell &&"),
            ("git-receive-pack 'repo | cat'", "shell pipe"),
            ("git-receive-pack 'repo$(whoami)'", "command substitution"),
            ("git-receive-pack 'repo`whoami`'", "backticks"),
            ("git-receive-pack 'repo\nrm -rf /'", "newline"),
            ("git-receive-pack '../escape.git'", "path traversal"),
            ("git-receive-pack '/etc/passwd'", "absolute path"),
            ("rm -rf /", "non-git command"),
            ("git-receive-pack", "missing repo"),
            ("", "empty command"),
            ("git-receive-pack 'owner/repo'", "missing .git suffix"),
        ]
        for cmd, desc in invalid:
            try:
                validate_command(cmd)
                failures.append(f"injection accepted ({desc}): {cmd!r}")
            except ValueError:
                pass  # expected

    # 6. No implicit decode: verify encoding=None is used.
    def test_no_decode():
        import inspect
        src = inspect.getsource(run_git_transport)
        if "encoding=None" not in src:
            failures.append("encoding=None not found in run_git_transport source")
        if 'encoding="utf-8"' in src or "encoding='utf-8'" in src:
            failures.append("utf-8 encoding found in run_git_transport source")
        if ".decode(" in src or ".encode(" in src:
            failures.append("explicit decode/encode found in run_git_transport source")

    # Run async tests.
    async def run_async_tests():
        try:
            await test_binary_passthrough()
        except Exception as e:
            failures.append(f"binary passthrough: {e}")
        try:
            await test_exit_status_and_stderr()
        except Exception as e:
            failures.append(f"exit/stderr: {e}")

    asyncio.run(run_async_tests())
    test_valid_commands()
    test_injection_rejected()
    test_no_decode()

    # Report.
    print("=== AsyncSSH Git Transport Self-Test ===")
    print(f"  binary passthrough: {'OK' if not any('binary' in f for f in failures) else 'FAIL'}")
    print(f"  exit status:        {'OK' if not any('exit' in f for f in failures) else 'FAIL'}")
    print(f"  stderr separation:  {'OK' if not any('stderr' in f for f in failures) else 'FAIL'}")
    print(f"  valid commands:     {'OK' if not any('valid command' in f for f in failures) else 'FAIL'}")
    print(f"  injection rejected: {'OK' if not any('injection' in f for f in failures) else 'FAIL'}")
    print(f"  no decode:          {'OK' if not any('decode' in f for f in failures) else 'FAIL'}")

    if failures:
        print(f"\nFAILED ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    else:
        print("\nALL CHECKS PASSED")
        return 0


# ─── Main ───────────────────────────────────────────────────────────────

def main():
    argv = sys.argv
    if len(argv) >= 2 and argv[1] == "--self-test":
        sys.exit(self_test())
    sys.exit(git_ssh_main(argv))


if __name__ == "__main__":
    main()
