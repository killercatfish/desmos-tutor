"""Symbolic math for the tutor: a small local SymPy service.

Desmos can't solve, factor or integrate symbolically, and models are unreliable at it, so the
tutor asks this service instead. It only listens on 127.0.0.1 and only the tutor server calls it.

Input is never raw LaTeX. The tutor server converts LaTeX to plain mathjs syntax first (digits,
single-letter variables, + - * / ^ ( ) and a short list of function names), and this file checks
that again before SymPy parses anything, because SymPy's parser evaluates Python code and the
text can be steered by what a student types.

    POST /symbolic  {"op": "solve", "expr": "2*(x+3)", "rhs": "10", "var": "x"}
    -> {"ok": true, "result": "[2]", "latex": "\\left[ 2\\right]"}

Ops: solve, factor, expand, simplify, derivative, integral (optional "from"/"to"), limit ("at").
Every op runs in a child process that is killed after TIMEOUT seconds (integrals can hang).

Run:  python sidecar/sympy_server.py [--port 3002]
"""

import argparse
import json
import multiprocessing as mp
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

TIMEOUT = 5.0
MAX_LEN = 500
OPS = {"solve", "factor", "expand", "simplify", "derivative", "integral", "limit"}

# mathjs function names the converter can emit, mapped to SymPy names (filled in inside the worker).
FUNCTIONS = {
    "sin", "cos", "tan", "sec", "csc", "cot", "asin", "acos", "atan",
    "sinh", "cosh", "tanh", "log", "log10", "exp", "abs", "sqrt",
    "floor", "ceil", "round", "sign", "min", "max", "nthRoot",
}
CONSTANTS = {"pi", "tau", "e", "oo"}
SAFE_CHARS = re.compile(r"^[0-9A-Za-z_.+\-*/^(), ]+$")
WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
VARIABLE = re.compile(r"^[A-Za-z](?:_[A-Za-z0-9]+)?$")


class BadInput(ValueError):
    pass


def check_text(text):
    """Allow only the characters and names the LaTeX converter produces."""
    if not isinstance(text, str) or not text.strip():
        raise BadInput("empty expression")
    if len(text) > MAX_LEN:
        raise BadInput("expression too long")
    if not SAFE_CHARS.match(text):
        raise BadInput("unexpected character")
    for word in WORD.findall(text):
        if word in FUNCTIONS or word in CONSTANTS:
            continue
        if not VARIABLE.match(word) or "__" in word:
            raise BadInput(f"unexpected name {word!r}")
    return text


def run_op(req):
    """Runs in a child process. Returns a JSON-able dict."""
    import sympy as sp
    from sympy.parsing.sympy_parser import (
        convert_xor, parse_expr, standard_transformations,
    )

    fn = {
        "sin": sp.sin, "cos": sp.cos, "tan": sp.tan, "sec": sp.sec, "csc": sp.csc, "cot": sp.cot,
        "asin": sp.asin, "acos": sp.acos, "atan": sp.atan,
        "sinh": sp.sinh, "cosh": sp.cosh, "tanh": sp.tanh,
        "log": sp.log, "log10": lambda x: sp.log(x, 10), "exp": sp.exp, "abs": sp.Abs, "sqrt": sp.sqrt,
        "floor": sp.floor, "ceil": sp.ceiling, "round": lambda x: sp.floor(x + sp.Rational(1, 2)),
        "sign": sp.sign, "min": sp.Min, "max": sp.Max, "nthRoot": lambda x, n: sp.root(x, n),
        "pi": sp.pi, "tau": 2 * sp.pi, "e": sp.E, "oo": sp.oo,
    }
    # A tiny global namespace: SymPy's parser evaluates code, so nothing else is reachable.
    globals_ = {"__builtins__": {}, "Integer": sp.Integer, "Float": sp.Float,
                "Rational": sp.Rational, "Symbol": sp.Symbol}
    transformations = standard_transformations + (convert_xor,)

    def parse(text):
        text = check_text(text)
        names = dict(fn)
        for word in WORD.findall(text):
            if word not in names:
                names[word] = sp.Symbol(word, real=True)  # so E, I, N, S, O, Q stay plain letters
        return parse_expr(text, local_dict=names, global_dict=globals_, transformations=transformations)

    op = req.get("op")
    if op not in OPS:
        raise BadInput(f"unknown op {op!r}")
    expr = parse(req.get("expr"))
    rhs = parse(req["rhs"]) if req.get("rhs") not in (None, "") else None

    free = sorted((expr - rhs if rhs is not None else expr).free_symbols, key=lambda s: s.name)
    var_name = req.get("var")
    if var_name:
        if not isinstance(var_name, str) or not VARIABLE.match(var_name):
            raise BadInput("bad variable name")
        var = sp.Symbol(var_name, real=True)
    elif len(free) == 1:
        var = free[0]
    else:
        var = next((s for s in free if s.name == "x"), None)
    if op in {"solve", "derivative", "integral", "limit"} and var is None:
        raise BadInput("say which variable (var)")

    if op == "solve":
        result = sp.solve(sp.Eq(expr, rhs if rhs is not None else 0), var)
    elif rhs is not None:
        raise BadInput(f"{op} takes an expression, not an equation")
    elif op == "factor":
        result = sp.factor(expr)
    elif op == "expand":
        result = sp.expand(expr)
    elif op == "simplify":
        result = sp.simplify(expr)
    elif op == "derivative":
        result = sp.diff(expr, var)
    elif op == "integral":
        lo, hi = req.get("from"), req.get("to")
        if lo not in (None, "") and hi not in (None, ""):
            result = sp.integrate(expr, (var, parse(str(lo)), parse(str(hi))))
        else:
            result = sp.integrate(expr, var)  # no + C
    else:  # limit
        at = req.get("at")
        if at in (None, ""):
            raise BadInput("limit needs 'at'")
        direction = req.get("dir") if req.get("dir") in ("+", "-") else "+-"
        result = sp.limit(expr, var, parse(str(at)), dir=direction)

    return {"ok": True, "result": str(result), "latex": sp.latex(result),
            "variable": var.name if var is not None else None}


def _child(req, conn):
    try:
        conn.send(run_op(req))
    except BadInput as e:
        conn.send({"ok": False, "error": str(e)})
    except Exception as e:  # SymPy errors (NotImplementedError for hard integrals, etc.)
        conn.send({"ok": False, "error": f"{type(e).__name__}: {e}"[:300]})
    finally:
        conn.close()


def run_with_timeout(req, timeout=TIMEOUT):
    ctx = mp.get_context("spawn")
    parent, child = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_child, args=(req, child), daemon=True)
    proc.start()
    child.close()
    if parent.poll(timeout):
        out = parent.recv()
        proc.join(1)
        return out
    proc.kill()
    proc.join(1)
    return {"ok": False, "error": f"took longer than {timeout:g} s"}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True})
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/symbolic":
            return self._send(404, {"ok": False, "error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 4096:
                return self._send(413, {"ok": False, "error": "request too large"})
            req = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(req, dict):
                raise ValueError("expected a JSON object")
        except ValueError as e:
            return self._send(400, {"ok": False, "error": str(e)})
        self._send(200, run_with_timeout(req))

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=3002)
    args = ap.parse_args()
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"sympy sidecar on http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
