"""The Perplexity Space (now "project") that vinavu's threads are saved into.

Saved threads are what let Perplexity's memory of the account answer: asked in
incognito, it says it holds none. Saving every terminal question into the main
library would bury the threads asked in the browser, so they go to one Space,
found by its title or made on first use, and its id is cached.
"""

from __future__ import annotations

import json
import os
from typing import Any

from vinavu_engine import upstream
from vinavu_engine.paths import home, write_private

TITLE = "vinavu"


class SpaceError(Exception):
    pass


def _cache():
    return home() / "space.json"


def cached() -> str | None:
    """The cached id, if it was cached for the Space now named."""
    try:
        saved = json.loads(_cache().read_text())
        uuid, saved_title = saved["uuid"], saved["title"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if saved_title != title():
        return None
    return uuid if isinstance(uuid, str) and uuid else None


def forget() -> None:
    """Drop the cached id, after Perplexity refused it (the Space was deleted)."""
    _cache().unlink(missing_ok=True)


def title() -> str:
    return os.environ.get("VINAVU_SPACE", "").strip() or TITLE


PAGE = 50
MAX_PAGES = 20


def _listed(session: Any) -> list[dict[str, Any]]:
    """Every Space on the account, page by page.

    All pages, not the first: a Space missed on page two would read as
    deleted, and vinavu would make a second one.
    """
    found: list[dict[str, Any]] = []
    for page in range(MAX_PAGES):
        params = {**upstream.REST_PARAMS, "limit": PAGE, "offset": page * PAGE}
        r = session.get(f"{upstream.BASE_URL}/rest/collections/list_user_collections", params=params)
        if r.status_code != 200:
            raise SpaceError(f"listing Spaces failed: HTTP {r.status_code}")
        data = r.json()
        items = [c for c in data if isinstance(c, dict)] if isinstance(data, list) else []
        found.extend(items)
        if not items or not any(c.get("has_next_page") for c in items):
            return found
    raise SpaceError(f"the account has more than {PAGE * MAX_PAGES} Spaces")


def exists(session: Any, uuid: str) -> bool | None:
    """Whether the account still has the Space, or None if that cannot be told."""
    try:
        return any(c.get("uuid") == uuid for c in _listed(session))
    except (SpaceError, ValueError):
        return None


def resolve(session: Any) -> str:
    """The Space's id: cached, else found by title, else created."""
    uuid = cached()
    if uuid:
        return uuid
    name = title()
    match = [c for c in _listed(session) if c.get("title") == name and c.get("uuid")]
    if match:
        uuid = match[0]["uuid"]
    else:
        r = session.post(
            f"{upstream.BASE_URL}/rest/collections/create_collection",
            params=upstream.REST_PARAMS,
            json={
                "title": name,
                "description": "Asked from vinavu, the terminal client",
                "emoji": "1f4ac",
                "instructions": "",
                "access": 1,
            },
        )
        if r.status_code != 200 or not r.json().get("uuid"):
            raise SpaceError(f"creating the {name} Space failed: HTTP {r.status_code}")
        uuid = r.json()["uuid"]
    write_private(_cache(), json.dumps({"uuid": uuid, "title": name}))
    return uuid
