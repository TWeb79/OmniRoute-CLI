#!/usr/bin/env python3
"""Live connection test for a running omniroute-cli (stdlib only).

Start the gateway first (`omniroute-cli start`), then:
    python3 test.py
Env: OMNIROUTE_URL (default http://127.0.0.1:20128), OMNIROUTE_KEY (if auth enabled),
     OMNIROUTE_MODEL (default nvidia/nemotron-3.5-lightning-30b-a3b).
Chat checks make real upstream calls (a few tokens each).
"""
import json, os, sys, urllib.request, urllib.error

BASE = os.environ.get("OMNIROUTE_URL", "http://127.0.0.1:20128").rstrip("/")
KEY = os.environ.get("OMNIROUTE_KEY", "")
MODEL = os.environ.get("OMNIROUTE_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b")
HEADERS = {"Content-Type": "application/json"}
if KEY:
    HEADERS.update({"Authorization": f"Bearer {KEY}", "x-api-key": KEY})


def call(path, body=None):
    req = urllib.request.Request(BASE + path, headers=HEADERS,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        return urllib.request.urlopen(req, timeout=90)
    except urllib.error.HTTPError as e:
        return e


def check_health():
    r = call("/health")
    assert r.status == 200, f"status {r.status}"


def check_models():
    r = call("/v1/models")
    assert r.status == 200, f"status {r.status}"
    ids = [m["id"] for m in json.load(r)["data"]]
    assert ids, "no models listed"
    return f"{len(ids)} models"


def check_chat():
    r = call("/v1/chat/completions", {"model": MODEL, "max_tokens": 400,
                                      "messages": [{"role": "user", "content": "Say hi in one word."}]})
    body = r.read().decode()
    assert r.status == 200, f"status {r.status}: {body[:200]}"
    j = json.loads(body)
    text = j['choices'][0]['message']['content']
    assert text, "empty reply (reasoning model out of tokens?)"
    return f"via {r.headers.get('x-omniroute-provider')}: {text!r}"


def check_chat_stream():
    r = call("/v1/chat/completions", {"model": MODEL, "max_tokens": 400, "stream": True,
                                      "messages": [{"role": "user", "content": "Say hi in one word."}]})
    assert r.status == 200, f"status {r.status}: {r.read().decode()[:200]}"
    data = [l for l in r.read().decode().splitlines() if l.startswith("data:")]
    assert len(data) > 1, "no SSE chunks"
    return f"{len(data)} chunks"


def check_anthropic():
    r = call("/v1/messages", {"model": "claude-sonnet-4-5", "max_tokens": 400,
                              "messages": [{"role": "user", "content": "Say hi in one word."}]})
    body = r.read().decode()
    assert r.status == 200, f"status {r.status}: {body[:200]}"
    j = json.loads(body)
    assert j["type"] == "message", "not an Anthropic message"
    assert j["content"][0]["text"], "empty reply (reasoning model out of tokens?)"
    return repr(j["content"][0]["text"])


def check_anthropic_stream():
    r = call("/v1/messages", {"model": "claude-sonnet-4-5", "max_tokens": 400, "stream": True,
                              "messages": [{"role": "user", "content": "Say hi in one word."}]})
    assert r.status == 200, f"status {r.status}: {r.read().decode()[:200]}"
    body = r.read().decode()
    assert "message_start" in body and "message_stop" in body, "incomplete Anthropic stream"
    return "stream ok"


def main():
    print(f"Testing {BASE}  model={MODEL}  auth={'on' if KEY else 'off'}\n")
    failed = 0
    for fn in (check_health, check_models, check_chat, check_chat_stream, check_anthropic, check_anthropic_stream):
        try:
            detail = fn() or ""
            print(f"PASS {fn.__name__[6:]:<18} {detail}")
        except urllib.error.URLError as e:
            print(f"FAIL {fn.__name__[6:]:<18} cannot connect: {e.reason} — is the gateway running?")
            sys.exit(1)
        except Exception as e:
            failed += 1
            print(f"FAIL {fn.__name__[6:]:<18} {e}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
