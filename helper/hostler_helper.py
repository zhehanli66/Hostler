#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hostler remote helper  (stdlib only, Python >= 3.6)

A tiny daemon that runs on the *execution* machine (server / workstation / Jetson)
and gives the Hostler control plane a stable handle on native coding agents.
It never proxies model traffic and never touches the agents' own config/auth.

Responsibilities
  * persistent PTY sessions (survive SSH disconnects / GUI close / laptop sleep)
  * session registry, scrollback ring buffers, on-disk logs
  * process tree attribution (child-subreaper: detached jobs stay attributed)
  * discovery + adoption of agent processes started outside the helper
  * CPU / RAM / GPU / VRAM monitoring (nvidia-smi, or Jetson sysfs)
  * activity introspection: Claude Code / Codex / OpenCode transcripts -> status,
    current tool, subagents, token usage

Transport: newline-delimited JSON over a unix socket (~/.hostler/helper.sock)
  request : {"id": 1, "op": "session.create", ...params}
  response: {"id": 1, "ok": true, "result": {...}} | {"id": 1, "ok": false, "error": "..."}
  event   : {"ev": "output", ...} | {"ev": "state", ...} | {"ev": "session.exit", ...}

CLI:  hostler_helper.py start | run | stop | status | version | ensure | relay
"""
from __future__ import print_function

import base64
import ctypes
import errno
import fcntl
import glob
import json
import os
import pty
import re
import select
import shlex
import signal
import socket
import struct
import subprocess
import sys
import termios
import threading
import time
import traceback
import uuid
from collections import OrderedDict, deque

VERSION = "0.1.4"
PROTOCOL = 1

AM_DIR = os.environ.get("HOSTLER_DIR") or os.path.join(os.path.expanduser("~"), ".hostler")
SOCK_PATH = os.path.join(AM_DIR, "helper.sock")
PID_PATH = os.path.join(AM_DIR, "helper.pid")
LOG_PATH = os.path.join(AM_DIR, "helper.log")
LOGS_DIR = os.path.join(AM_DIR, "logs")
REGISTRY_PATH = os.path.join(AM_DIR, "sessions.json")

SCROLLBACK_BYTES = 1 * 1024 * 1024      # in-memory ring buffer per session
LOGFILE_MAX_BYTES = 16 * 1024 * 1024    # on-disk log cap per session (truncated to half)
STATE_INTERVAL = 2.0                     # seconds between state snapshots
TRANSCRIPT_TAIL_START = 12 * 1024 * 1024 # if a transcript is bigger, start parsing near the end

def _self_sha():
    try:
        import hashlib
        with open(os.path.abspath(__file__), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except Exception:
        return None


SELF_SHA = _self_sha()   # identifies the exact helper build; used by `ensure` to apply upgrades
CLK_TCK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096
HELPER_PID = os.getpid()  # refreshed in serve_forever (after daemonize)


# --------------------------------------------------------------------------- utils

def log(msg, *args):
    try:
        line = "[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), (msg % args) if args else msg)
        sys.stderr.write(line)
        sys.stderr.flush()
    except Exception:
        pass


def b64e(b):
    return base64.b64encode(b).decode("ascii")


def b64d(s):
    return base64.b64decode(s)


def shlex_join(argv):
    return " ".join(shlex.quote(a) for a in argv)


def read_file(path, default=None, binary=False):
    try:
        with open(path, "rb") as f:
            data = f.read()
        return data if binary else data.decode("utf-8", "replace")
    except Exception:
        return default


def which(cmd):
    for d in os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin").split(os.pathsep):
        p = os.path.join(d, cmd)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    # also look into common user locations (login shell PATH may differ from daemon PATH)
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".local", "bin", cmd),
        os.path.join(home, ".npm-global", "bin", cmd),
        os.path.join(home, "bin", cmd),
        os.path.join(home, ".cargo", "bin", cmd),
        os.path.join(home, ".opencode", "bin", cmd),
        os.path.join(home, ".claude", "local", cmd),
        "/usr/local/bin/" + cmd, "/opt/homebrew/bin/" + cmd, "/snap/bin/" + cmd,
    ]
    for pattern in [os.path.join(home, ".nvm", "versions", "node", "*", "bin", cmd),
                    os.path.join(home, ".volta", "bin", cmd),
                    os.path.join(home, ".fnm", "node-versions", "*", "installation", "bin", cmd)]:
        candidates.extend(sorted(glob.glob(pattern), reverse=True))
    for p in candidates:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return bundled_agent_bin(cmd)


# Agent CLIs that ship *inside* an IDE extension instead of on PATH: someone who only ever
# used Claude Code / Codex through the VS Code (or Cursor / Windsurf) extension has a perfectly
# good binary on the machine, just not one `command -v` can see.
IDE_EXT_DIRS = ["~/.vscode/extensions", "~/.vscode-insiders/extensions", "~/.vscode-server/extensions",
                "~/.vscode-server-insiders/extensions", "~/.vscodium/extensions", "~/.cursor/extensions",
                "~/.cursor-server/extensions", "~/.windsurf/extensions", "~/.windsurf-server/extensions"]
BUNDLED_AGENTS = {
    "claude": ["anthropic.claude-code-*/resources/native-binary/claude", "anthropic.claude-code-*/resources/native/claude",
               "anthropic.claude-code-*/resources/claude", "anthropic.claude-code-*/bin/claude"],
    "codex": ["openai.chatgpt-*/bin/*/codex", "openai.chatgpt-*/binaries/*/codex", "openai.chatgpt-*/bin/codex"],
    "opencode": ["*opencode*/bin/*/opencode", "*opencode*/bin/opencode"],
}


def bundled_agent_bin(cmd):
    """Newest IDE-bundled build of an agent CLI, or None."""
    hits = []
    for d in IDE_EXT_DIRS:
        base = os.path.expanduser(d)
        for pat in BUNDLED_AGENTS.get(cmd, []):
            for p in glob.glob(os.path.join(base, pat)):
                if os.path.isfile(p) and os.access(p, os.X_OK):
                    try:
                        hits.append((os.stat(p).st_mtime, p))
                    except OSError:
                        pass
    hits.sort(reverse=True)            # the extension the IDE updated last
    return hits[0][1] if hits else None


AGENT_BINS = {}


def agent_binary(kind):
    """How to invoke an agent: its plain name is useless when the CLI only exists inside an
    IDE extension, so launch whatever `which()` (PATH, user dirs, login shell, IDE) resolved."""
    p = AGENT_BINS.get(kind)
    if not p or not os.path.exists(p):
        p = which(kind)
        AGENT_BINS[kind] = p
    return shlex.quote(p) if p else kind


def run_cmd(argv, timeout=5, cwd=None):
    try:
        p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd)
        try:
            out, err = p.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            p.kill()
            out, err = p.communicate()
        return p.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")
    except Exception as e:
        return -1, "", str(e)


def set_child_subreaper():
    """Make this process the reaper for orphaned descendants (Linux only)."""
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        PR_SET_CHILD_SUBREAPER = 36
        return libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0
    except Exception:
        return False


def boot_time():
    for line in (read_file("/proc/stat") or "").splitlines():
        if line.startswith("btime "):
            return int(line.split()[1])
    return int(time.time() - float((read_file("/proc/uptime") or "0").split()[0]))


BOOT_TIME = boot_time()


def encode_claude_project(cwd):
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def truncate(s, n):
    if s is None:
        return None
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


# --------------------------------------------------------------------------- /proc scanning

class ProcInfo(object):
    __slots__ = ("pid", "ppid", "comm", "state", "utime", "stime", "starttime", "rss", "tty", "cmdline", "uid", "cpu", "gpu_mem")

    def __init__(self):
        self.cmdline = None
        self.uid = None
        self.cpu = 0.0
        self.gpu_mem = None

    def start_epoch(self):
        return BOOT_TIME + self.starttime / float(CLK_TCK)


def read_proc(pid):
    try:
        with open("/proc/%d/stat" % pid, "rb") as f:
            data = f.read().decode("utf-8", "replace")
    except Exception:
        return None
    l = data.find("(")
    r = data.rfind(")")
    if l < 0 or r < 0:
        return None
    p = ProcInfo()
    p.pid = pid
    p.comm = data[l + 1:r]
    rest = data[r + 2:].split()
    try:
        p.state = rest[0]
        p.ppid = int(rest[1])
        tty_nr = int(rest[4])
        p.utime = int(rest[11])
        p.stime = int(rest[12])
        p.starttime = int(rest[19])
        p.rss = int(rest[21]) * PAGE_SIZE
    except (IndexError, ValueError):
        return None
    if tty_nr:
        major = (tty_nr >> 8) & 0xFF
        minor = (tty_nr & 0xFF) | ((tty_nr >> 12) & 0xFFF00)
        p.tty = "/dev/pts/%d" % minor if major == 136 else ("/dev/tty%d" % minor if major == 4 else None)
    else:
        p.tty = None
    return p


def proc_cmdline(pid):
    raw = read_file("/proc/%d/cmdline" % pid, b"", binary=True)
    if not raw:
        return []
    return [a.decode("utf-8", "replace") for a in raw.split(b"\0") if a]


def proc_cwd(pid):
    try:
        return os.readlink("/proc/%d/cwd" % pid)
    except Exception:
        return None


def proc_uid(pid):
    try:
        return os.stat("/proc/%d" % pid).st_uid
    except Exception:
        return None


def proc_env(pid):
    raw = read_file("/proc/%d/environ" % pid, b"", binary=True)
    env = {}
    for item in raw.split(b"\0"):
        if b"=" in item:
            k, v = item.split(b"=", 1)
            env[k.decode("utf-8", "replace")] = v.decode("utf-8", "replace")
    return env


def scan_procs():
    procs = {}
    try:
        names = os.listdir("/proc")
    except Exception:
        return procs
    for name in names:
        if not name.isdigit():
            continue
        p = read_proc(int(name))
        if p is not None:
            procs[p.pid] = p
    return procs


AGENT_PATTERNS = [
    ("claude", re.compile(r"(^|/)claude(\.js|\.mjs|/cli\.js)?$|@anthropic-ai/claude-code|claude-code/cli\.js|\.claude/local/")),
    ("codex", re.compile(r"(^|/)codex(-[a-z0-9_]+-unknown-linux-[a-z]+|-x86_64-apple-darwin|-aarch64-apple-darwin)?$|@openai/codex")),
    ("opencode", re.compile(r"(^|/)opencode(-linux-[a-z0-9]+)?$|opencode-ai/")),
]
AGENT_NOISE = re.compile(r"(^|\s)(app-server|mcp-server|mcp serve|--print|-p\b|completion|login|logout|--version|-v$|doctor|update|install)")


def classify_agent(cmdline):
    """Return (agent_type, subcommand) for an agent process cmdline, or (None, None)."""
    if not cmdline:
        return None, None
    argv = list(cmdline)
    # skip interpreters
    while argv and (os.path.basename(argv[0]) in ("node", "nodejs", "bun", "deno", "python", "python3", "sh", "bash", "zsh", "env") or argv[0].startswith("-")):
        argv.pop(0)
    if not argv:
        return None, None
    head = argv[0]
    for kind, rx in AGENT_PATTERNS:
        if rx.search(head):
            rest = " ".join(argv[1:])
            return kind, rest
    return None, None


# --------------------------------------------------------------------------- resources

class ResourceMonitor(object):
    def __init__(self):
        self.prev_cpu = None
        self.prev_t = None
        self.cpu_pct = 0.0
        self.nvidia_smi = which("nvidia-smi")
        self.jetson = os.path.exists("/etc/nv_tegra_release") or os.path.isdir("/sys/devices/gpu.0")
        self.jetson_gpu_load = None
        for pattern in ["/sys/devices/gpu.0/load", "/sys/devices/platform/*gpu*/load", "/sys/devices/platform/host1x/*gpu*/load",
                        "/sys/class/devfreq/*gpu*/device/load"]:
            hits = glob.glob(pattern)
            if hits:
                self.jetson_gpu_load = hits[0]
                break
        self.last_gpu = []
        self.last_gpu_t = 0
        self.gpu_procs = {}
        self.cores = os.cpu_count() or 1
        self.hostname = socket.gethostname()
        self.prev_procs = {}
        self.prev_procs_t = None

    def _cpu_total(self):
        line = (read_file("/proc/stat") or "").splitlines()[0]
        parts = [int(x) for x in line.split()[1:]]
        idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
        return sum(parts), idle

    def sample_system(self):
        total, idle = self._cpu_total()
        if self.prev_cpu:
            dt = total - self.prev_cpu[0]
            di = idle - self.prev_cpu[1]
            if dt > 0:
                self.cpu_pct = max(0.0, min(100.0, 100.0 * (dt - di) / dt))
        self.prev_cpu = (total, idle)
        mem = {}
        for line in (read_file("/proc/meminfo") or "").splitlines():
            k, _, v = line.partition(":")
            v = v.strip().split()
            if v:
                mem[k] = int(v[0]) * 1024
        total_mem = mem.get("MemTotal", 0)
        avail = mem.get("MemAvailable", mem.get("MemFree", 0))
        try:
            load1, load5, load15 = os.getloadavg()
        except Exception:
            load1 = load5 = load15 = 0.0
        disk = None
        try:
            st = os.statvfs(os.path.expanduser("~"))
            disk = {"path": os.path.expanduser("~"), "total": st.f_blocks * st.f_frsize, "free": st.f_bavail * st.f_frsize}
        except Exception:
            pass
        uptime = 0.0
        try:
            uptime = float((read_file("/proc/uptime") or "0").split()[0])
        except Exception:
            pass
        return {
            "cpu_pct": round(self.cpu_pct, 1),
            "cores": self.cores,
            "load": [round(load1, 2), round(load5, 2), round(load15, 2)],
            "mem_total": total_mem,
            "mem_used": max(0, total_mem - avail),
            "mem_available": avail,
            "swap_total": mem.get("SwapTotal", 0),
            "swap_used": max(0, mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)),
            "disk": disk,
            "uptime": uptime,
            "gpus": self.sample_gpus(),
            "gpu_kind": "nvidia" if self.nvidia_smi else ("jetson" if self.jetson else None),
        }

    def sample_gpus(self):
        now = time.time()
        if now - self.last_gpu_t < 1.5:
            return self.last_gpu
        self.last_gpu_t = now
        gpus = []
        if self.nvidia_smi:
            rc, out, _ = run_cmd([self.nvidia_smi, "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
                                  "--format=csv,noheader,nounits"], timeout=4)
            if rc == 0:
                for line in out.strip().splitlines():
                    f = [x.strip() for x in line.split(",")]
                    if len(f) < 5:
                        continue

                    def num(x):
                        try:
                            return float(x)
                        except Exception:
                            return None
                    gpus.append({"index": int(num(f[0]) or 0), "name": f[1], "util": num(f[2]),
                                 "mem_used": (num(f[3]) or 0) * 1024 * 1024, "mem_total": (num(f[4]) or 0) * 1024 * 1024,
                                 "temp": num(f[5]) if len(f) > 5 else None, "power": num(f[6]) if len(f) > 6 else None})
                rc, out, _ = run_cmd([self.nvidia_smi, "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], timeout=4)
                gp = {}
                if rc == 0:
                    for line in out.strip().splitlines():
                        f = [x.strip() for x in line.split(",")]
                        try:
                            gp[int(f[0])] = int(float(f[1])) * 1024 * 1024
                        except Exception:
                            pass
                self.gpu_procs = gp
        elif self.jetson:
            util = None
            if self.jetson_gpu_load:
                try:
                    util = int(read_file(self.jetson_gpu_load, "0").strip()) / 10.0
                except Exception:
                    util = None
            name = "Tegra GPU"
            model = read_file("/proc/device-tree/model") or read_file("/sys/firmware/devicetree/base/model")
            if model:
                name = model.strip("\0\n ")
            mem = {}
            for line in (read_file("/proc/meminfo") or "").splitlines():
                k, _, v = line.partition(":")
                v = v.strip().split()
                if v:
                    mem[k] = int(v[0]) * 1024
            gpus.append({"index": 0, "name": name, "util": util, "shared": True,
                         "mem_used": max(0, mem.get("MemTotal", 0) - mem.get("MemAvailable", 0)), "mem_total": mem.get("MemTotal", 0),
                         "temp": self._jetson_temp(), "power": None})
        self.last_gpu = gpus
        return gpus

    def _jetson_temp(self):
        for z in glob.glob("/sys/devices/virtual/thermal/thermal_zone*/type"):
            try:
                if "GPU" in read_file(z, "").upper():
                    return int(read_file(os.path.join(os.path.dirname(z), "temp"), "0").strip()) / 1000.0
            except Exception:
                pass
        return None

    def per_process_cpu(self, procs):
        """Fill p.cpu (percent of one core) using the previous scan."""
        now = time.time()
        if self.prev_procs_t:
            dt = now - self.prev_procs_t
            for pid, p in procs.items():
                prev = self.prev_procs.get(pid)
                if prev and prev[2] == p.starttime and dt > 0:
                    d = (p.utime + p.stime) - (prev[0] + prev[1])
                    p.cpu = round(100.0 * d / CLK_TCK / dt, 1)
        self.prev_procs = dict((pid, (p.utime, p.stime, p.starttime)) for pid, p in procs.items())
        self.prev_procs_t = now
        for pid, mem in self.gpu_procs.items():
            if pid in procs:
                procs[pid].gpu_mem = mem


# --------------------------------------------------------------------------- transcript tailing

class Tail(object):
    """Incrementally read JSON lines appended to a file."""

    def __init__(self, path):
        self.path = path
        self.off = 0
        self.partial = b""
        self.inode = None
        self.first = True

    def read(self, max_bytes=8 * 1024 * 1024):
        try:
            st = os.stat(self.path)
        except OSError:
            return []
        if self.inode is not None and st.st_ino != self.inode:
            self.off, self.partial = 0, b""
        self.inode = st.st_ino
        if st.st_size < self.off:
            self.off, self.partial = 0, b""
        if st.st_size == self.off:
            return []
        out = []
        try:
            with open(self.path, "rb") as f:
                if self.first and st.st_size > TRANSCRIPT_TAIL_START:
                    f.seek(st.st_size - TRANSCRIPT_TAIL_START)
                    f.readline()  # discard partial line
                else:
                    f.seek(self.off)
                data = f.read(max_bytes)
                self.off = f.tell()
        except OSError:
            return []
        self.first = False
        data = self.partial + data
        lines = data.split(b"\n")
        self.partial = lines.pop()
        for ln in lines:
            if not ln.strip():
                continue
            try:
                out.append(json.loads(ln.decode("utf-8", "replace")))
            except ValueError:
                continue
        return out


def summarize_tool_input(name, inp):
    if not isinstance(inp, dict):
        return truncate(inp, 120)
    for key in ("command", "cmd", "file_path", "path", "pattern", "query", "url", "description", "prompt", "notebook_path", "skill"):
        v = inp.get(key)
        if isinstance(v, list):
            v = " ".join(str(x) for x in v)
        if isinstance(v, str) and v.strip():
            return truncate(v.strip().replace("\n", " "), 140)
    for v in inp.values():
        if isinstance(v, str) and v.strip():
            return truncate(v.strip().replace("\n", " "), 140)
    return None


def block_text(block):
    c = block.get("content") if isinstance(block, dict) else block
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    return ""


class Conversation(object):
    """Normalized rolling state for one agent conversation (main or subagent)."""

    def __init__(self):
        self.pending = OrderedDict()   # tool_use_id -> {name, summary, ts}
        self.last_role = None          # 'user' | 'assistant' | 'tool_result'
        self.last_text = ""
        self.last_prompt = ""
        self.last_ts = None
        self.model = None
        self.usage = None
        self.title = None
        self.turns = 0
        self.tool_calls = 0
        self.busy = None               # explicit busy flag when the transcript provides one (codex)
        self.subagents = OrderedDict()  # key -> {desc, type, agent_id, ts, done}
        self.session_id = None

    def status(self):
        """Return (status, detail). status in: tool, thinking, subagents, idle, unknown"""
        if self.pending:
            non_agent = [p for p in self.pending.values() if p["name"] not in ("Agent", "Task")]
            if non_agent:
                p = non_agent[-1]
                return "tool", p
            return "subagents", None
        if self.busy is True:
            return "thinking", None
        if self.busy is False:
            return "idle", None
        if self.last_role in ("user", "tool_result"):
            return "thinking", None
        if self.last_role == "assistant":
            return "idle", None
        return "unknown", None

    def to_dict(self):
        st, detail = self.status()
        return {
            "status": st,
            "current_tool": detail,
            "pending_tools": [dict(v, id=k) for k, v in list(self.pending.items())[-8:]],
            "last_text": truncate(self.last_text, 400),
            "last_prompt": truncate(self.last_prompt, 200),
            "last_ts": self.last_ts,
            "model": self.model,
            "usage": self.usage,
            "title": self.title,
            "turns": self.turns,
            "tool_calls": self.tool_calls,
            "session_id": self.session_id,
        }


# ----- Claude Code

class ClaudeConversation(Conversation):
    def feed(self, o):
        t = o.get("type")
        if t == "ai-title":
            self.title = o.get("aiTitle") or self.title
            return
        if t not in ("assistant", "user"):
            return
        ts = o.get("timestamp")
        if ts:
            self.last_ts = ts
        m = o.get("message") or {}
        c = m.get("content")
        if t == "assistant":
            self.last_role = "assistant"
            self.model = m.get("model") or self.model
            u = m.get("usage")
            if isinstance(u, dict):
                self.usage = {"input": u.get("input_tokens"), "output": u.get("output_tokens"),
                              "cache_read": u.get("cache_read_input_tokens"), "cache_write": u.get("cache_creation_input_tokens")}
            if isinstance(c, list):
                for b in c:
                    if not isinstance(b, dict):
                        continue
                    bt = b.get("type")
                    if bt == "text" and (b.get("text") or "").strip():
                        self.last_text = b["text"].strip()
                    elif bt == "tool_use":
                        self.tool_calls += 1
                        name = b.get("name") or "?"
                        inp = b.get("input") or {}
                        self.pending[b.get("id")] = {"name": name, "summary": summarize_tool_input(name, inp), "ts": ts}
                        if name in ("Agent", "Task"):
                            self.subagents[b.get("id")] = {"desc": inp.get("description"), "type": inp.get("subagent_type") or "general-purpose",
                                                           "agent_id": None, "ts": ts, "done": False, "async": False}
            elif isinstance(c, str) and c.strip():
                self.last_text = c.strip()
        else:
            if isinstance(c, list):
                had_result = False
                for b in c:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "tool_result":
                        had_result = True
                        tid = b.get("tool_use_id")
                        self.pending.pop(tid, None)
                        if tid in self.subagents:
                            txt = block_text(b)
                            mm = re.search(r"agentId:\s*([0-9a-f]+)", txt)
                            if mm:
                                self.subagents[tid]["agent_id"] = mm.group(1)
                            if "Async agent launched" in txt or "background" in txt[:200]:
                                self.subagents[tid]["async"] = True
                            else:
                                self.subagents[tid]["done"] = True
                    elif b.get("type") == "text" and not o.get("isMeta"):
                        txt = b.get("text") or ""
                        if txt.strip() and not txt.startswith("<"):
                            self.last_prompt = txt.strip()
                            self.turns += 1
                if had_result:
                    self.last_role = "tool_result"
                elif not o.get("isMeta"):
                    self.last_role = "user"
            elif isinstance(c, str):
                if not o.get("isMeta"):
                    if not c.startswith("<"):
                        self.last_prompt = c.strip()
                        self.turns += 1
                    self.last_role = "user"


class ClaudeIntrospector(object):
    """Follows ~/.claude/projects/<cwd>/<session>.jsonl and its subagents."""

    def __init__(self, cwd, session_id=None, started=None):
        self.cwd = cwd
        self.session_id = session_id
        self.started = started or 0
        self.proj_dir = os.path.join(os.path.expanduser("~"), ".claude", "projects", encode_claude_project(cwd))
        self.path = None
        self.tail = None
        self.main = ClaudeConversation()
        self.sidechains = {}         # agentId -> ClaudeConversation (inline sidechains, older format)
        self.sub_tails = {}          # agent_id -> (Tail, ClaudeConversation, meta)
        self.last_locate = 0
        self.last_sub_scan = 0
        self.mtime = 0

    def locate(self):
        if self.path and os.path.exists(self.path):
            return True
        now = time.time()
        if now - self.last_locate < 5:
            return False
        self.last_locate = now
        if self.session_id:
            p = os.path.join(self.proj_dir, self.session_id + ".jsonl")
            if os.path.exists(p):
                self.path = p
        else:
            best = None
            for p in glob.glob(os.path.join(self.proj_dir, "*.jsonl")):
                try:
                    mt = os.stat(p).st_mtime
                except OSError:
                    continue
                if mt < self.started - 5:
                    continue
                if best is None or mt > best[0]:
                    best = (mt, p)
            if best:
                self.path = best[1]
                self.session_id = os.path.basename(best[1])[:-6]
        if self.path:
            self.tail = Tail(self.path)
            self.main.session_id = self.session_id
            return True
        return False

    def poll(self):
        if not self.locate():
            return
        for o in self.tail.read():
            if o.get("isSidechain") and o.get("agentId"):
                conv = self.sidechains.setdefault(o["agentId"], ClaudeConversation())
                conv.feed(o)
            else:
                self.main.feed(o)
        try:
            self.mtime = os.stat(self.path).st_mtime
        except OSError:
            pass
        now = time.time()
        if now - self.last_sub_scan > 3:
            self.last_sub_scan = now
            sub_dir = os.path.join(self.proj_dir, self.session_id or "", "subagents")
            for p in glob.glob(os.path.join(sub_dir, "agent-*.jsonl")):
                aid = os.path.basename(p)[6:-6]
                if aid not in self.sub_tails:
                    meta = {}
                    try:
                        meta = json.loads(read_file(p[:-6] + ".meta.json", "{}"))
                    except ValueError:
                        meta = {}
                    self.sub_tails[aid] = (Tail(p), ClaudeConversation(), meta)
        for aid, (tail, conv, meta) in self.sub_tails.items():
            for o in tail.read():
                conv.feed(o)

    def to_dict(self):
        d = self.main.to_dict()
        d["kind"] = "claude"
        d["transcript"] = self.path
        d["age"] = round(time.time() - self.mtime, 1) if self.mtime else None
        subs = []
        seen = set()
        # link tool_use spawned agents to transcript files
        by_tool = {}
        for aid, (tail, conv, meta) in self.sub_tails.items():
            if meta.get("toolUseId"):
                by_tool[meta["toolUseId"]] = aid
        for tid, s in self.main.subagents.items():
            aid = s.get("agent_id") or by_tool.get(tid)
            entry = {"id": aid or tid, "tool_use_id": tid, "type": s.get("type"), "description": s.get("desc"), "started": s.get("ts"),
                     "status": "completed" if s.get("done") else "running", "async": s.get("async")}
            conv = None
            if aid and aid in self.sub_tails:
                conv = self.sub_tails[aid][1]
                meta = self.sub_tails[aid][2]
                entry["type"] = entry["type"] or meta.get("agentType")
                entry["description"] = entry["description"] or meta.get("description")
            elif aid and aid in self.sidechains:
                conv = self.sidechains[aid]
            if conv is not None:
                cd = conv.to_dict()
                entry["activity"] = cd
                if not s.get("done"):
                    entry["status"] = "running" if cd["status"] in ("tool", "thinking", "subagents") else "completed"
            subs.append(entry)
            if aid:
                seen.add(aid)
        for aid, (tail, conv, meta) in self.sub_tails.items():
            if aid in seen:
                continue
            cd = conv.to_dict()
            subs.append({"id": aid, "tool_use_id": meta.get("toolUseId"), "type": meta.get("agentType"), "description": meta.get("description"),
                         "status": "running" if cd["status"] in ("tool", "thinking", "subagents") else "completed", "activity": cd})
        for aid, conv in self.sidechains.items():
            if aid in seen or aid in self.sub_tails:
                continue
            cd = conv.to_dict()
            subs.append({"id": aid, "type": "sidechain", "description": truncate(conv.last_prompt, 80),
                         "status": "running" if cd["status"] in ("tool", "thinking", "subagents") else "completed", "activity": cd})
        d["subagents"] = subs
        return d


# ----- Codex

class CodexConversation(Conversation):
    def feed(self, o):
        t = o.get("type")
        p = o.get("payload") or {}
        ts = o.get("timestamp")
        if ts:
            self.last_ts = ts
        if t == "session_meta":
            self.session_id = p.get("id") or self.session_id
            self.model = (p.get("model") or self.model)
            return
        if t == "turn_context":
            self.model = p.get("model") or self.model
            return
        if t == "event_msg":
            pt = p.get("type")
            if pt == "task_started":
                self.busy = True
                self.last_role = "user"
            elif pt in ("task_complete", "turn_aborted"):
                self.busy = False
                self.pending.clear()
                self.last_role = "assistant"
                if p.get("last_agent_message"):
                    self.last_text = p["last_agent_message"]
            elif pt == "agent_message":
                if p.get("message"):
                    self.last_text = p["message"]
            elif pt == "user_message":
                msg = p.get("message") or ""
                if msg.strip():
                    self.last_prompt = re.sub(r"^# Context from my IDE setup:.*?(?=\n\n[^#\n])", "", msg, flags=re.S).strip() or msg.strip()
                    self.turns += 1
                self.last_role = "user"
            elif pt == "exec_command_begin":
                cid = p.get("call_id")
                cmd = p.get("command")
                if isinstance(cmd, list):
                    cmd = " ".join(cmd)
                self.pending[cid] = {"name": "exec", "summary": truncate(cmd, 140), "ts": ts}
                self.tool_calls += 1
            elif pt == "exec_command_end":
                self.pending.pop(p.get("call_id"), None)
            elif pt == "token_count":
                info = p.get("info") or {}
                tu = info.get("total_token_usage") or {}
                if tu:
                    self.usage = {"input": tu.get("input_tokens"), "output": tu.get("output_tokens"),
                                  "cache_read": tu.get("cached_input_tokens"), "total": tu.get("total_tokens")}
            return
        if t == "response_item":
            pt = p.get("type")
            if pt in ("function_call", "custom_tool_call", "local_shell_call"):
                cid = p.get("call_id") or p.get("id")
                name = p.get("name") or ("shell" if pt == "local_shell_call" else "tool")
                args = p.get("arguments") if pt == "function_call" else p.get("input")
                summary = None
                if isinstance(args, str):
                    try:
                        j = json.loads(args)
                        summary = summarize_tool_input(name, j)
                    except ValueError:
                        summary = truncate(args.replace("\n", " "), 140)
                elif isinstance(args, dict):
                    summary = summarize_tool_input(name, args)
                if pt == "local_shell_call":
                    act = p.get("action") or {}
                    summary = truncate(" ".join(act.get("command") or []), 140)
                self.pending[cid] = {"name": name, "summary": summary, "ts": ts}
                self.tool_calls += 1
                self.last_role = "assistant"
                if name in ("spawn_agent", "spawn_agents", "spawn_agents_on_csv"):
                    self.subagents[cid] = {"desc": summary, "type": "codex-subagent", "agent_id": None, "ts": ts, "done": False}
            elif pt in ("function_call_output", "custom_tool_call_output", "local_shell_call_output"):
                self.pending.pop(p.get("call_id"), None)
                self.last_role = "tool_result"
            elif pt == "message":
                role = p.get("role")
                if role == "assistant":
                    txt = "\n".join(x.get("text", "") for x in (p.get("content") or []) if isinstance(x, dict) and x.get("type") in ("output_text", "text"))
                    if txt.strip():
                        self.last_text = txt.strip()
                    self.last_role = "assistant"


class CodexIntrospector(object):
    SESS_DIR = os.path.join(os.path.expanduser("~"), ".codex", "sessions")

    def __init__(self, cwd, started=None, session_id=None):
        self.cwd = cwd
        self.started = started or 0
        self.session_id = session_id
        self.path = None
        self.tail = None
        self.main = CodexConversation()
        self.subs = {}          # session_id -> (Tail, CodexConversation, meta)
        self.last_locate = 0
        self.last_sub_scan = 0
        self.mtime = 0
        self.meta_cache = {}    # path -> (mtime_first_seen, meta)
        self.title = None
        self.last_title = 0

    def _recent_files(self):
        files = []
        cutoff = self.started - 60
        try:
            days = sorted(glob.glob(os.path.join(self.SESS_DIR, "*", "*", "*")))[-3:]
        except Exception:
            days = []
        for d in days:
            for p in glob.glob(os.path.join(d, "rollout-*.jsonl")):
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                if st.st_mtime >= cutoff:
                    files.append((st.st_mtime, p))
        files.sort(reverse=True)
        return files

    def _meta(self, path):
        if path in self.meta_cache:
            return self.meta_cache[path]
        meta = None
        try:
            with open(path, "rb") as f:
                first = f.readline().decode("utf-8", "replace")
            o = json.loads(first)
            if o.get("type") == "session_meta":
                meta = o.get("payload") or {}
        except Exception:
            meta = None
        self.meta_cache[path] = meta
        return meta

    def locate(self):
        if self.path:
            return True
        now = time.time()
        if now - self.last_locate < 5:
            return False
        self.last_locate = now
        for mt, p in self._recent_files():
            meta = self._meta(p)
            if not meta:
                continue
            if self.session_id:
                if meta.get("id") == self.session_id:
                    self.path = p
                    break
                continue
            if meta.get("thread_source", "user") != "user" or meta.get("parent_thread_id"):
                continue
            if os.path.normpath(meta.get("cwd") or "") != os.path.normpath(self.cwd):
                continue
            self.path = p
            self.session_id = meta.get("id")
            break
        if self.path:
            self.tail = Tail(self.path)
            self.main.session_id = self.session_id
            return True
        return False

    def poll(self):
        if not self.locate():
            return
        for o in self.tail.read():
            self.main.feed(o)
        try:
            self.mtime = os.stat(self.path).st_mtime
        except OSError:
            pass
        now = time.time()
        if now - self.last_sub_scan > 4:
            self.last_sub_scan = now
            for mt, p in self._recent_files():
                if p == self.path or p in self.subs:
                    continue
                meta = self._meta(p)
                if meta and meta.get("parent_thread_id") == self.session_id:
                    self.subs[p] = (Tail(p), CodexConversation(), meta)
        for p, (tail, conv, meta) in self.subs.items():
            for o in tail.read():
                conv.feed(o)
        if now - self.last_title > 15:
            self.last_title = now
            self._read_title()

    def _read_title(self):
        idx = os.path.join(os.path.expanduser("~"), ".codex", "session_index.jsonl")
        if not self.session_id or not os.path.exists(idx):
            return
        try:
            with open(idx, "rb") as f:
                f.seek(max(0, os.path.getsize(idx) - 256 * 1024))
                for ln in f.read().decode("utf-8", "replace").splitlines():
                    if self.session_id in ln:
                        try:
                            o = json.loads(ln)
                            if o.get("id") == self.session_id and o.get("thread_name"):
                                self.title = o["thread_name"]
                        except ValueError:
                            pass
        except OSError:
            pass

    def to_dict(self):
        d = self.main.to_dict()
        d["kind"] = "codex"
        d["title"] = self.title or d.get("title")
        d["transcript"] = self.path
        d["age"] = round(time.time() - self.mtime, 1) if self.mtime else None
        subs = []
        for p, (tail, conv, meta) in self.subs.items():
            cd = conv.to_dict()
            src = meta.get("source")
            stype = None
            if isinstance(src, dict) and isinstance(src.get("subagent"), dict):
                sa = src["subagent"]
                stype = sa.get("other") or next(iter(sa.values()), None) if sa else None
            subs.append({"id": meta.get("id"), "type": stype or "subagent", "description": truncate(conv.last_prompt, 100) or stype,
                         "started": meta.get("timestamp"), "status": "running" if cd["status"] in ("tool", "thinking") else "completed",
                         "activity": cd})
        d["subagents"] = subs
        return d


# ----- OpenCode

class OpenCodeIntrospector(object):
    """Best-effort reader of ~/.local/share/opencode/storage (session / message / part JSON files)."""
    STORAGE = os.path.join(os.path.expanduser("~"), ".local", "share", "opencode", "storage")

    def __init__(self, cwd, started=None):
        self.cwd = cwd
        self.started = started or 0
        self.session = None
        self.last_locate = 0
        self.last_poll = 0
        self.cache = {}

    def _load(self, path):
        try:
            return json.loads(read_file(path, "{}"))
        except ValueError:
            return {}

    def locate(self):
        if self.session:
            return True
        now = time.time()
        if now - self.last_locate < 5:
            return False
        self.last_locate = now
        best = None
        for p in glob.glob(os.path.join(self.STORAGE, "session", "*", "*.json")):
            try:
                mt = os.stat(p).st_mtime
            except OSError:
                continue
            if mt < self.started - 60:
                continue
            s = self._load(p)
            if s.get("parentID"):
                continue
            if os.path.normpath(s.get("directory") or "") != os.path.normpath(self.cwd):
                continue
            if best is None or mt > best[0]:
                best = (mt, s, p)
        if best:
            self.session = best[1]
            self.session_path = best[2]
        return bool(self.session)

    def _conv(self, session_id):
        conv = Conversation()
        conv.session_id = session_id
        msgs = []
        for p in glob.glob(os.path.join(self.STORAGE, "message", session_id, "*.json")):
            m = self._load(p)
            if m.get("id"):
                msgs.append(m)
        msgs.sort(key=lambda m: ((m.get("time") or {}).get("created") or 0, m.get("id")))
        for m in msgs[-40:]:
            role = m.get("role")
            t = m.get("time") or {}
            created = t.get("created")
            if created:
                conv.last_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created / 1000.0))
            parts = [self._load(p) for p in glob.glob(os.path.join(self.STORAGE, "part", m["id"], "*.json"))]
            parts.sort(key=lambda x: x.get("id") or "")
            text = "\n".join(x.get("text", "") for x in parts if x.get("type") == "text")
            if role == "user":
                conv.turns += 1
                if text.strip():
                    conv.last_prompt = text.strip()
                conv.last_role = "user"
            else:
                conv.model = m.get("modelID") or conv.model
                tk = m.get("tokens") or {}
                if tk:
                    conv.usage = {"input": tk.get("input"), "output": tk.get("output"), "cache_read": (tk.get("cache") or {}).get("read")}
                if text.strip():
                    conv.last_text = text.strip()
                conv.pending.clear()
                for x in parts:
                    if x.get("type") == "tool":
                        conv.tool_calls += 1
                        st = x.get("state") or {}
                        if st.get("status") in ("running", "pending"):
                            conv.pending[x.get("id")] = {"name": x.get("tool"), "summary": st.get("title") or summarize_tool_input(x.get("tool"), st.get("input")), "ts": conv.last_ts}
                        if x.get("tool") in ("task", "Task", "agent"):
                            conv.subagents[x.get("id")] = {"desc": st.get("title") or summarize_tool_input("task", st.get("input")), "type": "task", "agent_id": None, "ts": conv.last_ts, "done": st.get("status") == "completed"}
                conv.busy = not t.get("completed")
                conv.last_role = "assistant"
        return conv

    def poll(self):
        pass

    def to_dict(self):
        now = time.time()
        if not self.locate():
            d = Conversation().to_dict()
            d["kind"] = "opencode"
            d["subagents"] = []
            return d
        if now - self.last_poll > 3 or not self.cache:
            self.last_poll = now
            self.session = self._load(self.session_path) or self.session
            conv = self._conv(self.session["id"])
            conv.title = self.session.get("title")
            d = conv.to_dict()
            d["kind"] = "opencode"
            d["transcript"] = self.session_path
            upd = (self.session.get("time") or {}).get("updated")
            d["age"] = round(now - upd / 1000.0, 1) if upd else None
            subs = []
            for p in glob.glob(os.path.join(os.path.dirname(self.session_path), "*.json")):
                s = self._load(p)
                if s.get("parentID") == self.session["id"]:
                    c = self._conv(s["id"])
                    cd = c.to_dict()
                    subs.append({"id": s["id"], "type": "task", "description": s.get("title"), "status": "running" if cd["status"] in ("tool", "thinking") else "completed", "activity": cd})
            d["subagents"] = subs
            self.cache = d
        return self.cache


TOOL_NAMES = ("claude", "codex", "opencode", "tmux", "git", "curl", "npm", "nvidia-smi", "python3")


def probe_tools():
    """Locate the CLIs Hostler cares about: PATH, common user dirs, a login shell, IDE bundles."""
    tools = {}
    for t in TOOL_NAMES:
        tools[t] = which(t)
    # a login shell finds agents installed through nvm / asdf / custom rc files
    missing = [t for t in ("claude", "codex", "opencode") if not tools[t]]
    if missing:
        shell = os.environ.get("SHELL") or "/bin/bash"
        rc, out, _ = run_cmd([shell, "-lic", "for t in %s; do printf '%%s=%%s\\n' $t \"$(command -v $t)\"; done" % " ".join(missing)], timeout=8)
        for line in out.splitlines():
            k, _, v = line.partition("=")
            if k in tools and v.strip():
                tools[k] = v.strip()
    for t in ("claude", "codex", "opencode"):
        AGENT_BINS[t] = tools[t]
    return tools


def make_introspector(kind, cwd, started=None, session_id=None):
    if kind == "claude":
        return ClaudeIntrospector(cwd, session_id=session_id, started=started)
    if kind == "codex":
        return CodexIntrospector(cwd, started=started, session_id=session_id)
    if kind == "opencode":
        return OpenCodeIntrospector(cwd, started=started)
    return None


# --------------------------------------------------------------------------- sessions

class RingBuffer(object):
    def __init__(self, cap):
        self.cap = cap
        self.buf = bytearray()

    def append(self, data):
        self.buf.extend(data)
        if len(self.buf) > self.cap:
            del self.buf[: len(self.buf) - self.cap]

    def bytes(self):
        return bytes(self.buf)

    def clear(self):
        self.buf = bytearray()


class Session(object):
    def __init__(self, sid, spec):
        self.id = sid
        self.spec = spec                          # creation params (for restart)
        self.name = spec.get("name") or sid
        self.type = spec.get("type") or "shell"   # claude | codex | opencode | shell | custom
        self.cwd = spec.get("cwd") or os.path.expanduser("~")
        self.workspace = spec.get("workspace") or self.cwd
        self.argv = None
        self.command_display = None
        self.pid = None
        self.fd = None
        self.status = "starting"                  # starting | running | exited | adopted | lost
        self.exit_code = None
        self.exit_signal = None
        self.created = time.time()
        self.started = None
        self.ended = None
        self.cols = int(spec.get("cols") or 120)
        self.rows = int(spec.get("rows") or 32)
        self.buffer = RingBuffer(SCROLLBACK_BYTES)
        self.subscribers = set()
        self.lock = threading.Lock()
        self.logfile = None
        self.log_bytes = 0
        self.adopted = spec.get("adopted", False)
        self.adopted_pid = spec.get("pid")
        self.tmux_target = spec.get("tmux_target")
        self.meta = dict(spec.get("meta") or {})
        self.introspector = None
        self.processes = []
        self.restarts = 0
        self.last_output = None
        self.error = None
        self.detached_pids = set()

    def root_pid(self):
        return self.adopted_pid if self.adopted else self.pid

    def open_log(self):
        try:
            os.makedirs(LOGS_DIR, exist_ok=True)
            path = os.path.join(LOGS_DIR, "%s.log" % self.id)
            self.logfile = open(path, "ab")
            self.log_bytes = self.logfile.tell()
        except Exception as e:
            log("cannot open log for %s: %s", self.id, e)

    def write_log(self, data):
        if not self.logfile:
            return
        try:
            self.logfile.write(data)
            self.logfile.flush()
            self.log_bytes += len(data)
            if self.log_bytes > LOGFILE_MAX_BYTES:
                path = self.logfile.name
                self.logfile.close()
                with open(path, "rb") as f:
                    f.seek(LOGFILE_MAX_BYTES // 2)
                    keep = f.read()
                with open(path, "wb") as f:
                    f.write(b"[... log truncated by hostler helper ...]\r\n")
                    f.write(keep)
                self.logfile = open(path, "ab")
                self.log_bytes = self.logfile.tell()
        except Exception:
            pass

    def to_dict(self, with_activity=True):
        d = {
            "id": self.id, "name": self.name, "type": self.type, "cwd": self.cwd, "workspace": self.workspace,
            "command": self.command_display, "pid": self.root_pid(), "status": self.status,
            "exit_code": self.exit_code, "exit_signal": self.exit_signal, "created": self.created,
            "started": self.started, "ended": self.ended, "cols": self.cols, "rows": self.rows,
            "adopted": self.adopted, "tmux_target": self.tmux_target, "meta": self.meta, "restarts": self.restarts,
            "last_output": self.last_output, "error": self.error, "has_pty": self.fd is not None,
            "processes": self.processes, "scrollback_bytes": len(self.buffer.buf),
        }
        if with_activity:
            try:
                d["activity"] = self.introspector.to_dict() if self.introspector else None
            except Exception as e:
                d["activity"] = {"kind": self.type, "status": "error", "error": str(e)}
        return d


def build_argv(spec):
    """Turn a session spec into (argv, display, meta)."""
    kind = spec.get("type") or "shell"
    shell = os.environ.get("SHELL") or "/bin/bash"
    if not os.path.exists(shell):
        shell = "/bin/sh"
    extra = spec.get("args") or ""
    meta = {}
    if kind == "claude":
        sid = spec.get("claude_session_id") or (spec.get("meta") or {}).get("claude_session_id") or str(uuid.uuid4())
        meta["claude_session_id"] = sid
        claude = agent_binary("claude")
        if spec.get("resume"):
            cmd = "%s --resume %s %s" % (claude, shlex.quote(sid), extra)
        else:
            cmd = "%s --session-id %s %s" % (claude, shlex.quote(sid), extra)
    elif kind == "codex":
        codex = agent_binary("codex")
        rs = spec.get("resume_id")
        cmd = ("%s resume %s %s" % (codex, shlex.quote(rs), extra)) if (spec.get("resume") and rs) else ("%s %s" % (codex, extra))
    elif kind == "opencode":
        cmd = "%s %s" % (agent_binary("opencode"), extra)
    elif kind == "shell":
        cmd = None
    else:
        cmd = spec.get("command") or extra
        if not cmd:
            raise ValueError("custom session needs a command")
    if cmd is None:
        argv = [shell, "-l"]
        display = shell
    else:
        cmd = cmd.strip()
        # run through the user's login+interactive shell so PATH (nvm, ~/.local/bin ...) matches a normal terminal;
        # simple commands are exec'd so the agent process replaces the shell (signals go straight to it)
        simple = not re.search(r"[;&|\n]|\$\(|`", cmd)
        argv = [shell, "-lic", ("exec " + cmd) if simple else cmd]
        display = cmd
    return argv, display, meta


class SessionManager(object):
    def __init__(self, server):
        self.server = server
        self.sessions = OrderedDict()
        self.lock = threading.RLock()
        self.wake_r, self.wake_w = os.pipe()
        self.reg_lock = threading.Lock()
        self.reader = threading.Thread(target=self._reader_loop, name="pty-reader")
        self.reader.daemon = True
        self.reader.start()

    # ----- lifecycle

    def create(self, spec):
        sid = spec.get("id") or uuid.uuid4().hex[:12]
        s = Session(sid, spec)
        with self.lock:
            if sid in self.sessions:
                raise ValueError("session id exists")
            self.sessions[sid] = s
        if s.adopted:
            self._init_adopted(s)
        else:
            self._spawn(s)
        self.save_registry()
        self.server.broadcast({"ev": "session.created", "session": s.to_dict(with_activity=False)})
        return s

    def _init_adopted(self, s):
        p = read_proc(s.adopted_pid)
        if p is None:
            raise ValueError("process %s not found" % s.adopted_pid)
        s.status = "adopted"
        s.started = p.start_epoch()
        s.pid = None
        cmd = proc_cmdline(s.adopted_pid)
        s.command_display = " ".join(cmd)[:300]
        if not s.spec.get("cwd"):
            s.cwd = proc_cwd(s.adopted_pid) or s.cwd
            s.workspace = s.spec.get("workspace") or s.cwd
        s.introspector = make_introspector(s.type, s.cwd, started=s.started, session_id=s.meta.get("session_id"))

    def _spawn(self, s):
        argv, display, meta = build_argv(s.spec)
        s.argv = argv
        s.command_display = display
        s.meta.update(meta)
        env = dict(os.environ)
        env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "HOSTLER_SESSION": s.id,
                    "HOSTLER_SOCK": SOCK_PATH, "LANG": env.get("LANG") or "C.UTF-8"})
        for k, v in (s.spec.get("env") or {}).items():
            env[str(k)] = str(v)
        env.pop("HOSTLER_DIR", None)
        cwd = s.cwd
        if not os.path.isdir(cwd):
            raise ValueError("cwd does not exist: %s" % cwd)
        pid, fd = pty.fork()
        if pid == 0:  # child
            try:
                os.chdir(cwd)
                signal.signal(signal.SIGINT, signal.SIG_DFL)
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
                signal.signal(signal.SIGHUP, signal.SIG_DFL)
                signal.signal(signal.SIGPIPE, signal.SIG_DFL)
                os.execvpe(argv[0], argv, env)
            except Exception as e:
                os.write(2, ("hostler: exec failed: %s\n" % e).encode())
            finally:
                os._exit(127)
        s.pid = pid
        s.fd = fd
        s.status = "running"
        s.started = time.time()
        s.ended = None
        s.exit_code = None
        s.error = None
        self._set_winsize(fd, s.rows, s.cols)
        fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) | os.O_NONBLOCK)
        s.open_log()
        header = ("\r\n\x1b[2m[hostler] session %s started %s in %s: %s\x1b[0m\r\n" % (s.id, time.strftime("%Y-%m-%d %H:%M:%S"), cwd, display)).encode()
        s.buffer.append(header)
        s.write_log(header)
        s.introspector = make_introspector(s.type, s.cwd, started=s.started, session_id=s.meta.get("claude_session_id") or s.meta.get("session_id"))
        os.write(self.wake_w, b"x")

    @staticmethod
    def _set_winsize(fd, rows, cols):
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(1, rows), max(1, cols), 0, 0))
        except Exception:
            pass

    def get(self, sid):
        with self.lock:
            s = self.sessions.get(sid)
        if s is None:
            raise ValueError("no such session: %s" % sid)
        return s

    def resize(self, sid, cols, rows):
        s = self.get(sid)
        s.cols, s.rows = int(cols), int(rows)
        if s.fd is not None:
            self._set_winsize(s.fd, s.rows, s.cols)
            try:
                os.kill(s.pid, signal.SIGWINCH)
            except Exception:
                pass

    def write(self, sid, data):
        s = self.get(sid)
        if s.fd is None:
            raise ValueError("session has no pty (adopted process)")
        view = memoryview(data)
        while len(view):
            try:
                n = os.write(s.fd, view)
                view = view[n:]
            except BlockingIOError:
                select.select([], [s.fd], [], 1.0)
            except OSError as e:
                raise ValueError("write failed: %s" % e)

    def signal(self, sid, signame="TERM", tree=True):
        s = self.get(sid)
        sig = getattr(signal, "SIG" + signame.upper().replace("SIG", ""), None)
        if sig is None:
            raise ValueError("bad signal " + signame)
        root = s.root_pid()
        if root is None:
            raise ValueError("session has no process")
        pids = [root]
        if tree:
            pids = list(descendants(scan_procs(), root)) + list(s.detached_pids)
            pids = [root] + [p for p in pids if p != root]
        sent = 0
        for pid in pids:
            try:
                os.kill(pid, sig)
                sent += 1
            except ProcessLookupError:
                pass
            except PermissionError:
                pass
        return {"signalled": sent, "pids": pids}

    def stop(self, sid, force=False):
        s = self.get(sid)
        if s.status in ("exited", "lost"):
            return {"status": s.status}
        if s.fd is not None and not force:
            # graceful: SIGTERM to the whole tree, then SIGKILL after grace period (in background)
            res = self.signal(sid, "TERM", tree=True)
            t = threading.Timer(8.0, self._kill_if_alive, args=(sid,))
            t.daemon = True
            t.start()
            return res
        return self.signal(sid, "KILL" if force else "TERM", tree=True)

    def _kill_if_alive(self, sid):
        try:
            s = self.get(sid)
            if s.status == "running":
                self.signal(sid, "KILL", tree=True)
        except Exception:
            pass

    def restart(self, sid):
        s = self.get(sid)
        if s.adopted:
            raise ValueError("adopted sessions cannot be restarted")
        if s.status == "running":
            self.signal(sid, "TERM", tree=True)
            deadline = time.time() + 8
            while s.status == "running" and time.time() < deadline:
                time.sleep(0.2)
            if s.status == "running":
                self.signal(sid, "KILL", tree=True)
                deadline = time.time() + 3
                while s.status == "running" and time.time() < deadline:
                    time.sleep(0.2)
        spec = dict(s.spec)
        if s.type == "claude" and s.meta.get("claude_session_id"):
            spec["resume"] = True
            spec["claude_session_id"] = s.meta["claude_session_id"]
        if s.type == "codex":
            act = s.introspector.to_dict() if s.introspector else {}
            if act and act.get("session_id"):
                spec["resume"] = True
                spec["resume_id"] = act["session_id"]
        s.spec = spec
        s.restarts += 1
        s.buffer.append(b"\r\n\x1b[2m[hostler] restarting...\x1b[0m\r\n")
        self._spawn(s)
        self.save_registry()
        self.server.broadcast({"ev": "session.created", "session": s.to_dict(with_activity=False)})
        return s

    def remove(self, sid, force=False):
        s = self.get(sid)
        if s.status == "running" and not force:
            raise ValueError("session still running; stop it first")
        if s.status == "running":
            self.signal(sid, "KILL", tree=True)
        with self.lock:
            self.sessions.pop(sid, None)
        if s.fd is not None:
            try:
                os.close(s.fd)
            except OSError:
                pass
            s.fd = None
        if s.logfile:
            try:
                s.logfile.close()
            except Exception:
                pass
        self.save_registry()
        self.server.broadcast({"ev": "session.removed", "id": sid})
        return True

    # ----- output pump

    def _reader_loop(self):
        while True:
            with self.lock:
                fds = dict((s.fd, s) for s in self.sessions.values() if s.fd is not None)
            rl = list(fds.keys()) + [self.wake_r]
            try:
                r, _, _ = select.select(rl, [], [], 1.0)
            except (OSError, ValueError):
                time.sleep(0.05)
                continue
            for fd in r:
                if fd == self.wake_r:
                    try:
                        os.read(self.wake_r, 4096)
                    except OSError:
                        pass
                    continue
                s = fds.get(fd)
                if s is None:
                    continue
                try:
                    data = os.read(fd, 65536)
                except BlockingIOError:
                    continue
                except OSError:
                    data = b""
                if not data:
                    self._pty_closed(s)
                    continue
                s.last_output = time.time()
                with s.lock:
                    s.buffer.append(data)
                    s.write_log(data)
                    subs = list(s.subscribers)
                if subs:
                    msg = {"ev": "output", "session": s.id, "data": b64e(data)}
                    for c in subs:
                        c.send(msg)

    def _pty_closed(self, s):
        if s.fd is None:
            return
        try:
            os.close(s.fd)
        except OSError:
            pass
        s.fd = None
        self.reap(block_pid=s.pid)

    # ----- child reaping

    def reap(self, block_pid=None):
        """Reap exited children (sessions + orphans adopted through the subreaper)."""
        while True:
            try:
                if block_pid:
                    pid, status = os.waitpid(block_pid, 0)
                    block_pid = None
                else:
                    pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            except OSError:
                return
            if pid == 0:
                return
            self._child_exited(pid, status)

    def _child_exited(self, pid, status):
        with self.lock:
            s = next((x for x in self.sessions.values() if x.pid == pid and not x.adopted), None)
        if s is None:
            return  # orphan reaped
        if os.WIFEXITED(status):
            s.exit_code = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            s.exit_signal = os.WTERMSIG(status)
            s.exit_code = 128 + s.exit_signal
        s.status = "exited"
        s.ended = time.time()
        if s.fd is not None:
            # drain remaining output
            try:
                while True:
                    data = os.read(s.fd, 65536)
                    if not data:
                        break
                    with s.lock:
                        s.buffer.append(data)
                        s.write_log(data)
                        subs = list(s.subscribers)
                    for c in subs:
                        c.send({"ev": "output", "session": s.id, "data": b64e(data)})
            except OSError:
                pass
            try:
                os.close(s.fd)
            except OSError:
                pass
            s.fd = None
        footer = ("\r\n\x1b[2m[hostler] process exited (code %s) at %s\x1b[0m\r\n" % (s.exit_code, time.strftime("%H:%M:%S"))).encode()
        with s.lock:
            s.buffer.append(footer)
            s.write_log(footer)
            subs = list(s.subscribers)
        for c in subs:
            c.send({"ev": "output", "session": s.id, "data": b64e(footer)})
        self.server.broadcast({"ev": "session.exit", "id": s.id, "exit_code": s.exit_code, "signal": s.exit_signal})
        self.save_registry()

    # ----- registry persistence (informational; PTYs cannot survive a helper restart)

    def save_registry(self):
        try:
            with self.lock:
                data = [dict(s.to_dict(with_activity=False), spec=s.spec) for s in self.sessions.values()]
            with self.reg_lock:
                tmp = REGISTRY_PATH + ".tmp"
                with open(tmp, "w") as f:
                    json.dump({"helper_pid": HELPER_PID, "saved": time.time(), "sessions": data}, f)
                os.replace(tmp, REGISTRY_PATH)
        except Exception as e:
            log("registry save failed: %s", e)

    def load_registry(self):
        """Re-attach adopted sessions from a previous helper run; mark PTY sessions as lost."""
        try:
            data = json.loads(read_file(REGISTRY_PATH, "{}"))
        except ValueError:
            return
        for d in data.get("sessions") or []:
            try:
                spec = d.get("spec") or {}
                spec["id"] = d["id"]
                if d.get("adopted") and d.get("pid") and read_proc(d["pid"]):
                    spec["adopted"] = True
                    spec["pid"] = d["pid"]
                    self.create(spec)
                elif not d.get("adopted"):
                    s = Session(d["id"], spec)
                    s.command_display = d.get("command")
                    s.status = "lost" if d.get("status") == "running" else "exited"
                    s.exit_code = d.get("exit_code")
                    s.started, s.ended, s.created = d.get("started"), d.get("ended") or time.time(), d.get("created") or time.time()
                    s.meta = d.get("meta") or {}
                    s.restarts = d.get("restarts") or 0
                    lp = os.path.join(LOGS_DIR, "%s.log" % s.id)
                    tail = read_file(lp, b"", binary=True)
                    if tail:
                        s.buffer.append(tail[-SCROLLBACK_BYTES:])
                    with self.lock:
                        self.sessions[s.id] = s
            except Exception as e:
                log("registry restore failed for %s: %s", d.get("id"), e)


def descendants(procs, root):
    children = {}
    for p in procs.values():
        children.setdefault(p.ppid, []).append(p.pid)
    out = []
    stack = [root]
    seen = set()
    while stack:
        pid = stack.pop()
        for c in children.get(pid, []):
            if c not in seen:
                seen.add(c)
                out.append(c)
                stack.append(c)
    return out


# --------------------------------------------------------------------------- monitor: attribution, discovery, state

class Monitor(object):
    def __init__(self, server):
        self.server = server
        self.sm = server.sm
        self.res = ResourceMonitor()
        self.subreaper = set_child_subreaper()
        self.attribution = {}      # pid -> (session_id, starttime)
        self.env_cache = {}        # (pid, starttime) -> session id from HOSTLER_SESSION env marker (or None)
        self.discovered = []
        self.adopted_by_pid = {}
        self.last_discovery = 0
        self.tmux_panes = None
        self.tmux_t = 0
        self.thread = threading.Thread(target=self.loop, name="monitor")
        self.thread.daemon = True
        self.hello = self.build_hello()

    def build_hello(self):
        import pwd
        try:
            user = pwd.getpwuid(os.getuid()).pw_name
        except Exception:
            user = os.environ.get("USER", "?")
        tools = probe_tools()
        os_name = None
        for line in (read_file("/etc/os-release") or "").splitlines():
            if line.startswith("PRETTY_NAME="):
                os_name = line.split("=", 1)[1].strip().strip('"')
        return {
            "version": VERSION, "sha": SELF_SHA, "protocol": PROTOCOL, "pid": HELPER_PID, "hostname": socket.gethostname(),
            "user": user, "home": os.path.expanduser("~"), "shell": os.environ.get("SHELL"), "os": os_name,
            "arch": os.uname().machine, "python": sys.version.split()[0], "tools": tools, "subreaper": self.subreaper,
            "gpu_kind": self.res.gpu_kind if hasattr(self.res, "gpu_kind") else ("nvidia" if self.res.nvidia_smi else ("jetson" if self.res.jetson else None)),
            "sock": SOCK_PATH, "started": time.time(),
        }

    def rescan_tools(self):
        """Re-probe the CLIs (an install finished; no need to reconnect the machine)."""
        tools = probe_tools()
        self.hello["tools"] = tools
        return tools

    def start(self):
        self.thread.start()

    def loop(self):
        while True:
            t0 = time.time()
            try:
                self.tick()
            except Exception:
                log("monitor tick failed: %s", traceback.format_exc())
            dt = time.time() - t0
            time.sleep(max(0.3, STATE_INTERVAL - dt))

    def tick(self):
        self.sm.reap()
        procs = scan_procs()
        self.res.per_process_cpu(procs)
        system = self.res.sample_system()
        self.attribute(procs)
        now = time.time()
        if now - self.last_discovery > 5:
            self.last_discovery = now
            self.discovered = self.discover(procs)
        with self.sm.lock:
            sessions = list(self.sm.sessions.values())
        for s in sessions:
            if s.introspector:
                try:
                    s.introspector.poll()
                except Exception:
                    log("introspector poll failed for %s: %s", s.id, traceback.format_exc())
            if s.adopted and s.status == "adopted" and (s.adopted_pid not in procs):
                s.status = "exited"
                s.ended = time.time()
                self.server.broadcast({"ev": "session.exit", "id": s.id, "exit_code": None, "signal": None})
        state = {
            "ev": "state", "ts": now, "host": self.hello, "resources": system,
            "sessions": [s.to_dict() for s in sessions], "discovered": self.discovered,
        }
        self.server.broadcast(state, only_subscribed=True)

    # ----- attribution

    def attribute(self, procs):
        children = {}
        for p in procs.values():
            children.setdefault(p.ppid, []).append(p.pid)
        with self.sm.lock:
            sessions = list(self.sm.sessions.values())
        new_attr = {}
        per_session = {}

        def walk(root, sid, detached):
            stack = [root]
            while stack:
                pid = stack.pop()
                p = procs.get(pid)
                if p is None or pid in new_attr:
                    continue
                new_attr[pid] = (sid, p.starttime)
                per_session.setdefault(sid, []).append((p, detached))
                stack.extend(children.get(pid, []))

        for s in sessions:
            root = s.root_pid()
            if root and root in procs:
                walk(root, s.id, False)
        # orphans re-parented to us (subreaper) or to init keep their previous attribution
        for pid, p in procs.items():
            if pid in new_attr:
                continue
            prev = self.attribution.get(pid)
            if prev and prev[1] == p.starttime and (p.ppid == HELPER_PID or p.ppid == 1 or p.ppid not in procs):
                walk(pid, prev[0], True)
        # fallback: processes that detached before we ever saw them (setsid/nohup/double fork) still carry the
        # HOSTLER_SESSION marker in their environment (inherited from the session's PTY shell)
        session_ids = set(s.id for s in sessions)
        my_uid = os.getuid()
        for pid, p in procs.items():
            if pid in new_attr or pid == HELPER_PID:
                continue
            key = (pid, p.starttime)
            if key in self.env_cache:
                sid = self.env_cache[key]
            else:
                sid = None
                if proc_uid(pid) == my_uid:
                    sid = proc_env(pid).get("HOSTLER_SESSION")
                self.env_cache[key] = sid
            if sid and sid in session_ids:
                walk(pid, sid, True)
        if len(self.env_cache) > 4096:
            live = set((pid, p.starttime) for pid, p in procs.items())
            self.env_cache = dict((k, v) for k, v in self.env_cache.items() if k in live)
        self.attribution = new_attr
        for s in sessions:
            items = per_session.get(s.id, [])
            root = s.root_pid()
            out = []
            detached_pids = set()
            for p, detached in items:
                if detached:
                    detached_pids.add(p.pid)
                cmd = proc_cmdline(p.pid)
                out.append({
                    "pid": p.pid, "ppid": p.ppid if not detached or p.ppid != HELPER_PID else 0, "name": p.comm, "state": p.state,
                    "cmd": truncate(" ".join(cmd), 240) if cmd else "[%s]" % p.comm,
                    "cpu": p.cpu, "rss": p.rss, "gpu_mem": p.gpu_mem, "started": p.start_epoch(), "detached": detached,
                    "root": p.pid == root,
                })
            out.sort(key=lambda x: (not x["root"], x["started"], x["pid"]))
            s.processes = out
            s.detached_pids = detached_pids

    # ----- discovery of foreign agent processes

    def _tmux_panes(self):
        now = time.time()
        if self.tmux_panes is not None and now - self.tmux_t < 10:
            return self.tmux_panes
        self.tmux_t = now
        panes = {}
        tmux = which("tmux")
        if tmux:
            rc, out, _ = run_cmd([tmux, "list-panes", "-a", "-F", "#{pane_tty}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}"], timeout=3)
            if rc == 0:
                for line in out.splitlines():
                    f = line.split("\t")
                    if len(f) >= 3:
                        panes[f[0]] = f[1]
        self.tmux_panes = panes
        return panes

    def discover(self, procs):
        found = []
        my_uid = os.getuid()
        agent_pids = {}
        for pid, p in procs.items():
            if pid in self.attribution or pid == HELPER_PID:
                continue
            uid = proc_uid(pid)
            if uid is None or uid != my_uid:
                continue
            if p.comm in ("node", "codex", "claude", "opencode", "bun") or p.comm.startswith("codex") or p.comm.startswith("opencode"):
                cmd = proc_cmdline(pid)
                kind, sub = classify_agent(cmd)
                if kind:
                    agent_pids[pid] = (kind, sub, cmd, p)
        # keep only the top-most agent process of each chain (skip children of another agent process)
        for pid, (kind, sub, cmd, p) in agent_pids.items():
            anc = p.ppid
            skip = False
            depth = 0
            while anc > 1 and depth < 30:
                if anc in agent_pids:
                    skip = True
                    break
                ap = procs.get(anc)
                if ap is None:
                    break
                anc = ap.ppid
                depth += 1
            if skip:
                continue
            noise = bool(AGENT_NOISE.search(" " + (sub or "")))
            tty = p.tty
            panes = self._tmux_panes() if tty else {}
            found.append({
                "pid": pid, "type": kind, "cmd": truncate(" ".join(cmd), 240), "args": truncate(sub, 120), "cwd": proc_cwd(pid),
                "started": p.start_epoch(), "tty": tty, "tmux_target": panes.get(tty), "cpu": p.cpu, "rss": p.rss,
                "background": noise, "user": self.hello.get("user"),
            })
        found.sort(key=lambda x: (x["background"], -x["started"]))
        return found


# --------------------------------------------------------------------------- misc services: git, fs

def git_status(cwd):
    git = which("git")
    if not git:
        return {"available": False, "error": "git not installed"}
    if not os.path.isdir(cwd):
        return {"available": False, "error": "directory not found"}
    rc, out, err = run_cmd([git, "rev-parse", "--show-toplevel"], cwd=cwd, timeout=5)
    if rc != 0:
        return {"available": False, "repo": False, "error": "not a git repository", "detail": err.strip()}
    top = out.strip()
    rc, out, err = run_cmd([git, "status", "--porcelain=v2", "--branch"], cwd=cwd, timeout=10)
    branch = {"head": None, "upstream": None, "ahead": 0, "behind": 0}
    files = []
    for line in out.splitlines():
        if line.startswith("# branch.head"):
            branch["head"] = line.split(" ", 2)[2]
        elif line.startswith("# branch.upstream"):
            branch["upstream"] = line.split(" ", 2)[2]
        elif line.startswith("# branch.ab"):
            parts = line.split()
            branch["ahead"] = int(parts[2].lstrip("+"))
            branch["behind"] = int(parts[3].lstrip("-"))
        elif line.startswith("1 ") or line.startswith("2 "):
            parts = line.split(" ")
            xy = parts[1]
            path = line.split("\t")[0].split(" ", 8)[-1] if line.startswith("1 ") else line.split("\t")[-1]
            files.append({"xy": xy, "path": path, "staged": xy[0] != ".", "unstaged": xy[1] != "."})
        elif line.startswith("u "):
            files.append({"xy": "UU", "path": line.split(" ", 10)[-1], "staged": False, "unstaged": True, "conflict": True})
        elif line.startswith("? "):
            files.append({"xy": "??", "path": line[2:], "staged": False, "unstaged": True, "untracked": True})
    rc, log_out, _ = run_cmd([git, "log", "-8", "--pretty=format:%h%x1f%an%x1f%ar%x1f%s"], cwd=cwd, timeout=5)
    commits = []
    for line in log_out.splitlines():
        f = line.split("\x1f")
        if len(f) == 4:
            commits.append({"hash": f[0], "author": f[1], "when": f[2], "subject": f[3]})
    rc, diff_out, _ = run_cmd([git, "diff", "--shortstat"], cwd=cwd, timeout=5)
    rc, diff_staged, _ = run_cmd([git, "diff", "--cached", "--shortstat"], cwd=cwd, timeout=5)
    return {"available": True, "repo": True, "top": top, "branch": branch, "files": files[:500], "file_count": len(files),
            "commits": commits, "diff": diff_out.strip(), "diff_staged": diff_staged.strip()}


def git_diff(cwd, path=None, staged=False):
    git = which("git")
    argv = [git, "diff", "--no-color"] + (["--cached"] if staged else []) + (["--", path] if path else [])
    rc, out, err = run_cmd(argv, cwd=cwd, timeout=10)
    if len(out) > 400000:
        out = out[:400000] + "\n... (truncated)"
    return {"diff": out, "error": err.strip() if rc != 0 else None}


def fs_list(path, show_hidden=False):
    path = os.path.expanduser(path or "~")
    path = os.path.abspath(path)
    entries = []
    try:
        names = sorted(os.listdir(path), key=lambda x: x.lower())
    except OSError as e:
        return {"path": path, "error": str(e), "entries": []}
    for n in names:
        if n.startswith(".") and not show_hidden:
            continue
        full = os.path.join(path, n)
        try:
            st = os.stat(full)
        except OSError:
            continue
        isdir = os.path.isdir(full)
        e = {"name": n, "dir": isdir, "size": st.st_size, "mtime": st.st_mtime}
        if isdir:
            e["git"] = os.path.isdir(os.path.join(full, ".git"))
        entries.append(e)
    entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    return {"path": path, "parent": os.path.dirname(path) if path != "/" else None, "entries": entries[:2000],
            "git": os.path.isdir(os.path.join(path, ".git"))}


# --------------------------------------------------------------------------- RPC server

class Client(object):
    def __init__(self, server, conn, cid):
        self.server = server
        self.conn = conn
        self.id = cid
        self.subscribed = False
        self.sessions = set()      # sessions we receive output for
        self.wlock = threading.Lock()
        self.alive = True
        self.name = "client-%d" % cid

    def send(self, obj):
        if not self.alive:
            return
        try:
            data = (json.dumps(obj, separators=(",", ":")) + "\n").encode("utf-8")
        except (TypeError, ValueError) as e:
            data = (json.dumps({"ev": "error", "error": "unserializable message: %s" % e}) + "\n").encode()
        with self.wlock:
            try:
                self.conn.sendall(data)
            except OSError:
                self.alive = False
                self.server.drop_client(self)

    def serve(self):
        buf = b""
        try:
            while self.alive:
                try:
                    chunk = self.conn.recv(1 << 16)
                except OSError:
                    break
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    self.handle_line(line)
        finally:
            self.alive = False
            self.server.drop_client(self)
            try:
                self.conn.close()
            except OSError:
                pass

    def handle_line(self, line):
        try:
            req = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            self.send({"ev": "error", "error": "bad json"})
            return
        rid = req.get("id")
        op = req.get("op")
        try:
            result = self.server.dispatch(self, op, req)
            self.send({"id": rid, "ok": True, "result": result})
        except Exception as e:
            if not isinstance(e, ValueError):
                log("op %s failed: %s", op, traceback.format_exc())
            self.send({"id": rid, "ok": False, "error": str(e) or e.__class__.__name__})


class Server(object):
    def __init__(self):
        self.clients = set()
        self.clock = threading.Lock()
        self.sm = SessionManager(self)
        self.monitor = Monitor(self)
        self.next_cid = 1
        self.stopping = False

    # ----- broadcast

    def broadcast(self, msg, only_subscribed=False):
        with self.clock:
            clients = list(self.clients)
        for c in clients:
            if only_subscribed and not c.subscribed:
                continue
            c.send(msg)

    def drop_client(self, c):
        with self.clock:
            self.clients.discard(c)
        with self.sm.lock:
            for s in self.sm.sessions.values():
                s.subscribers.discard(c)

    # ----- dispatch

    def dispatch(self, c, op, req):
        sm = self.sm
        if op == "hello":
            c.name = req.get("client") or c.name
            return dict(self.monitor.hello, now=time.time())
        if op == "ping":
            return {"pong": time.time()}
        if op == "subscribe":
            c.subscribed = True
            return self.snapshot()
        if op == "unsubscribe":
            c.subscribed = False
            return True
        if op == "state":
            return self.snapshot()
        if op == "session.list":
            with sm.lock:
                return [s.to_dict() for s in sm.sessions.values()]
        if op == "session.create":
            s = sm.create(dict(req.get("spec") or {}))
            return s.to_dict()
        if op == "session.get":
            return sm.get(req["session"]).to_dict()
        if op == "session.attach":
            s = sm.get(req["session"])
            with s.lock:
                s.subscribers.add(c)
                c.sessions.add(s.id)
                data = s.buffer.bytes()
            if req.get("cols") and req.get("rows"):
                sm.resize(s.id, req["cols"], req["rows"])
            return {"scrollback": b64e(data), "session": s.to_dict(with_activity=False)}
        if op == "session.detach":
            s = sm.get(req["session"])
            with s.lock:
                s.subscribers.discard(c)
            c.sessions.discard(s.id)
            return True
        if op == "session.input":
            sm.write(req["session"], b64d(req.get("data") or ""))
            return True
        if op == "session.resize":
            sm.resize(req["session"], req.get("cols") or 80, req.get("rows") or 24)
            return True
        if op == "session.signal":
            return sm.signal(req["session"], req.get("signal") or "TERM", tree=req.get("tree", True))
        if op == "session.stop":
            return sm.stop(req["session"], force=bool(req.get("force")))
        if op == "session.restart":
            return sm.restart(req["session"]).to_dict()
        if op == "session.remove":
            return sm.remove(req["session"], force=bool(req.get("force")))
        if op == "session.rename":
            s = sm.get(req["session"])
            s.name = (req.get("name") or s.name).strip()[:80]
            sm.save_registry()
            return s.to_dict(with_activity=False)
        if op == "session.logs":
            s = sm.get(req["session"])
            n = int(req.get("tail") or 262144)
            with s.lock:
                data = s.buffer.bytes()[-n:]
            if req.get("file"):
                lp = os.path.join(LOGS_DIR, "%s.log" % s.id)
                data = (read_file(lp, b"", binary=True) or data)[-n:]
            return {"data": b64e(data), "bytes": len(data)}
        if op == "session.clear":
            s = sm.get(req["session"])
            with s.lock:
                s.buffer.clear()
            return True
        if op == "adopt":
            pid = int(req["pid"])
            with sm.lock:
                for s in sm.sessions.values():
                    if s.adopted and s.adopted_pid == pid:
                        return s.to_dict()
            info = next((d for d in self.monitor.discovered if d["pid"] == pid), None)
            cmd = proc_cmdline(pid)
            kind, _ = classify_agent(cmd)
            spec = {"adopted": True, "pid": pid, "type": req.get("type") or (info or {}).get("type") or kind or "custom",
                    "name": req.get("name") or ("%s #%d" % ((info or {}).get("type") or kind or "process", pid)),
                    "cwd": req.get("cwd") or (info or {}).get("cwd") or proc_cwd(pid), "workspace": req.get("workspace"),
                    "tmux_target": (info or {}).get("tmux_target"), "meta": req.get("meta") or {}}
            s = sm.create(spec)
            self.monitor.last_discovery = 0
            return s.to_dict()
        if op == "process.signal":
            pid = int(req["pid"])
            sig = getattr(signal, "SIG" + (req.get("signal") or "TERM").upper().replace("SIG", ""))
            os.kill(pid, sig)
            return True
        if op == "process.tree":
            procs = scan_procs()
            root = int(req.get("pid") or 1)
            pids = [root] + descendants(procs, root)
            return [{"pid": p, "ppid": procs[p].ppid, "name": procs[p].comm, "cmd": truncate(" ".join(proc_cmdline(p)), 240), "rss": procs[p].rss, "cpu": procs[p].cpu}
                    for p in pids if p in procs]
        if op == "discover":
            self.monitor.discovered = self.monitor.discover(scan_procs())
            return self.monitor.discovered
        if op == "resources":
            return self.monitor.res.sample_system()
        if op == "tools.rescan":
            return self.monitor.rescan_tools()
        if op == "git.status":
            return git_status(os.path.expanduser(req.get("cwd") or "~"))
        if op == "git.diff":
            return git_diff(os.path.expanduser(req.get("cwd") or "~"), req.get("path"), bool(req.get("staged")))
        if op == "fs.list":
            return fs_list(req.get("path") or "~", bool(req.get("hidden")))
        if op == "fs.home":
            return {"home": os.path.expanduser("~")}
        if op == "fs.mkdir":
            p = os.path.abspath(os.path.expanduser(req["path"]))
            os.makedirs(p, exist_ok=True)
            return {"path": p}
        if op == "exec":
            argv = req.get("argv")
            if not argv:
                argv = [os.environ.get("SHELL") or "/bin/sh", "-lc", req.get("command") or "true"]
            rc, out, err = run_cmd(argv, timeout=float(req.get("timeout") or 30), cwd=req.get("cwd"))
            return {"rc": rc, "stdout": out[-200000:], "stderr": err[-50000:]}
        if op == "shutdown":
            running = [s.id for s in sm.sessions.values() if s.status == "running"]
            if running and not req.get("force"):
                raise ValueError("%d session(s) still running" % len(running))
            self.stopping = True
            threading.Timer(0.2, lambda: os.kill(HELPER_PID, signal.SIGTERM)).start()
            return {"stopping": True}
        raise ValueError("unknown op: %s" % op)

    def snapshot(self):
        with self.sm.lock:
            sessions = [s.to_dict() for s in self.sm.sessions.values()]
        return {"ev": "state", "ts": time.time(), "host": self.monitor.hello, "resources": self.monitor.res.sample_system(),
                "sessions": sessions, "discovered": self.monitor.discovered}

    # ----- main loop

    def serve_forever(self):
        global HELPER_PID
        HELPER_PID = os.getpid()
        self.monitor.hello["pid"] = HELPER_PID
        os.makedirs(AM_DIR, exist_ok=True)
        try:
            os.chmod(AM_DIR, 0o700)
        except OSError:
            pass
        if os.path.exists(SOCK_PATH):
            os.unlink(SOCK_PATH)
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(SOCK_PATH)
        os.chmod(SOCK_PATH, 0o600)
        srv.listen(16)
        with open(PID_PATH, "w") as f:
            f.write(str(HELPER_PID))
        self.sm.load_registry()
        self.monitor.start()
        log("helper %s listening on %s (pid %d, subreaper=%s)", VERSION, SOCK_PATH, HELPER_PID, self.monitor.subreaper)

        def on_term(signum, frame):
            log("signal %s received, shutting down", signum)
            self.stopping = True
            try:
                srv.close()
            except OSError:
                pass
            try:
                os.unlink(SOCK_PATH)
            except OSError:
                pass
            try:
                os.unlink(PID_PATH)
            except OSError:
                pass
            os._exit(0)

        signal.signal(signal.SIGTERM, on_term)
        signal.signal(signal.SIGINT, on_term)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)
        while not self.stopping:
            try:
                conn, _ = srv.accept()
            except OSError:
                if self.stopping:
                    break
                continue
            with self.clock:
                cid = self.next_cid
                self.next_cid += 1
                c = Client(self, conn, cid)
                self.clients.add(c)
            t = threading.Thread(target=c.serve, name="client-%d" % cid)
            t.daemon = True
            t.start()


# --------------------------------------------------------------------------- CLI

def probe():
    """Connect to a running helper and return its hello dict (or None)."""
    if not os.path.exists(SOCK_PATH):
        return None
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(3)
        s.connect(SOCK_PATH)
        s.sendall(b'{"id":1,"op":"hello","client":"probe"}\n')
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        s.close()
        resp = json.loads(buf.split(b"\n")[0].decode())
        return resp.get("result")
    except Exception:
        return None


def rpc(op, **kw):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(10)
    s.connect(SOCK_PATH)
    req = dict(kw, id=1, op=op)
    s.sendall((json.dumps(req) + "\n").encode())
    buf = b""
    while b"\n" not in buf:
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    s.close()
    return json.loads(buf.split(b"\n")[0].decode())


def daemonize():
    os.makedirs(AM_DIR, exist_ok=True)
    sys.stdout.flush()
    sys.stderr.flush()
    if os.fork() > 0:
        return False
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    os.chdir("/")
    os.umask(0o077)
    sys.stdout.flush()
    sys.stderr.flush()
    logf = open(LOG_PATH, "ab")
    devnull = open(os.devnull, "rb")
    os.dup2(devnull.fileno(), 0)
    os.dup2(logf.fileno(), 1)
    os.dup2(logf.fileno(), 2)
    # keep log bounded
    try:
        if os.path.getsize(LOG_PATH) > 4 * 1024 * 1024:
            os.truncate(LOG_PATH, 0)
    except OSError:
        pass
    return True


def cmd_start(foreground=False):
    h = probe()
    if h:
        print(json.dumps({"running": True, "version": h["version"], "pid": h["pid"], "started_now": False}))
        return 0
    if os.path.exists(SOCK_PATH):
        os.unlink(SOCK_PATH)
    if foreground:
        Server().serve_forever()
        return 0
    if daemonize():
        Server().serve_forever()
        os._exit(0)
    # parent: wait until the socket answers
    for _ in range(60):
        time.sleep(0.1)
        h = probe()
        if h:
            print(json.dumps({"running": True, "version": h["version"], "pid": h["pid"], "started_now": True}))
            return 0
    print(json.dumps({"running": False, "error": "helper did not come up; see " + LOG_PATH}))
    return 1


def cmd_stop(force=False, quiet=False):
    out = (lambda *a: None) if quiet else print
    h = probe()
    if not h:
        out(json.dumps({"running": False}))
        return 0
    try:
        r = rpc("shutdown", force=force)
        if not r.get("ok"):
            out(json.dumps({"running": True, "error": r.get("error")}))
            return 2
    except Exception as e:
        try:
            os.kill(h["pid"], signal.SIGTERM)
        except Exception:
            out(json.dumps({"running": True, "error": str(e)}))
            return 2
    for _ in range(50):
        time.sleep(0.1)
        if not probe():
            out(json.dumps({"running": False, "stopped": True}))
            return 0
    out(json.dumps({"running": True, "error": "did not stop"}))
    return 2


def cmd_ensure():
    """Used by the control plane after uploading a (possibly newer) helper file.
    Starts the helper if needed; upgrades it when the running version differs and no session is running."""
    h = probe()
    if h and (h.get("sha") or h["version"]) == (SELF_SHA if h.get("sha") else VERSION):
        print(json.dumps({"running": True, "version": VERSION, "pid": h["pid"], "upgraded": False}))
        return 0
    if h:
        try:
            r = rpc("session.list")
            running = [s for s in (r.get("result") or []) if s.get("status") == "running"]
        except Exception:
            running = []
        if running:
            print(json.dumps({"running": True, "version": h["version"], "pid": h["pid"], "upgrade_pending": VERSION,
                              "reason": "%d session(s) running" % len(running)}))
            return 0
        cmd_stop(force=True, quiet=True)
    return cmd_start()


def cmd_relay():
    """stdio <-> unix socket bridge (fallback when SSH streamlocal forwarding is disabled)."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(SOCK_PATH)
    s.setblocking(False)
    stdin = sys.stdin.buffer if hasattr(sys.stdin, "buffer") else sys.stdin
    stdout = sys.stdout.buffer if hasattr(sys.stdout, "buffer") else sys.stdout
    fdin, fdout = stdin.fileno(), stdout.fileno()
    fcntl.fcntl(fdin, fcntl.F_SETFL, fcntl.fcntl(fdin, fcntl.F_GETFL) | os.O_NONBLOCK)
    pending_out = b""
    pending_sock = b""
    while True:
        rl = [s, fdin]
        wl = []
        if pending_out:
            wl.append(fdout)
        if pending_sock:
            wl.append(s)
        r, w, _ = select.select(rl, wl, [], 30)
        if s in r:
            try:
                data = s.recv(1 << 16)
            except (BlockingIOError, InterruptedError):
                data = None
            if data == b"":
                break
            if data:
                pending_out += data
        if fdin in r:
            try:
                data = os.read(fdin, 1 << 16)
            except (BlockingIOError, InterruptedError):
                data = None
            if data == b"":
                break
            if data:
                pending_sock += data
        if fdout in w and pending_out:
            try:
                n = os.write(fdout, pending_out)
                pending_out = pending_out[n:]
            except (BlockingIOError, InterruptedError):
                pass
        if s in w and pending_sock:
            try:
                n = s.send(pending_sock)
                pending_sock = pending_sock[n:]
            except (BlockingIOError, InterruptedError):
                pass
    return 0


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "start"
    if cmd in ("version", "--version", "-v"):
        print(VERSION)
        return 0
    if cmd == "start":
        return cmd_start()
    if cmd == "run":
        return cmd_start(foreground=True)
    if cmd == "stop":
        return cmd_stop(force="--force" in argv)
    if cmd == "ensure":
        return cmd_ensure()
    if cmd == "status":
        h = probe()
        print(json.dumps({"running": bool(h), "version": h["version"] if h else None, "pid": h["pid"] if h else None, "sock": SOCK_PATH}))
        return 0 if h else 3
    if cmd == "relay":
        return cmd_relay()
    if cmd == "rpc":
        op = argv[2]
        kw = json.loads(argv[3]) if len(argv) > 3 else {}
        print(json.dumps(rpc(op, **kw), indent=2))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
