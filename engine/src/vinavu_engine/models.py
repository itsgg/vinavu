"""Model names: short aliases over the scraper's registry."""

from __future__ import annotations

from dataclasses import dataclass

from perplexity_webui_scraper import MODELS

DEFAULT = "best"

# The few names worth typing. Anything in the registry also works by its full
# id ("anthropic/claude-opus-4.7-thinking") or by the part after the slash
# when that is unambiguous ("claude-opus-4.7-thinking").
ALIASES: dict[str, str] = {
    "best": "perplexity/best",
    "pro": "perplexity/best",
    "research": "perplexity/deep-research",
    "deep": "perplexity/deep-research",
    "sonar": "perplexity/sonar-2",
}


class UnknownModel(Exception):
    pass


@dataclass(frozen=True)
class Listed:
    id: str
    name: str
    status: str


def resolve(name: str | None) -> str:
    """The registry id for an alias, a full id or an unambiguous short name."""
    wanted = (name or DEFAULT).strip()
    if wanted.lower() in ALIASES:
        return ALIASES[wanted.lower()]
    ids = [m.id for m in MODELS.list_all()]
    if wanted in ids:
        return wanted
    short = [i for i in ids if i.split("/", 1)[-1] == wanted]
    if len(short) == 1:
        return short[0]
    near = [i for i in ids if wanted.lower() in i.lower()]
    if len(short) > 1:
        raise UnknownModel(f"{wanted} is ambiguous: {', '.join(short)}")
    hint = f"; did you mean {', '.join(near[:5])}?" if near else "; `vinavu models` lists them"
    raise UnknownModel(f"unknown model {wanted}{hint}")


def listing() -> list[Listed]:
    """Aliases first, then every registered model that is not known broken."""
    out = [Listed(alias, f"alias for {target}", "alias") for alias, target in ALIASES.items()]
    for m in MODELS.list_all():
        if m.status != "unavailable":
            out.append(Listed(m.id, m.name, m.status))
    return out
