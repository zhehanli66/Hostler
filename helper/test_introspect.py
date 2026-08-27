#!/usr/bin/env python3
"""Unit test for the transcript introspectors using synthetic fixtures (no real agent data needed)."""
import json, os, sys, tempfile, time

HOME = tempfile.mkdtemp(prefix="hostler-introspect-")
os.environ["HOME"] = HOME                      # introspectors resolve ~ at import time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hostler_helper as H  # noqa: E402

failures = 0
def check(cond, msg):
    global failures
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: failures += 1

def jsonl(path, records):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for r in records: f.write(json.dumps(r) + "\n")

# ----------------------------------------------------------------- Claude Code
cwd = os.path.join(HOME, "proj", "demo-app")
os.makedirs(cwd)
sid = "11111111-2222-3333-4444-555555555555"
proj = os.path.join(HOME, ".claude", "projects", H.encode_claude_project(cwd))
main = [
    {"type": "user", "timestamp": "2026-01-01T10:00:00Z", "message": {"role": "user", "content": "Fix the failing tests"}, "sessionId": sid},
    {"type": "ai-title", "aiTitle": "Fix failing tests"},
    {"type": "assistant", "timestamp": "2026-01-01T10:00:05Z", "message": {"role": "assistant", "model": "claude-x", "usage": {"input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 5000},
        "content": [{"type": "text", "text": "Let me look."}, {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "npm test"}}]}},
    {"type": "user", "timestamp": "2026-01-01T10:00:09Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "1 failing"}]}},
    {"type": "assistant", "timestamp": "2026-01-01T10:00:12Z", "message": {"role": "assistant", "model": "claude-x",
        "content": [{"type": "tool_use", "id": "t2", "name": "Agent", "input": {"description": "Find the bug", "subagent_type": "Explore", "prompt": "..."}}]}},
    {"type": "user", "timestamp": "2026-01-01T10:00:13Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t2", "content": [{"type": "text", "text": "Async agent launched successfully.\nagentId: abc123 (internal)"}]}]}},
    {"type": "assistant", "timestamp": "2026-01-01T10:00:20Z", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t3", "name": "Read", "input": {"file_path": "/x/y.ts"}}]}},
]
jsonl(os.path.join(proj, sid + ".jsonl"), main)
sub = [
    {"type": "user", "isSidechain": True, "agentId": "abc123", "timestamp": "2026-01-01T10:00:14Z", "message": {"role": "user", "content": "Find the bug"}},
    {"type": "assistant", "isSidechain": True, "agentId": "abc123", "timestamp": "2026-01-01T10:00:15Z", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "s1", "name": "Grep", "input": {"pattern": "TODO"}}]}},
]
jsonl(os.path.join(proj, sid, "subagents", "agent-abc123.jsonl"), sub)
with open(os.path.join(proj, sid, "subagents", "agent-abc123.meta.json"), "w") as f:
    json.dump({"agentType": "Explore", "description": "Find the bug", "toolUseId": "t2"}, f)

