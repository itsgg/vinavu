"""Every place vinavu reaches past perplexity-webui-scraper's public API.

The library keeps a conversation's continuation tokens inside its Conversation
object and builds that object only through its client. vinavu needs both
halves outside a single process: the CLI asks each question from a fresh
process, and the server answers turns of one conversation from different
requests. So the tokens are read out after an answer and put back before the
next one, and the thread's URL slug, which the library drops, is caught on the
way past. All of it is here, against the exact version pyproject.toml pins,
and tests/test_upstream.py runs it against a fake stream.
"""

from __future__ import annotations

from typing import Any

from perplexity_webui_scraper import ConversationConfig, Perplexity
from perplexity_webui_scraper._internal.constants import API_BASE_URL, API_VERSION, DEFAULT_HEADERS
from perplexity_webui_scraper.config.client import ClientConfig
from perplexity_webui_scraper.core.account import (
    AccountSession,
    ensure_file_access,
    ensure_model_access,
    model_for_account,
)
from perplexity_webui_scraper.core.conversation import Conversation


class Conversation_(Conversation):
    """The library's Conversation, plus the thread slug and settable tokens."""

    __slots__ = ("thread_slug", "tier")

    def __init__(self, http: Any, config: ConversationConfig) -> None:
        super().__init__(http, config)
        self.thread_slug: str | None = None
        # The account's tier, when the caller already knows it. The library
        # asks the server for it before every question, a round trip each
        # time; given it, the same checks run on what is known.
        self.tier: str | None = None

    def _validate_request_access(self, model: Any, has_files: bool) -> Any:
        if self.tier is None:
            return super()._validate_request_access(model, has_files)
        effective = AccountSession.model_validate({"user": {"subscription_tier": self.tier}})
        if model.status == "available":
            ensure_model_access(effective, model)
        ensure_file_access(self.tier, has_files)
        return model_for_account(model, self.tier)

    def _apply_sse_data(self, data: dict[str, Any]) -> None:
        slug = data.get("thread_url_slug")
        if isinstance(slug, str) and slug:
            self.thread_slug = slug
        super()._apply_sse_data(data)

    @property
    def tokens(self) -> tuple[str | None, str | None]:
        """(backend_uuid, read_write_token): what a follow-up needs."""
        return self._backend_uuid, self._read_write_token

    def resume(self, backend_uuid: str, read_write_token: str | None) -> None:
        """Make the next ask a follow-up in an existing thread."""
        self._backend_uuid = backend_uuid
        self._read_write_token = read_write_token


def client(token: str) -> Perplexity:
    # No request rate limit. The library's default spaces requests two seconds
    # apart, and every question is two requests back to back, as in the web
    # app, so it only added two seconds to each answer. A person typing
    # questions sets the pace.
    return Perplexity(token, config=ClientConfig(requests_per_second=0))


def conversation(perplexity: Perplexity, config: ConversationConfig) -> Conversation_:
    return Conversation_(perplexity._http, config)


def rest_session(token: str) -> Any:
    """A bare session for the REST calls the library does not wrap (Spaces)."""
    from curl_cffi.requests import Session

    from perplexity_webui_scraper._internal.constants import SESSION_COOKIE_NAME

    return Session(impersonate="chrome", headers=dict(DEFAULT_HEADERS), cookies={SESSION_COOKIE_NAME: token})


BASE_URL = API_BASE_URL
REST_PARAMS = {"version": API_VERSION, "source": "default"}
