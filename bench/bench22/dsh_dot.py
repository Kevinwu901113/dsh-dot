# -*- coding: utf-8 -*-
"""dsh-dot as a Bench 2.2 system (Ornn8/chat-memory-benchmark, benchmark-2.2/harness/bench22).

A thin Python System that drives bench/bench22/worker.mjs, which hosts the plugin's real memory code
(src/memory/*). One worker process per System instance (= per persona); JSON lines over stdio.

    ingest(turn)     queued, then replayed in order at the turn's logical time right before the next
                     retrieve / mark (the evaluator only labels the persona on its gateway client just
                     before the first retrieve, so ingest calls are sent after that to be booked to the
                     right board; the order and the logical times are unchanged).
    retrieve(...)    read-only: her standing notes (dot:memory) + auto-recall for the message
                     (dot:recall, real local embedder + reranker behind the gateway) + the last WINDOW
                     turns (the evaluator gives no recent window of its own, so the system supplies it,
                     as the reference systems do). used_turns = window turns + recalled turns.
    mark()/rewind()  snapshot / restore of the persona's dot home and the worker's state.

Env: DSH_BENCH22_WORK (work dir, default ~/bench22-work), DSH_BENCH22_FAKE=1 (no chat calls: canned
consolidation JSON, for plumbing tests), DSH_BENCH22_MEMORY (JSON merged into the memory settings;
default {} = the plugin's defaults), DSH_BENCH22_WINDOW (6).
"""
import atexit
import itertools
import json
import os
import subprocess
import threading

from bench22.systems import System, Retrieval, CeilingExceeded

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, "worker.mjs")
_ids = itertools.count(1)


class DshDot(System):
    name = "dsh-dot"

    def __init__(self, gw):
        self.gw = gw
        self.pending = []
        self.count = 0          # turns ingested (queued included): the mark() token
        self.lock = threading.Lock()
        work = os.environ.get("DSH_BENCH22_WORK", os.path.expanduser("~/bench22-work"))
        self.dir = os.path.join(work, f"{gw.run or 'run'}-{os.getpid()}-{next(_ids)}")
        os.makedirs(self.dir, exist_ok=True)
        self.errlog = open(os.path.join(self.dir, "worker.log"), "a", encoding="utf-8")
        self.proc = subprocess.Popen(["node", WORKER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errlog,
                                     text=True, encoding="utf-8", bufsize=1)
        atexit.register(self.close)
        self.init = self._call({"cmd": "init", "home": os.path.join(self.dir, "dot"), "dshHome": os.path.join(self.dir, "dsh-home"),
                                "gateway": gw.base, "fake": os.environ.get("DSH_BENCH22_FAKE") == "1",
                                "window": int(os.environ.get("DSH_BENCH22_WINDOW", "6")),
                                "memory": json.loads(os.environ.get("DSH_BENCH22_MEMORY", "{}"))})

    # ---- plumbing
    def _call(self, msg):
        with self.lock:
            self.proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError(f"dsh-dot worker exited (see {self.errlog.name})")
        r = json.loads(line)
        if not r.get("ok"):
            err = r.get("error", "")
            if "RUN_COST_CEILING" in err:
                raise CeilingExceeded(err[:300])
            raise RuntimeError("dsh-dot worker: " + err[:800])
        return r.get("result")

    def _flush(self):
        if self.pending:
            turns, self.pending = self.pending, []
            for k in range(0, len(turns), 200):
                self._call({"cmd": "ingest", "turns": turns[k:k + 200], "run": self.gw.run, "system": self.gw.system})

    def close(self):
        try:
            if self.proc.poll() is None:
                self.proc.stdin.write('{"cmd":"exit"}\n')
                self.proc.stdin.flush()
                self.proc.wait(timeout=20)
        except Exception:  # noqa
            self.proc.kill()

    # ---- the adapter contract
    def ingest(self, turn):
        self.pending.append({k: turn[k] for k in ("turn", "time", "user", "assistant")})
        self.count += 1

    def retrieve(self, question, now, cutoff_turn, item_id=None):
        self._flush()
        r = self._call({"cmd": "retrieve", "question": question, "now": now, "cutoff": cutoff_turn,
                        "run": self.gw.run, "system": self.gw.system})
        return Retrieval(r["prompt"], r["used_turns"], r["meta"])

    def mark(self):
        self._flush()
        return self._call({"cmd": "mark"})["token"]

    def rewind(self, token):
        self._flush()
        self.count = self._call({"cmd": "rewind", "token": token})["token"]

    def status(self):
        self._flush()
        return self._call({"cmd": "status"})


def register():
    from bench22 import systems
    systems.REGISTRY["dsh-dot"] = lambda gw: DshDot(gw)