ci = H.ClaudeIntrospector(cwd, session_id=sid, started=0)
ci.poll(); d = ci.to_dict()
check(d["kind"] == "claude" and d["title"] == "Fix failing tests", "claude: title parsed")
check(d["status"] == "tool" and d["current_tool"]["name"] == "Read" and d["current_tool"]["summary"] == "/x/y.ts", "claude: pending tool Read with file path")
check(d["model"] == "claude-x" and d["usage"]["cache_read"] == 5000 and d["tool_calls"] == 3 and d["turns"] == 1, "claude: model/usage/counters")
check(d["last_prompt"] == "Fix the failing tests", "claude: last prompt")
check(len(d["subagents"]) == 1 and d["subagents"][0]["type"] == "Explore" and d["subagents"][0]["status"] == "running", "claude: async subagent linked and running")
check(d["subagents"][0]["activity"]["current_tool"]["name"] == "Grep", "claude: subagent current tool from its own transcript")
# incremental tail: append a final assistant text -> idle
with open(os.path.join(proj, sid + ".jsonl"), "a") as f:
    f.write(json.dumps({"type": "user", "timestamp": "2026-01-01T10:00:21Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t3", "content": "..."}]}}) + "\n")
    f.write(json.dumps({"type": "assistant", "timestamp": "2026-01-01T10:00:25Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "Done, tests pass."}]}}) + "\n")
ci.poll(); d = ci.to_dict()
check(d["status"] == "idle" and d["last_text"] == "Done, tests pass.", "claude: incremental tail -> idle with last message")
# auto-locate newest transcript when session id unknown (adopted process)
ci2 = H.ClaudeIntrospector(cwd, started=0); ci2.poll()
check(ci2.session_id == sid, "claude: auto-located transcript by cwd")

# ----------------------------------------------------------------- Codex
day = os.path.join(HOME, ".codex", "sessions", "2026", "01", "01")
cx_id = "01900000-0000-7000-8000-000000000001"
codex = [
    {"timestamp": "2026-01-01T11:00:00Z", "type": "session_meta", "payload": {"id": cx_id, "cwd": cwd, "thread_source": "user", "originator": "codex_cli"}},
    {"timestamp": "2026-01-01T11:00:01Z", "type": "turn_context", "payload": {"model": "gpt-x"}},
    {"timestamp": "2026-01-01T11:00:02Z", "type": "event_msg", "payload": {"type": "user_message", "message": "Add a README"}},
    {"timestamp": "2026-01-01T11:00:02Z", "type": "event_msg", "payload": {"type": "task_started", "turn_id": "t"}},
    {"timestamp": "2026-01-01T11:00:03Z", "type": "response_item", "payload": {"type": "function_call", "call_id": "c1", "name": "shell", "arguments": json.dumps({"command": ["ls", "-la"]})}},
    {"timestamp": "2026-01-01T11:00:04Z", "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 500, "output_tokens": 50, "cached_input_tokens": 100, "total_tokens": 550}}}},
]
jsonl(os.path.join(day, "rollout-2026-01-01T11-00-00-" + cx_id + ".jsonl"), codex)
sub_id = "01900000-0000-7000-8000-000000000002"
jsonl(os.path.join(day, "rollout-2026-01-01T11-00-05-" + sub_id + ".jsonl"), [
    {"timestamp": "2026-01-01T11:00:05Z", "type": "session_meta", "payload": {"id": sub_id, "cwd": cwd, "thread_source": "subagent", "parent_thread_id": cx_id, "source": {"subagent": {"other": "reviewer"}}}},
    {"timestamp": "2026-01-01T11:00:06Z", "type": "event_msg", "payload": {"type": "user_message", "message": "Review the diff"}},
    {"timestamp": "2026-01-01T11:00:06Z", "type": "event_msg", "payload": {"type": "task_started"}},
])
with open(os.path.join(HOME, ".codex", "session_index.jsonl"), "w") as f:
    f.write(json.dumps({"id": cx_id, "thread_name": "Add README", "updated_at": "2026-01-01T11:00:00Z"}) + "\n")
co = H.CodexIntrospector(cwd, started=0); co.poll(); co.last_sub_scan = 0; co.poll(); d = co.to_dict()
check(co.session_id == cx_id, "codex: located session by cwd")
check(d["status"] == "tool" and d["current_tool"]["name"] == "shell" and d["current_tool"]["summary"] == "ls -la", "codex: pending shell call with command")
check(d["model"] == "gpt-x" and d["usage"]["total"] == 550 and d["title"] == "Add README", "codex: model/usage/title")
check(len(d["subagents"]) == 1 and d["subagents"][0]["type"] == "reviewer" and d["subagents"][0]["status"] == "running", "codex: subagent thread via parent_thread_id")
with open(os.path.join(day, "rollout-2026-01-01T11-00-00-" + cx_id + ".jsonl"), "a") as f:
    f.write(json.dumps({"timestamp": "2026-01-01T11:00:07Z", "type": "response_item", "payload": {"type": "function_call_output", "call_id": "c1", "output": "ok"}}) + "\n")
    f.write(json.dumps({"timestamp": "2026-01-01T11:00:09Z", "type": "event_msg", "payload": {"type": "task_complete", "last_agent_message": "README added."}}) + "\n")
co.poll(); d = co.to_dict()
check(d["status"] == "idle" and d["last_text"] == "README added.", "codex: task_complete -> idle")

# ----------------------------------------------------------------- OpenCode
st = os.path.join(HOME, ".local", "share", "opencode", "storage")
def jdump(p, o):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f: json.dump(o, f)
now = int(time.time() * 1000)
jdump(os.path.join(st, "session", "p1", "ses_1.json"), {"id": "ses_1", "projectID": "p1", "directory": cwd, "title": "Refactor auth", "time": {"created": now, "updated": now}})
jdump(os.path.join(st, "session", "p1", "ses_2.json"), {"id": "ses_2", "projectID": "p1", "directory": cwd, "parentID": "ses_1", "title": "child task", "time": {"created": now, "updated": now}})
jdump(os.path.join(st, "message", "ses_1", "msg_1.json"), {"id": "msg_1", "role": "user", "sessionID": "ses_1", "time": {"created": now - 2000}})
jdump(os.path.join(st, "part", "msg_1", "prt_1.json"), {"id": "prt_1", "type": "text", "text": "Refactor the auth module"})
jdump(os.path.join(st, "message", "ses_1", "msg_2.json"), {"id": "msg_2", "role": "assistant", "sessionID": "ses_1", "modelID": "model-z", "time": {"created": now - 1000}, "tokens": {"input": 10, "output": 5, "cache": {"read": 3}}})
jdump(os.path.join(st, "part", "msg_2", "prt_2.json"), {"id": "prt_2", "type": "tool", "tool": "bash", "state": {"status": "running", "title": "run tests", "input": {"command": "pytest"}}})
oc = H.OpenCodeIntrospector(cwd, started=0); d = oc.to_dict()
check(d["kind"] == "opencode" and d["title"] == "Refactor auth", "opencode: session located by directory, title")
check(d["status"] == "tool" and d["current_tool"]["name"] == "bash" and d["current_tool"]["summary"] == "run tests", "opencode: running tool part")
check(d["model"] == "model-z" and d["last_prompt"] == "Refactor the auth module", "opencode: model and prompt")
check(len(d["subagents"]) == 1 and d["subagents"][0]["id"] == "ses_2", "opencode: child session via parentID")

# ----------------------------------------------------------------- resuming an old conversation
cwd_old = os.path.join(HOME, "proj", "old-app")
os.makedirs(cwd_old)
old_day = os.path.join(HOME, ".codex", "sessions", "2020", "01", "01")
old_id = "01800000-0000-7000-8000-0000000000ff"
jsonl(os.path.join(old_day, "rollout-2020-01-01T09-00-00-" + old_id + ".jsonl"), [
    {"timestamp": "2020-01-01T09:00:00Z", "type": "session_meta", "payload": {"id": old_id, "cwd": cwd_old, "thread_source": "user"}},
    {"timestamp": "2020-01-01T09:00:01Z", "type": "event_msg", "payload": {"type": "user_message", "message": "Old thread"}},
])
co_old = H.CodexIntrospector(cwd_old, started=time.time(), session_id=old_id, owner="s8"); co_old.poll()
check(co_old.path and old_id in co_old.path, "resume: codex finds a thread whose rollout predates the recent-day scan")
H.CLAIMS.release("s8")
jdump(os.path.join(st, "session", "p2", "ses_old.json"), {"id": "ses_old", "projectID": "p2", "directory": cwd_old, "title": "Old opencode", "time": {"created": 1, "updated": 1}})
jdump(os.path.join(st, "session", "p2", "ses_new.json"), {"id": "ses_new", "projectID": "p2", "directory": cwd_old, "title": "Newer opencode", "time": {"created": now, "updated": now}})
oc_old = H.OpenCodeIntrospector(cwd_old, started=time.time(), session_id="ses_old", owner="s9")
check(oc_old.locate() and oc_old.session["title"] == "Old opencode", "resume: opencode goes straight to the named session, not the newest one")
H.CLAIMS.release("s9")

# ----------------------------------------------------------------- transcript ownership
co1 = H.CodexIntrospector(cwd, started=0, owner="s1"); co1.poll()
co2 = H.CodexIntrospector(cwd, started=0, owner="s2"); co2.poll()
check(co1.session_id == cx_id and co2.session_id is None, "claims: a second codex agent in the same directory does not steal the first's thread")
H.CLAIMS.release("s1")
co3 = H.CodexIntrospector(cwd, started=0, owner="s3"); co3.poll()
check(co3.session_id == cx_id, "claims: the transcript is free again once its session is gone")
H.CLAIMS.release("s3")
cc1 = H.ClaudeIntrospector(cwd, started=0, owner="s4"); cc1.poll()
cc2 = H.ClaudeIntrospector(cwd, started=0, owner="s5"); cc2.poll()
check(cc1.path and cc2.path is None, "claims: same for two claude agents auto-locating in one directory")
H.CLAIMS.release("s4")
oc1 = H.OpenCodeIntrospector(cwd, started=0, owner="s6"); oc1.locate()
oc2 = H.OpenCodeIntrospector(cwd, started=0, owner="s7"); oc2.locate()
check(oc1.session and not oc2.session, "claims: same for two opencode agents in one directory")
H.CLAIMS.release("s6")
check(H.default_session_name({"type": "codex", "cwd": "/home/u/proj"}) == "Codex in proj", "unnamed sessions get a readable default name")
check(H.build_argv({"type": "codex", "resume": True, "resume_id": cx_id})[2]["session_id"] == cx_id, "resume: codex thread id is handed to the introspector")

# ----------------------------------------------------------------- history (past conversations)
h = H.list_history(cwd)
by = dict((e["type"], e) for e in h)
check(len(h) == 3 and set(by) == {"claude", "codex", "opencode"}, "history: one entry per agent transcript in the directory")
check(by["claude"]["session_id"] == sid and by["claude"]["title"] == "Fix failing tests", "history: claude session id + ai title")
check(by["claude"]["prompt"] == "Fix the failing tests" and by["claude"]["resumable"], "history: claude first prompt")
check(by["codex"]["session_id"] == cx_id and by["codex"]["title"] == "Add README" and by["codex"]["prompt"] == "Add a README", "history: codex user thread (subagent thread excluded)")
check(by["opencode"]["session_id"] == "ses_1" and by["opencode"]["title"] == "Refactor auth", "history: opencode session (child session excluded)")
check([e["type"] for e in H.list_history(cwd, types=["claude"])] == ["claude"], "history: type filter")
check(H.list_history(os.path.join(HOME, "proj")) == [], "history: directory without transcripts -> empty")
check(H.strip_ide_context("# Context from my IDE setup:\n\n## Open tabs:\n- a.ts\n\n## My request:\nfix it\n") == "fix it", "history: IDE preamble stripped from prompt")

# resuming a past conversation
check(H.build_argv({"type": "claude", "resume": True, "resume_id": sid})[1] == "%s --resume %s" % (H.agent_binary("claude"), sid), "resume: claude --resume <id>")
check(H.build_argv({"type": "claude", "cwd": cwd})[2]["claude_session_id"] not in (None, sid), "resume: fresh claude session gets a new --session-id")
check(H.build_argv({"type": "codex", "resume": True, "resume_id": cx_id})[1] == "%s resume %s" % (H.agent_binary("codex"), cx_id), "resume: codex resume <id>")
check(H.build_argv({"type": "opencode", "resume": True, "resume_id": "ses_1"})[1] == "%s --session ses_1" % H.agent_binary("opencode"), "resume: opencode --session <id>")

# ----------------------------------------------------------------- session naming follows the agent
check(ci.conversation_title() == "Fix failing tests" and co.conversation_title() == "Add README" and oc.conversation_title() == "Refactor auth",
      "introspectors expose the conversation title for session naming")
auto = H.Session("sid1", {"type": "claude", "cwd": cwd})
named = H.Session("sid2", {"type": "claude", "cwd": cwd, "name": "my run"})
check(auto.auto_name and auto.name == "Claude Code in demo-app", "an unnamed session starts with a readable default and follows the agent")
check(not named.auto_name and named.name == "my run", "an explicitly named session keeps its name")

# ----------------------------------------------------------------- CLIs bundled in an IDE extension
ext = os.path.join(HOME, ".vscode", "extensions", "anthropic.claude-code-9.9.9-linux-x64", "resources", "native-binary")
os.makedirs(ext)
binp = os.path.join(ext, "claude")
with open(binp, "w") as f:
    f.write("#!/bin/sh\n")
os.chmod(binp, 0o755)
check(H.bundled_agent_bin("claude") == binp, "agent CLI bundled in a VS Code extension is discovered")
H.AGENT_BINS["claude"] = binp
check(H.build_argv({"type": "claude", "cwd": cwd})[1].startswith(binp + " --session-id "), "a session launches the resolved binary, not the bare name")
H.AGENT_BINS.pop("claude", None)

# ----------------------------------------------------------------- cluster login node
bindir = os.path.join(HOME, "fakebin")
os.makedirs(bindir)
def fake(name, body):
    p = os.path.join(bindir, name)
    with open(p, "w") as f:
        f.write("#!/bin/sh\n" + body)
    os.chmod(p, 0o755)
# partition summary rows (sinfo -o), and one row per node x partition (sinfo -N -O): node n3 is down, n4 sits in both partitions
PART_ROWS = "gpu*|up|1|idle|0/64/0/64|gpu:a100:4\ngpu*|up|2|mixed|60/68/0/128|gpu:a100:4\ngpu*|up|1|down*|0/0/64/64|gpu:a100:4\ncpu|up|2|idle|0/128/0/128|(null)\n"
NODE_ROWS = ("n1 gpu* idle 0/64/0/64 gpu:a100:4 gpu:a100:0(IDX:N/A) 512000 0\n"
             "n2 gpu* mixed 30/34/0/64 gpu:a100:4 gpu:a100:3(IDX:0-2) 512000 256000\n"
             "n4 gpu* mixed 30/34/0/64 gpu:a100:4 gpu:a100:1(IDX:0) 512000 128000\n"
             "n3 gpu* down* 0/0/64/64 gpu:a100:4 gpu:a100:0(IDX:N/A) 512000 0\n"
             "n4 cpu mixed 30/34/0/64 gpu:a100:4 gpu:a100:1(IDX:0) 512000 128000\n"
             "n5 cpu idle 0/64/0/64 (null) (null) 256000 0\n")
fake("sinfo", "case \"$*\" in *-N*) cat <<'OUT'\n%sOUT\n;; *) cat <<'OUT'\n%sOUT\n;; esac\n" % (NODE_ROWS, PART_ROWS))
fake("squeue", "cat <<'OUT'\n1842317|gpu|train-resnet|RUNNING|4:21:07|1-00:00:00|1|node[07]\n1842401|gpu|sweep-lr|PENDING|0:00|8:00:00|2|(Resources)\nOUT\n")
os.environ["PATH"] = bindir + os.pathsep + os.environ["PATH"]
c = H.detect_cluster()
check(c and c["kind"] == "slurm", "a machine with scheduler clients is detected as a cluster node")
cs = H.cluster_status()
gpu = [p for p in cs["partitions"] if p["name"] == "gpu"][0]
cpu = [p for p in cs["partitions"] if p["name"] == "cpu"][0]
check(len(cs["partitions"]) == 2 and gpu["default"] and gpu["nodes"] == 4, "sinfo rows are aggregated per partition")
check(gpu["states"] == {"idle": 1, "mixed": 2, "down": 1} and gpu["gres"] == "gpu:a100:4", "node states summed, slurm state suffixes stripped")
check(gpu["cpus"] == {"alloc": 60, "idle": 132, "other": 64, "total": 256}, "cpus: idle excludes the down node, whose cpus are 'other' (%s)" % gpu["cpus"])
check(gpu["gpus"] == {"alloc": 4, "idle": 8, "total": 16}, "gpus: alloc from GresUsed, available excludes the down node (%s)" % gpu["gpus"])
MB = 1024 * 1024
check(gpu["mem"] == {"alloc": 384000 * MB, "avail": 3 * 512000 * MB - 384000 * MB, "total": 4 * 512000 * MB}, "memory: allocated vs available on usable nodes (%s)" % gpu["mem"])
check(gpu["nodes_avail"] == 3 and cpu["nodes_avail"] == 2 and cpu["gpus"]["total"] == 4, "usable node count; a node in two partitions counts in each")
s = cs["summary"]
check(s["nodes"] == {"total": 5, "idle": 2, "avail": 4}, "cluster summary counts every node once (%s)" % s["nodes"])
check(s["gpus"] == {"alloc": 4, "idle": 8, "total": 16} and s["cpus"]["idle"] == 196 and s["cpus"]["total"] == 320, "cluster-wide gpu/cpu availability de-duplicated (%s %s)" % (s["gpus"], s["cpus"]))
check(s["mem"]["total"] == (4 * 512000 + 256000) * MB and s["mem"]["avail"] == (3 * 512000 + 256000 - 384000) * MB, "cluster-wide memory (%s)" % s["mem"])
check(len(cs["jobs"]) == 2 and cs["jobs"][1]["state"] == "PENDING" and cs["jobs"][1]["reason"] == "(Resources)", "squeue rows parsed")
check(H._node_usable("idle~") and H._node_usable("mixed") and not H._node_usable("drain") and not H._node_usable("idle*") and not H._node_usable("resv"), "node usability by slurm state")
# scontrol is preferred when present: it knows the cores/memory slurm keeps for the OS (CoreSpecCount / MemSpecLimit),
# which sinfo still reports as idle. n1: 36 cores, 8 specialized -> 28 allocatable; n2: pre-22.05 output (no CPUEfctv), drained;
# n3: cloud node in no partition (cluster totals only)
SCONTROL_ROWS = (
    "NodeName=n1 Arch=x86_64 CoresPerSocket=18 CPUAlloc=8 CPUEfctv=28 CPUTot=36 CPULoad=2.31 AvailableFeatures=(null) ActiveFeatures=(null) "
    "Gres=gpu:a100:4(S:0-1) GresDrain=N/A GresUsed=gpu:a100:2(IDX:0-1) NodeAddr=n1 NodeHostName=n1 Version=23.02.7 OS=Linux 5.15.0-91-generic #101-Ubuntu SMP "
    "RealMemory=512000 AllocMem=128000 FreeMem=401230 Sockets=2 Boards=1 CoreSpecCount=8 CPUSpecList=28-35 MemSpecLimit=16000 State=MIXED ThreadsPerCore=1 "
    "TmpDisk=0 Weight=1 Owner=N/A MCS_label=N/A Partitions=gpu,cpu BootTime=2026-08-20T08:00:00 SlurmdStartTime=2026-08-20T08:01:00 "
    "CfgTRES=cpu=28,mem=512000M,billing=28,gres/gpu=4 AllocTRES=cpu=8,mem=128000M,gres/gpu=2 CapWatts=n/a CurrentWatts=0 AveWatts=0\n"
    "NodeName=n2 Arch=x86_64 CoresPerSocket=16 CPUAlloc=0 CPUTot=64 CPULoad=0.01 AvailableFeatures=(null) ActiveFeatures=(null) Gres=gpu:4 "
    "NodeAddr=n2 NodeHostName=n2 Version=21.08.8 OS=Linux RealMemory=256000 AllocMem=0 FreeMem=250000 Sockets=2 Boards=1 CoreSpecCount=4 "
    "State=IDLE+DRAIN ThreadsPerCore=2 TmpDisk=0 Weight=1 Owner=N/A MCS_label=N/A Partitions=gpu Reason=bad dimm [root@2026-08-27T10:00:00] "
    "CfgTRES=cpu=56,mem=256000M,billing=56,gres/gpu=4 AllocTRES=cpu=0,mem=0M,gres/gpu=1\n"
    "NodeName=n3 CPUAlloc=0 CPUEfctv=8 CPUTot=8 CPULoad=0.00 Gres=(null) GresUsed=(null) RealMemory=16000 AllocMem=0 State=IDLE+CLOUD+POWERED_DOWN "
    "ThreadsPerCore=1 CfgTRES=cpu=8,mem=16000M,billing=8 AllocTRES=\n")
fake("scontrol", "case \"$*\" in *show*node*) cat <<'OUT'\n%sOUT\n;; *) exit 1;; esac\n" % SCONTROL_ROWS)
cs3 = H.cluster_status()
gpu3 = [p for p in cs3["partitions"] if p["name"] == "gpu"][0]
cpu3 = [p for p in cs3["partitions"] if p["name"] == "cpu"][0]
check(cpu3["cpus"] == {"alloc": 8, "idle": 20, "other": 0, "total": 28}, "scontrol: specialized cores are not allocatable (36 cores, 8 reserved -> 28) (%s)" % cpu3["cpus"])
check(gpu3["cpus"] == {"alloc": 8, "idle": 20, "other": 56, "total": 84}, "scontrol: CoreSpecCount x ThreadsPerCore derived without CPUEfctv; drained node is 'other' (%s)" % gpu3["cpus"])
check(gpu3["gpus"] == {"alloc": 3, "idle": 2, "total": 8}, "scontrol: gpu use from GresUsed, else AllocTRES (%s)" % gpu3["gpus"])
check(gpu3["mem"] == {"alloc": 128000 * MB, "avail": (512000 - 16000 - 128000) * MB, "total": (512000 - 16000 + 256000) * MB}, "scontrol: MemSpecLimit is not allocatable (%s)" % gpu3["mem"])
check(gpu3["nodes_avail"] == 1 and cpu3["nodes_avail"] == 1, "scontrol: drained node unusable")
s3 = cs3["summary"]
check(s3["nodes"] == {"total": 3, "idle": 1, "avail": 2} and s3["cpus"] == {"alloc": 8, "idle": 28, "other": 56, "total": 92}, "scontrol: a node in no partition still counts cluster-wide; powered-down cloud node usable (%s %s)" % (s3["nodes"], s3["cpus"]))
check(H._count_ids("0,2-3,28-35") == 11 and H._tres_gpu("cpu=8,mem=1M,gres/gpu=2,gres/gpu:a100=2") == 4, "spec list / tres parsing")
check(H._scontrol_usable("MIXED") and H._scontrol_usable("IDLE+CLOUD+POWERED_DOWN") and not H._scontrol_usable("IDLE+DRAIN") and not H._scontrol_usable("DOWN+NOT_RESPONDING") and not H._scontrol_usable("IDLE+RESERVED"), "scontrol node states")
fake("scontrol", "exit 1\n")
# old slurm without GresUsed: the per-node query fails, the coarse queries still give totals
fake("sinfo", "case \"$*\" in *-N*-O*) echo 'sinfo: error: Invalid field' >&2; exit 1;; *-N*) cat <<'OUT'\ngpu*|idle|gpu:a100:4\ngpu*|down*|gpu:a100:4\nOUT\n;; *) cat <<'OUT'\n%sOUT\n;; esac\n" % PART_ROWS)
fake("squeue", "cat <<'OUT'\nRUNNING|gpu|gpu:2\nOUT\n")
cs2 = H.cluster_status()
gpu2 = [p for p in cs2["partitions"] if p["name"] == "gpu"][0]
check(gpu2["gpus"] == {"alloc": 2, "idle": 4, "total": 8} and gpu2["mem"] is None and cs2["summary"]["gpus"]["total"] == 8, "fallback without per-node gres usage (%s)" % gpu2["gpus"])
os.environ["PATH"] = os.environ["PATH"].split(os.pathsep, 1)[1]
check(H.detect_cluster() is None, "a machine without a scheduler is not a cluster node")

# ----------------------------------------------------------------- chat transcripts
chat_path = os.path.join(proj, sid + ".jsonl")
cm = H.chat_messages("claude", chat_path, limit=50)["messages"]
check([m["role"] for m in cm] == ["user", "assistant", "assistant", "assistant", "assistant"], "chat: tool results fold into the call, not into a message (%s)" % [m["role"] for m in cm])
check(cm[0]["text"] == "Fix the failing tests", "chat: user prompt")
check(cm[1]["text"] == "Let me look." and [t["name"] for t in cm[1]["tools"]] == ["Bash"], "chat: text and tool_use in one bubble")
check(cm[1]["tools"][0]["output"] == "1 failing" and cm[1]["tools"][0]["status"] == "done", "chat: tool_result attaches to its call")
check(cm[3]["tools"][0]["name"] == "Read" and cm[3]["tools"][0]["status"] == "done" and cm[4]["text"] == "Done, tests pass.",
      "chat: a result appended later still finds its call")
check(cm[1]["usage"]["cache_read"] == 5000 and cm[1]["model"] == "claude-x", "chat: usage and model ride along")

# one assistant message split over several records (claude writes one per content block) is one bubble
split_sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
split = [
    {"type": "assistant", "timestamp": "2026-01-02T10:00:00Z", "requestId": "req_1", "uuid": "u1",
     "message": {"role": "assistant", "id": "msg_1", "model": "claude-x", "usage": {"input_tokens": 7, "output_tokens": 11, "cache_creation_input_tokens": 40, "cache_creation": {"ephemeral_1h_input_tokens": 30}},
                 "content": [{"type": "thinking", "thinking": "hmm"}]}},
    {"type": "assistant", "timestamp": "2026-01-02T10:00:01Z", "requestId": "req_1", "uuid": "u2",
     "message": {"role": "assistant", "id": "msg_1", "model": "claude-x", "usage": {"input_tokens": 7, "output_tokens": 11, "cache_creation_input_tokens": 40, "cache_creation": {"ephemeral_1h_input_tokens": 30}},
                 "content": [{"type": "text", "text": "done"}]}},
    {"type": "assistant", "timestamp": "2026-01-02T10:00:02Z", "requestId": "req_2", "uuid": "u3",
     "message": {"role": "assistant", "id": "msg_2", "model": "claude-x",
                 "content": [{"type": "tool_use", "id": "t9", "name": "Grep", "input": {"pattern": "x"}}]}},
]
jsonl(os.path.join(proj, split_sid + ".jsonl"), split)
sm = H.chat_messages("claude", os.path.join(proj, split_sid + ".jsonl"), limit=50)["messages"]
check(len(sm) == 2 and sm[0]["thinking"] == "hmm" and sm[0]["text"] == "done", "chat: records sharing a message id merge into one bubble (%d)" % len(sm))
check(sm[1]["tools"][0]["status"] == "running", "chat: a call with no result yet is still running")

crollout = os.path.join(HOME, ".codex", "sessions", "2026", "01", "01", "rollout-2026-01-01T10-00-00-cx.jsonl")
jsonl(crollout, [
    {"type": "session_meta", "timestamp": "2026-01-01T10:00:00Z", "payload": {"id": "cx", "cwd": cwd, "model": "gpt-x"}},
    {"type": "event_msg", "timestamp": "2026-01-01T10:00:01Z", "payload": {"type": "user_message", "message": "run the tests"}},
    {"type": "event_msg", "timestamp": "2026-01-01T10:00:02Z", "payload": {"type": "agent_message", "message": "on it"}},
    {"type": "response_item", "timestamp": "2026-01-01T10:00:03Z", "payload": {"type": "function_call", "call_id": "c1", "name": "shell", "arguments": "{\"command\": \"pytest\"}"}},
    {"type": "response_item", "timestamp": "2026-01-01T10:00:04Z", "payload": {"type": "function_call_output", "call_id": "c1", "output": [{"type": "input_text", "text": "2 passed"}]}},
    {"type": "event_msg", "timestamp": "2026-01-01T10:00:05Z", "payload": {"type": "token_count", "info": {
        "total_token_usage": {"input_tokens": 1000, "cached_input_tokens": 400, "cache_write_input_tokens": 10, "output_tokens": 50},
        "last_token_usage": {"input_tokens": 1000, "cached_input_tokens": 400, "cache_write_input_tokens": 10, "output_tokens": 50}}}},
    {"type": "event_msg", "timestamp": "2026-01-01T11:00:00Z", "payload": {"type": "token_count", "info": {
        "total_token_usage": {"input_tokens": 3000, "cached_input_tokens": 900, "cache_write_input_tokens": 10, "output_tokens": 130},
        "last_token_usage": {"input_tokens": 2000, "cached_input_tokens": 500, "cache_write_input_tokens": 0, "output_tokens": 80}}}},
])
xm = H.chat_messages("codex", crollout, limit=50)["messages"]
check([m["role"] for m in xm] == ["user", "assistant"] and xm[1]["text"] == "on it", "chat/codex: user + agent message")
check([t["name"] for t in xm[1]["tools"]] == ["shell"] and xm[1]["tools"][0]["output"] == "2 passed", "chat/codex: tool call and its output")
check(H.chat_messages("shell", None)["error"], "chat: a session with no transcript says so")
check(not H._transcript_path_ok("/etc/passwd") and not H._transcript_path_ok(os.path.join(HOME, "x.jsonl"))
      and H._transcript_path_ok(chat_path), "chat: only harness session stores are readable by path")

# ----------------------------------------------------------------- token usage
entries, meta = H._usage_scan_claude(os.path.join(proj, split_sid + ".jsonl"))
check(len(entries) == 1, "usage/claude: records repeating one message's usage are counted once (%d)" % len(entries))
check(entries[0][:2] == ["2026-01-02T10", "claude-x"] and entries[0][3:] == [7, 11, 0, 40, 30] and entries[0][2] == H._dedupe_key("msg_1", "req_1"),
      "usage/claude: hour bucket, model and the 1h slice of the cache write (%s)" % entries[0])

centries, cmeta = H._usage_scan_codex(crollout)
check(len(centries) == 2 and cmeta["cwd"] == cwd, "usage/codex: one entry per token_count")
check(centries[0][3:] == [600, 50, 400, 10, 0], "usage/codex: cached reads split out of input (%s)" % centries[0][3:])
check(centries[1][3:] == [1500, 80, 500, 0, 0], "usage/codex: per-turn delta from the running total (%s)" % centries[1][3:])
check(centries[1][0] == "2026-01-01T11", "usage/codex: bucketed by the event's own hour")

# codex repeats the closing token_count of a turn, and restarts its counter when context resets
dup = os.path.join(HOME, ".codex", "sessions", "2026", "01", "02", "rollout-2026-01-02T10-00-00-dup.jsonl")
def tc(ts, tin, tcached, tout, lin, lcached, lout):
    return {"type": "event_msg", "timestamp": ts, "payload": {"type": "token_count", "info": {
        "total_token_usage": {"input_tokens": tin, "cached_input_tokens": tcached, "cache_write_input_tokens": 0, "output_tokens": tout, "total_tokens": tin + tout},
        "last_token_usage": {"input_tokens": lin, "cached_input_tokens": lcached, "cache_write_input_tokens": 0, "output_tokens": lout}}}}
jsonl(dup, [
    {"type": "session_meta", "timestamp": "2026-01-02T10:00:00Z", "payload": {"id": "dup", "cwd": cwd, "model": "gpt-x"}},
    tc("2026-01-02T10:00:01Z", 100, 40, 10, 100, 40, 10),
    tc("2026-01-02T10:00:02Z", 250, 90, 25, 150, 50, 15),
    tc("2026-01-02T10:00:03Z", 250, 90, 25, 150, 50, 15),   # end-of-turn repeat: total did not move
    tc("2026-01-02T11:00:00Z", 80, 20, 5, 80, 20, 5),       # context reset: the counter restarted
])
dentries, _ = H._usage_scan_codex(dup)
check(len(dentries) == 3, "usage/codex: a repeated token_count spends nothing and is dropped (%d)" % len(dentries))
check([e[3] + e[5] for e in dentries] == [100, 150, 80], "usage/codex: input follows the running total, not last_token_usage (%s)" % [e[3] + e[5] for e in dentries])
check(dentries[2][:1] == ["2026-01-02T11"] and dentries[2][4] == 5, "usage/codex: a restarted counter is counted fresh, not as a negative")

# codex' exec tool is handed a JS program — the row must show what it runs, not the wrapper
name, summary = H.codex_call_summary({"type": "custom_tool_call", "name": "exec",
    "input": 'const r = await tools.exec_command({"cmd":"npm run typecheck","workdir":"/x"});'})
check((name, summary) == ("exec_command", "npm run typecheck"), "codex tools: exec_command shows its command (%s / %s)" % (name, summary))
name, summary = H.codex_call_summary({"type": "custom_tool_call", "name": "exec",
    "input": 'const results = await Promise.all([tools.exec_command({"cmd":"a b"}), tools.exec_command({"cmd":"c d"})]);'})
check(summary == "a b ; c d", "codex tools: a Promise.all shows every command (%s)" % summary)
name, summary = H.codex_call_summary({"type": "custom_tool_call", "name": "exec",
    "input": 'const patch = "*** Begin Patch\\n*** Update File: /home/u/a.py\\n*** Update File: /home/u/b.py\\n";'})
check((name, summary) == ("apply_patch", "/home/u/a.py, /home/u/b.py"), "codex tools: a patch shows its files (%s / %s)" % (name, summary))
name, summary = H.codex_call_summary({"type": "custom_tool_call", "name": "exec",
    "input": 'const r = await tools.view_image({"path":"/tmp/p.png","detail":"high"});'})
check((name, summary) == ("view_image", "/tmp/p.png"), "codex tools: other calls show their own argument (%s / %s)" % (name, summary))
check(H.codex_call_summary({"type": "function_call", "name": "spawn_agent", "arguments": '{"description":"look"}'}) == ("spawn_agent", "look"),
      "codex tools: a plain JSON function_call is untouched")

# a turn's tool calls belong to that turn's bubble, not to one bubble for the whole session
turns = os.path.join(HOME, ".codex", "sessions", "2026", "01", "03", "rollout-2026-01-03T10-00-00-turns.jsonl")
jsonl(turns, [
    {"type": "session_meta", "timestamp": "2026-01-03T10:00:00Z", "payload": {"id": "t", "cwd": cwd, "model": "gpt-x"}},
    {"type": "event_msg", "timestamp": "2026-01-03T10:00:01Z", "payload": {"type": "task_started"}},
    {"type": "event_msg", "timestamp": "2026-01-03T10:00:02Z", "payload": {"type": "user_message", "message": "first"}},
    {"type": "response_item", "timestamp": "2026-01-03T10:00:03Z", "payload": {"type": "custom_tool_call", "call_id": "a", "name": "exec", "input": 'await tools.exec_command({"cmd":"one"})'}},
    {"type": "event_msg", "timestamp": "2026-01-03T10:00:04Z", "payload": {"type": "task_complete", "turn_id": "1"}},
    {"type": "event_msg", "timestamp": "2026-01-03T10:00:05Z", "payload": {"type": "task_started"}},
    {"type": "event_msg", "timestamp": "2026-01-03T10:00:06Z", "payload": {"type": "user_message", "message": "second"}},
    {"type": "response_item", "timestamp": "2026-01-03T10:00:07Z", "payload": {"type": "custom_tool_call", "call_id": "b", "name": "exec", "input": 'await tools.exec_command({"cmd":"two"})'}},
])
tm = H.chat_messages("codex", turns, limit=50)["messages"]
check([m["role"] for m in tm] == ["user", "assistant", "user", "assistant"], "chat/codex: each turn gets its own bubble (%s)" % [m["role"] for m in tm])
check([len(m["tools"]) for m in tm] == [0, 1, 0, 1] and tm[3]["tools"][0]["summary"] == "two",
      "chat/codex: a turn's tools stay with that turn (%s)" % [len(m["tools"]) for m in tm])

# newer codex writes the conversation ONLY as response_item/message, and its exec programs are
# multi-line JS with bare object keys
NEW_EXEC = """const r = await Promise.all([
  tools.exec_command({
    cmd: "npm run typecheck",
    workdir: "/home/u/proj",
    yield_time_ms: 10000
  }),
  tools.exec_command({ cmd: "git status --short" })
]);"""
def rmsg(ts, role, text, ctype="output_text"):
    return {"type": "response_item", "timestamp": ts, "payload": {"type": "message", "role": role, "content": [{"type": ctype, "text": text}]}}
newer = os.path.join(HOME, ".codex", "sessions", "2026", "01", "04", "rollout-2026-01-04T10-00-00-new.jsonl")
jsonl(newer, [
    {"type": "session_meta", "timestamp": "2026-01-04T10:00:00Z", "payload": {"id": "n", "cwd": cwd, "model": "gpt-y"}},
    {"type": "event_msg", "timestamp": "2026-01-04T10:00:01Z", "payload": {"type": "task_started"}},
    rmsg("2026-01-04T10:00:02Z", "developer", "system policy blah"),
    rmsg("2026-01-04T10:00:03Z", "user", "<recommended_plugins>noise</recommended_plugins>", "input_text"),
    rmsg("2026-01-04T10:00:04Z", "user", "check the repo", "input_text"),
    rmsg("2026-01-04T10:00:05Z", "assistant", "on it"),
    {"type": "response_item", "timestamp": "2026-01-04T10:00:06Z", "payload": {"type": "custom_tool_call", "call_id": "n1", "name": "exec", "input": NEW_EXEC}},
    {"type": "response_item", "timestamp": "2026-01-04T10:00:07Z", "payload": {"type": "custom_tool_call_output", "call_id": "n1", "output": [{"type": "input_text", "text": "ok"}]}},
    rmsg("2026-01-04T10:00:08Z", "assistant", "all green"),
])
nm = H.chat_messages("codex", newer, limit=50)["messages"]
check([m["role"] for m in nm] == ["user", "assistant", "assistant"] and nm[0]["text"] == "check the repo",
      "chat/codex: a rollout with only response_item messages still has a conversation (%s)" % [(m["role"], m["text"][:12]) for m in nm])
check(nm[1]["text"] == "on it" and nm[2]["text"] == "all green", "chat/codex: developer turns and injected <blocks> are not the conversation")
check(len(nm[1]["tools"]) == 1 and nm[1]["tools"][0]["summary"] == "npm run typecheck ; git status --short",
      "chat/codex: bare-key multi-line JS arguments are read (%s)" % (nm[1]["tools"][0]["summary"],))
check(nm[1]["tools"][0]["name"] == "exec_command" and nm[1]["tools"][0]["output"] == "ok", "chat/codex: named after the call it makes")

# a rollout carrying BOTH shapes must not render every line twice
both = os.path.join(HOME, ".codex", "sessions", "2026", "01", "05", "rollout-2026-01-05T10-00-00-both.jsonl")
jsonl(both, [
    {"type": "session_meta", "timestamp": "2026-01-05T10:00:00Z", "payload": {"id": "b", "cwd": cwd, "model": "gpt-y"}},
    rmsg("2026-01-05T10:00:01Z", "user", "hello", "input_text"),
    {"type": "event_msg", "timestamp": "2026-01-05T10:00:01Z", "payload": {"type": "user_message", "message": "hello"}},
    {"type": "event_msg", "timestamp": "2026-01-05T10:00:02Z", "payload": {"type": "agent_message", "message": "hi there"}},
    rmsg("2026-01-05T10:00:02Z", "assistant", "hi there"),
])
bm = H.chat_messages("codex", both, limit=50)["messages"]
check([(m["role"], m["text"]) for m in bm] == [("user", "hello"), ("assistant", "hi there")],
      "chat/codex: the two event shapes are not rendered twice (%s)" % [(m["role"], m["text"]) for m in bm])

check(H._iso_epoch("2026-01-01T10:00:00Z") == 1767261600, "usage: ISO parsing")
check(H._iso_epoch("2026-01-01T18:00:00+08:00") == H._iso_epoch("2026-01-01T10:00:00Z"), "usage: offsets normalize to UTC")
check(H._iso_epoch(1767261600000) == 1767261600 and H._iso_epoch("nope") is None, "usage: epoch millis and junk")
rolled = H._usage_rollup([["h", "m", "k1", 1, 2, 3, 4, 4], ["h", "m", "k2", 10, 20, 30, 40, 0]])
check(rolled == [["h", "m", "", 11, 22, 33, 44, 4]], "usage: rollup merges an immutable transcript and drops its keys")

report = H.usage_report(days=400, force=True)
key = "claude:claude-x"
tot = sum(v[1] for h in report["hours"].values() for k, v in h.items() if k == key)
check(tot == 31, "usage: report totals the fixtures (%s)" % tot)
check(any(k.startswith("codex:") for h in report["hours"].values() for k in h), "usage: codex rollouts are in the same report")
check(all(len(h) and all(len(v) == 6 for v in h.values()) for h in report["hours"].values()), "usage: every bucket carries the six counters")
check(H.usage_report(days=400)["generated"] == report["generated"], "usage: a repeat poll reuses the last report")

# ----------------------------------------------------------------- helpers
check(H.classify_agent(["node", "/x/node_modules/@anthropic-ai/claude-code/cli.js", "--resume"])[0] == "claude", "classify: claude cli.js")
check(H.classify_agent(["/home/u/.local/bin/codex", "-c", "x", "app-server"])[0] == "codex", "classify: codex")
check(H.classify_agent(["/opt/opencode-linux-x64"])[0] == "opencode", "classify: opencode")
check(H.classify_agent(["python3", "train.py"])[0] is None, "classify: non-agent")
check(H.encode_claude_project("/home/u/my proj/x_y") == "-home-u-my-proj-x-y", "claude project dir encoding")
check(H.summarize_tool_input("Bash", {"command": "ls\n-la"}) == "ls -la", "tool summary flattens newlines")
print("FAILURES:", failures)
sys.exit(1 if failures else 0)
