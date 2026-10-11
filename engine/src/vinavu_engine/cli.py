"""vinavu-engine: ask, serve, mcp, models, doctor.

`ask` is the CLI's transport: one JSON request on stdin, one JSON event per
line on stdout, and nothing else on stdout, so the reader never has to guess
what a line is.
"""

from __future__ import annotations

import argparse
import json
import sys
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from vinavu_engine import __version__
from vinavu_engine.ask import AskError, Asker, Delta, Done, Sources, Status, Thread


def _emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _source_list(sources: list[Any]) -> list[dict[str, str]]:
    return [{"title": s.title, "url": s.url} for s in sources]


def cmd_ask(_: argparse.Namespace) -> int:
    try:
        req = json.loads(sys.stdin.read())
        if not isinstance(req, dict) or not isinstance(req.get("query"), str) or not req["query"].strip():
            raise ValueError("the request needs a non-empty query")
        files = req.get("files") or []
        if not isinstance(files, list) or not all(isinstance(f, str) for f in files):
            raise ValueError("files must be a list of paths")
    except ValueError as e:
        _emit({"t": "err", "kind": "request", "error": str(e)})
        return 1
    model = req.get("model") if isinstance(req.get("model"), str) else None
    try:
        for ev in Asker().ask(
            req["query"],
            model=model,
            thread=Thread.from_dict(req.get("thread")),
            files=files,
            linked=bool(req.get("linked")),
        ):
            match ev:
                case Status(text=text):
                    _emit({"t": "status", "text": text})
                case Sources(items=items):
                    _emit({"t": "sources", "items": _source_list(items)})
                case Delta(text=text):
                    _emit({"t": "d", "d": text})
                case Done():
                    _emit(
                        {
                            "t": "done",
                            "content": ev.content,
                            "model": ev.model,
                            "sources": _source_list(ev.sources),
                            "thread": ev.thread.to_dict() if ev.thread else None,
                            "url": ev.url,
                        }
                    )
    except AskError as e:
        _emit({"t": "err", "kind": e.kind, "error": str(e)})
        return 1
    except BrokenPipeError:
        return 1
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    from vinavu_engine.server import serve

    print(f"vinavu-engine {__version__} serving http://{args.host}:{args.port}/v1", file=sys.stderr)
    serve(args.host, args.port)
    return 0


def cmd_mcp(_: argparse.Namespace) -> int:
    from vinavu_engine.mcp_server import run

    run()
    return 0


def cmd_models(args: argparse.Namespace) -> int:
    from vinavu_engine.models import listing

    rows = listing()
    if args.json:
        print(json.dumps([{"id": r.id, "name": r.name, "status": r.status} for r in rows], indent=1))
        return 0
    width = max(len(r.id) for r in rows)
    for r in rows:
        print(f"{r.id.ljust(width)}  {r.name}{'' if r.status in ('available', 'alias') else f'  ({r.status})'}")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    from vinavu_engine import ask, space, token, upstream

    rows: list[dict[str, Any]] = []

    def add(ok: bool | None, label: str, detail: str = "") -> None:
        rows.append({"ok": ok, "label": label, "detail": detail})

    try:
        lib = version("perplexity-webui-scraper")
    except PackageNotFoundError:
        lib = "missing"
    add(True, f"vinavu-engine {__version__}", f"perplexity-webui-scraper {lib}")
    try:
        mode = ask.save_mode()
        add(True, "save mode", mode)
    except AskError as e:
        mode = "space"
        add(False, "save mode", str(e))
    try:
        found = token.find_token()
        when = f", expires {found.expires:%Y-%m-%d}" if found.expires else ""
        add(True, "session", f"{found.source}{when}")
    except token.TokenError as e:
        add(False, "session", str(e))
        found = None
    if found:
        try:
            with upstream.client(found.token) as c:
                tier = c.get_account_profile().account_tier
            add(tier in ("pro", "max", "enterprise"), "account", f"tier {tier}")
        except Exception as e:  # noqa: BLE001 - doctor reports, it does not fix
            add(False, "account", f"{type(e).__name__}: {e}")
        if mode == "space":
            try:
                add(True, "space", f"{space.title()} ({space.resolve(upstream.rest_session(found.token))})")
            except Exception as e:  # noqa: BLE001
                add(False, "space", f"{type(e).__name__}: {e}")
    if args.json:
        print(json.dumps(rows, indent=1))
    else:
        for r in rows:
            mark = {True: "ok", False: "!!", None: "--"}[r["ok"]]
            print(f"{mark} {r['label']}: {r['detail']}")
    return 0 if all(r["ok"] is not False for r in rows) else 1


def main(argv: list[str] | None = None) -> int:
    from vinavu_engine import DEFAULT_HOST, DEFAULT_PORT

    parser = argparse.ArgumentParser(prog="vinavu-engine", description=__doc__.splitlines()[0])
    parser.add_argument("-V", "--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ask", help="answer one JSON request from stdin as JSON lines").set_defaults(fn=cmd_ask)
    p = sub.add_parser("serve", help="run the OpenAI-compatible server")
    p.add_argument("--host", default=DEFAULT_HOST)
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.set_defaults(fn=cmd_serve)
    sub.add_parser("mcp", help="run the MCP server on stdio").set_defaults(fn=cmd_mcp)
    p = sub.add_parser("models", help="list model names")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_models)
    p = sub.add_parser("doctor", help="check the session, account and Space")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_doctor)
    args = parser.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
