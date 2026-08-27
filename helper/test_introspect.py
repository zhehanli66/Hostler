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

# ----------------------------------------------------------------- helpers
check(H.classify_agent(["node", "/x/node_modules/@anthropic-ai/claude-code/cli.js", "--resume"])[0] == "claude", "classify: claude cli.js")
check(H.classify_agent(["/home/u/.local/bin/codex", "-c", "x", "app-server"])[0] == "codex", "classify: codex")
check(H.classify_agent(["/opt/opencode-linux-x64"])[0] == "opencode", "classify: opencode")
check(H.classify_agent(["python3", "train.py"])[0] is None, "classify: non-agent")
check(H.encode_claude_project("/home/u/my proj/x_y") == "-home-u-my-proj-x-y", "claude project dir encoding")
check(H.summarize_tool_input("Bash", {"command": "ls\n-la"}) == "ls -la", "tool summary flattens newlines")
print("FAILURES:", failures)
sys.exit(1 if failures else 0)
