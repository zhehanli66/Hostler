#!/usr/bin/env python3
"""Smoke test for hostler_helper.py: runs an isolated helper and exercises the RPC surface."""
import base64, json, os, socket, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "hostler_helper.py")
TMP = tempfile.mkdtemp(prefix="am-test-")
ENV = dict(os.environ, HOSTLER_DIR=TMP)
SOCK = os.path.join(TMP, "helper.sock")


class RPC:
    def __init__(self):
        self.s = socket.create_connection if False else None
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(SOCK)
        self.sock.settimeout(10)
        self.buf = b""
        self.n = 0
        self.events = []

    def _readline(self):
        while b"\n" not in self.buf:
            chunk = self.sock.recv(1 << 16)
            if not chunk:
                raise RuntimeError("closed")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return json.loads(line.decode())

    def call(self, op, **kw):
        self.n += 1
        req = dict(kw, id=self.n, op=op)
        self.sock.sendall((json.dumps(req) + "\n").encode())
        while True:
            o = self._readline()
            if o.get("id") == self.n:
                if not o.get("ok"):
                    raise RuntimeError("%s failed: %s" % (op, o.get("error")))
                return o["result"]
            self.events.append(o)

    def wait_event(self, pred, timeout=10):
        deadline = time.time() + timeout
        for e in self.events:
            if pred(e):
                return e
        while time.time() < deadline:
            self.sock.settimeout(max(0.1, deadline - time.time()))
            try:
                o = self._readline()
            except socket.timeout:
                break
            self.events.append(o)
            if pred(o):
                return o
        return None


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        global failures
        failures += 1


failures = 0
print("helper dir:", TMP)
out = subprocess.check_output([sys.executable, HELPER, "start"], env=ENV).decode()
print("start ->", out.strip())
check(json.loads(out)["running"], "helper started")

