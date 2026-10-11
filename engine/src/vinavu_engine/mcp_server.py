"""One MCP tool, perplexity_ask, for agents.

One tool rather than one per model: an agent pays for every tool schema in its
context on every turn, and the model is a parameter.
"""

from __future__ import annotations

import re

import anyio
from mcp.server.mcpserver import MCPServer

from vinavu_engine import threads
from vinavu_engine.ask import AskError, Asker, Done

DESCRIPTION = (
    "Ask Perplexity, on the user's own Pro account. Use it for questions that need current "
    "information from the web, answers with sources, or what Perplexity remembers about the "
    "user from their past threads. Returns the answer with numbered source links, the sources, "
    "and a thread id: pass that id as follow_up to ask a follow-up in the same thread. "
    "model is 'best' unless the question needs another: 'research' runs Deep Research "
    "(minutes, thorough), or any Perplexity model id such as 'anthropic/claude-opus-4.7-thinking'."
)

_asker = Asker()


def _key(thread_id: str) -> str:
    return f"mcp:{thread_id}"


def format_answer(done: Done) -> str:
    lines = [done.content.strip()]
    if done.sources:
        # The sources the answer cites, under their own numbers: the rest of the
        # ten or so pages read would only fill the agent's context.
        cited = sorted({int(n) for n in re.findall(r"\[(\d{1,3})\]", done.content)} & set(range(1, len(done.sources) + 1)))
        numbers = cited or list(range(1, len(done.sources) + 1))
        lines.append("")
        lines.append("Sources:")
        lines.extend(f"[{n}] {done.sources[n - 1].title} <{done.sources[n - 1].url}>" for n in numbers)
    if done.thread:
        lines.append("")
        lines.append(f"Thread: {done.thread.backend_uuid} (pass as follow_up to continue)")
    if done.url:
        lines.append(f"Open in Perplexity: {done.url}")
    return "\n".join(lines)


def ask_blocking(question: str, model: str = "best", follow_up: str = "") -> str:
    thread = None
    if follow_up.strip():
        thread = threads.lookup(_key(follow_up.strip()))
        if thread is None:
            return f"Error: no thread {follow_up.strip()} is known here; ask without follow_up to start one."
    try:
        done = None
        for ev in _asker.ask(question, model=model, thread=thread, linked=True):
            if isinstance(ev, Done):
                done = ev
    except AskError as e:
        return f"Error ({e.kind}): {e}"
    if done is None:
        return "Error: Perplexity sent no answer."
    if done.thread:
        threads.remember(_key(done.thread.backend_uuid), done.thread)
    return format_answer(done)


def build() -> MCPServer:
    server = MCPServer("vinavu")

    @server.tool(name="perplexity_ask", description=DESCRIPTION, structured_output=False)
    async def perplexity_ask(question: str, model: str = "best", follow_up: str = "") -> str:
        # Off the event loop: an answer takes seconds, Deep Research minutes.
        return await anyio.to_thread.run_sync(ask_blocking, question, model, follow_up)

    return server


def run() -> None:
    build().run()
