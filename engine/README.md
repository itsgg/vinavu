# vinavu-engine

The Python half of [vinavu](../README.md): it holds the Perplexity session and
speaks to Perplexity's web endpoint through
[perplexity-webui-scraper](https://github.com/henrique-coder/perplexity-webui-scraper).
The `vinavu` CLI runs `vinavu-engine ask` for each question; `serve` and `mcp`
expose the same asks to OpenAI clients and to agents.