c = RPC()
hello = c.call("hello", client="test")
check(hello["version"], "hello version=%s subreaper=%s tools=%s" % (hello["version"], hello["subreaper"], {k: bool(v) for k, v in hello["tools"].items()}))
snap = c.call("subscribe")
check("resources" in snap and snap["resources"]["mem_total"] > 0, "subscribe snapshot has resources (cpu=%s%% mem_used=%dMB gpus=%d)" % (
    snap["resources"]["cpu_pct"], snap["resources"]["mem_used"] // 2**20, len(snap["resources"]["gpus"])))

# shell session
s = c.call("session.create", spec={"type": "shell", "name": "test-shell", "cwd": TMP, "cols": 100, "rows": 30})
sid = s["id"]
check(s["status"] == "running" and s["pid"], "shell session created pid=%s" % s["pid"])
att = c.call("session.attach", session=sid, cols=100, rows=30)
check("scrollback" in att, "attach returns scrollback (%d bytes)" % len(base64.b64decode(att["scrollback"])))
# wait for the shell prompt before typing (typeahead during zsh/oh-my-zsh init is unreliable)
c.wait_event(lambda e: e.get("ev") == "output" and e.get("session") == sid and b"\x1b[?2004h" in base64.b64decode(e["data"]), timeout=6)
time.sleep(0.3)
# sentinels are computed by the shell so the echoed input line can never match the awaited output (bash echoes
# the typed line followed by \r\n, zsh redraws it; both would otherwise produce a false "DONE\r\n" early)
c.call("session.input", session=sid, data=base64.b64encode(b"echo MARK''ER_$((40+2)); sleep 30 & sleep 0.2; setsid sleep 31 & disown; echo D''ONE\n").decode())
got = b""
deadline = time.time() + 8
while time.time() < deadline and b"DONE\r\n" not in got:
    e = c.wait_event(lambda e: e.get("ev") == "output" and e.get("session") == sid, timeout=2)
    if e:
        got += base64.b64decode(e["data"])
        c.events.remove(e)
check(b"MARKER_42" in got, "pty output received (%d bytes)" % len(got))
if b"MARKER_42" not in got:
    print("     GOT:", got[-300:])
    lf = open(os.path.join(TMP, "logs", sid + ".log"), "rb").read()
    print("     LOGFILE has MARKER:", b"MARKER_42" in lf, "len", len(lf), "events kept:", len(c.events))

# process attribution incl. detached child
st = c.wait_event(lambda e: e.get("ev") == "state" and any(x["id"] == sid and len(x["processes"]) >= 3 for x in e["sessions"]), timeout=6)
check(st is not None, "state event lists session processes")
if st:
    sess = next(x for x in st["sessions"] if x["id"] == sid)
    names = [p["name"] for p in sess["processes"]]
    check(names.count("sleep") >= 2, "process tree contains both sleeps: %s" % names)
    print("     processes:", [(p["pid"], p["name"], p["detached"]) for p in sess["processes"]])

# now kill the shell (parent) and ensure the setsid'd sleep stays attributed (subreaper)
c.call("session.signal", session=sid, signal="HUP", tree=False)
ex = c.wait_event(lambda e: e.get("ev") == "session.exit" and e.get("id") == sid, timeout=8)
check(ex is not None, "session.exit received after SIGHUP: %s" % (ex and ex.get("exit_code")))
c.events = []
st2 = c.wait_event(lambda e: e.get("ev") == "state" and any(x["id"] == sid for x in e["sessions"]), timeout=6)
if st2:
    sess = next(x for x in st2["sessions"] if x["id"] == sid)
    det = [p for p in sess["processes"] if p["name"] == "sleep"]
    check(len(det) >= 1 and all(p["detached"] for p in det), "detached sleeps still attributed after parent exit: %s" % [(p["pid"], p["detached"]) for p in det])
    logs = base64.b64decode(c.call("session.logs", session=sid)["data"])
    check(b"MARKER_42" in logs and b"exited" in logs, "logs contain output and exit footer")
    r = c.call("session.signal", session=sid, signal="KILL", tree=True)
    check(r["signalled"] >= 1, "tree kill signalled %d" % r["signalled"])

# restart
s2 = c.call("session.restart", session=sid)
check(s2["status"] == "running" and s2["restarts"] == 1, "restart works (pid=%s)" % s2["pid"])
c.call("session.stop", session=sid)
c.wait_event(lambda e: e.get("ev") == "session.exit" and e.get("id") == sid, timeout=10)
check(c.call("session.remove", session=sid) is True, "session removed")

# custom command + exit code + cwd check
s3 = c.call("session.create", spec={"type": "custom", "name": "custom", "cwd": TMP, "command": "pwd; exit 7"})
ex = c.wait_event(lambda e: e.get("ev") == "session.exit" and e.get("id") == s3["id"], timeout=10)
check(ex and ex["exit_code"] == 7, "custom command exit code propagated: %s" % (ex and ex["exit_code"]))
logs = base64.b64decode(c.call("session.logs", session=s3["id"])["data"])
check(TMP.encode() in logs, "custom command ran in requested cwd")

# claude session spec builds command with --session-id (won't actually run claude here)
s4 = c.call("session.create", spec={"type": "claude", "name": "claude-test", "cwd": TMP})
check("--session-id" in s4["command"] and s4["meta"].get("claude_session_id"), "claude command: %s" % s4["command"])
c.wait_event(lambda e: e.get("ev") == "session.exit" and e.get("id") == s4["id"], timeout=15)
c.call("session.remove", session=s4["id"], force=True)

# misc services
fs = c.call("fs.list", path=os.path.expanduser("~"))
check(fs["path"] == os.path.expanduser("~") and isinstance(fs["entries"], list), "fs.list home (%d entries)" % len(fs["entries"]))
subprocess.run(["git", "init", "-q", os.path.join(TMP, "repo")], check=True)
open(os.path.join(TMP, "repo", "a.txt"), "w").write("x")
g = c.call("git.status", cwd=os.path.join(TMP, "repo"))
check(g["repo"] and any(f["path"] == "a.txt" for f in g["files"]), "git.status sees untracked file (branch=%s)" % g["branch"]["head"])
disc = c.call("discover")
check(isinstance(disc, list), "discover -> %d foreign agent process(es): %s" % (len(disc), [(d["pid"], d["type"], d["args"]) for d in disc][:4]))
res = c.call("resources")
check(res["cores"] >= 1, "resources cores=%s gpus=%s" % (res["cores"], [(x["name"], x["util"]) for x in res["gpus"]]))
r = c.call("exec", command="echo via-exec")
check("via-exec" in r["stdout"], "exec op")

# ensure (same version) keeps it running; shutdown
out = subprocess.check_output([sys.executable, HELPER, "ensure"], env=ENV).decode()
check(json.loads(out)["running"] and not json.loads(out).get("upgraded"), "ensure -> " + out.strip())
try:
    c.call("shutdown")
except RuntimeError as e:
    print("  (shutdown refused: %s)" % e)
    c.call("shutdown", force=True)
time.sleep(0.6)
check(not os.path.exists(SOCK), "socket removed after shutdown")
print("\nhelper log tail:")
print(open(os.path.join(TMP, "helper.log")).read()[-1500:])
print("FAILURES:", failures)
sys.exit(1 if failures else 0)
