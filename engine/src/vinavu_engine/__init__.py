"""Perplexity Pro from the terminal, an OpenAI-compatible server and an MCP tool."""

__version__ = "0.1.0"

# Where `vinavu-engine serve` listens unless told otherwise. Here, not in
# server.py, so reading them does not import the web stack: `ask` runs for
# every question and must not pay for FastAPI.
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8790
