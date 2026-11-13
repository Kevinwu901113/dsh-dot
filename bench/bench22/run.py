# -*- coding: utf-8 -*-
"""Launcher: registers dsh-dot in the Bench 2.2 harness without editing it, then runs one of its tools.

    python bench/bench22/run.py --harness <benchmark-2.2/harness> runner  --release ../dataset --system dsh-dot --split dev --run R
    python bench/bench22/run.py --harness <…> natural run --release ../dataset --natural ../dataset/natural --system dsh-dot --split dev --run N
    python bench/bench22/run.py --harness <…> gateway --port 18877 [gateway args]

`gateway` is the harness gateway, unchanged, with an optional shim for running it OUTSIDE the
organiser's setup (only when DSH_BENCH22_DEEPSEEK_URL is set): the DeepSeek route goes to that URL
(e.g. https://api.deepseek.com/chat/completions, the official API) instead of OpenCode Go, the key is
read from the file DSH_BENCH22_DEEPSEEK_KEY_FILE, the model id sent upstream is DSH_BENCH22_DEEPSEEK_MODEL
(e.g. deepseek-flash; the ledger keeps the price-list name deepseek-v4.1-flash and its price), and the
provider's raw usage (cache hits, reasoning tokens) is appended to DSH_BENCH22_REAL_USAGE for the real bill.
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def shim_gateway():
    from bench22 import gateway as g
    url = os.environ.get("DSH_BENCH22_DEEPSEEK_URL")
    if not url:
        return g
    keyfile = os.environ["DSH_BENCH22_DEEPSEEK_KEY_FILE"]
    with open(keyfile, encoding="utf-8") as f:
        g.State.keys["deepseek"] = f.read().strip()
    g.DEEPSEEK_URL = url
    upstream_model = os.environ.get("DSH_BENCH22_DEEPSEEK_MODEL", "")
    real_log = os.environ.get("DSH_BENCH22_REAL_USAGE", "")
    orig = g._post

    def post(u, body, provider, extra_headers=None, **kw):
        if provider != "deepseek":
            return orig(u, body, provider, extra_headers, **kw)
        run = (extra_headers or {}).get("x-opencode-session", "")
        b = dict(body)
        if upstream_model:
            b["model"] = upstream_model
        b.setdefault("thinking", {"type": "disabled"})
        resp = orig(u, b, provider, None, **kw)
        if real_log:
            with open(real_log, "a", encoding="utf-8") as f:
                f.write(json.dumps({"ts": time.time(), "run": run, "model": resp.get("model"), "usage": resp.get("usage")}) + "\n")
        return resp

    g._post = post
    print(f"gateway shim: deepseek route -> {url} as {upstream_model or '(same name)'}; real usage -> {real_log or '(not logged)'}", flush=True)
    return g


def main():
    argv = sys.argv[1:]
    if argv[:1] == ["--harness"]:
        harness, argv = argv[1], argv[2:]
    else:
        harness = os.environ.get("BENCH22_HARNESS", "")
    sys.path.insert(0, os.path.abspath(harness))
    sys.path.insert(0, HERE)
    import dsh_dot
    dsh_dot.register()
    tool, rest = argv[0], argv[1:]
    sys.argv = [tool] + rest
    if tool == "runner":
        from bench22 import runner
        runner.main()
    elif tool == "natural":
        from bench22 import natural
        natural.main()
    elif tool == "gateway":
        g = shim_gateway()
        import argparse
        ap = argparse.ArgumentParser()       # the same options as `python -m bench22.gateway`
        ap.add_argument("--port", type=int, default=18877)
        ap.add_argument("--ledger", default=os.path.join(g.ROOT, "runs", "bench22", "spend-ledger.jsonl"))
        ap.add_argument("--cache", default=os.path.join(g.ROOT, "runs", "bench22", "gateway-cache.sqlite3"))
        ap.add_argument("--cap-usd", type=float, default=9.5)
        ap.add_argument("--run-ceiling-cny", type=float, default=None)
        a = ap.parse_args(rest)
        if a.run_ceiling_cny is not None:
            g.State.run_ceiling_cny = a.run_ceiling_cny
        g.serve(a.port, a.ledger, a.cache, a.cap_usd)
    else:
        raise SystemExit("tool: runner | natural | gateway")


if __name__ == "__main__":
    main()
