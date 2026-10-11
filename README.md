# vinavu

Ask Perplexity from your terminal, on your own Perplexity Pro account.
Streaming answers rendered as markdown with their sources, sessions that follow
up in the same Perplexity thread, file uploads, and an interactive chat. The
same engine serves an OpenAI-compatible API for any client that speaks one, and
an MCP tool for agents.

```
$ vinavu "Capital of Japan? One sentence."

Tokyo is the capital of Japan.[1]

Sources
1  What is the capital of Japan? | Britannica  britannica.com
```

> Unofficial. vinavu drives Perplexity's web endpoint with your browser's
> sign-in, the way the web app does. It is not affiliated with or endorsed by
> Perplexity, and automating the web app is outside its terms: your account is
> what is at risk. Use it at a human pace.

vinavu (வினவு) is Tamil for "ask, inquire".

## Why

Perplexity sells API access (Sonar, the Agent API), billed per call and
separate from the subscription. vinavu uses the subscription you already pay
for, with everything it includes: Pro Search, Deep Research, the models the
Pro plan offers (`vinavu models` lists them), and Perplexity's memory of you. That memory only answers in threads that are
saved, so vinavu saves its threads into one Space (Perplexity now calls them
projects) named `vinavu`, keeping the main library for what you ask in the
browser.

## Install

Needs Node 18+, Python 3.12+ and [uv](https://docs.astral.sh/uv/), and a
Perplexity sign-in in Chromium (or Chrome, or Brave).

```bash
git clone https://github.com/itsgg/vinavu.git
cd vinavu
make install          # the engine as a uv tool, the CLI through npm link
vinavu doctor
```

`vinavu doctor` reads your sign-in, checks the account tier, and finds or
creates the `vinavu` Space.

## Usage

```bash
vinavu "question"                    # one-shot answer, with the sources it cites
vinavu                               # interactive chat (REPL)
echo "question" | vinavu             # read from stdin

vinavu -s work "remember this"       # named session: one Perplexity thread
vinavu -s work "what did I say?"     # follows up in that thread
vinavu -c "follow up"                # continue the most recent session

vinavu -r "state of solid-state batteries in 2026"   # Deep Research
vinavu -m anthropic/claude-opus-4.7-thinking "..."   # any Pro model
vinavu -f paper.pdf "summarise the method"           # PDFs and images upload
vinavu -f notes.md "tighten this"                    # text files are pasted in

vinavu --json "..."                  # one JSON object: content, sources, url
vinavu --no-sources "..."            # just the answer
vinavu models                        # every model name
```

### Options

| Flag | Meaning |
|------|---------|
| `-s, --session NAME` | Use or resume a named session (one Perplexity thread) |
| `-c, --continue` | Resume the most recent session |
| `--new` | Start a new thread, even in a saved session |
| `-m, --model NAME` | `best` (default), `research`, `sonar`, or any model id |
| `-r, --research` | Deep Research; same as `-m research` |
| `-f, --file PATH` | Attach a file (repeatable) |
| `-y, --system TEXT` | Prepend a steering instruction to each question |
| `-t, --timeout SECONDS` | Give up after this long without a word from the engine |
| `-i, --interactive` | Open the REPL (asks the given question first) |
| `--list` | List saved sessions |
| `--raw` | Plain text, no color or markdown styling |
| `--json` | One JSON object instead of a rendered answer (one-shot only) |
| `--markdown` | The answer as raw Markdown, written as it arrives, then its cited sources as links (one-shot only) |
| `--follow-within MINUTES` | Follow up in the session's thread only if its last answer is under MINUTES old |
| `--no-sources` | Leave out the source list |
| `-q, --quiet` | No spinner or progress line |

Model names: `best` is Perplexity's own pick for the account (Pro Search on
Pro). Any registered id works, as does the part after the slash when it is
unambiguous (`claude-opus-4.7-thinking`). `vinavu models` lists them.

### Sources

Perplexity reads around ten pages for an answer and usually cites a few. The
list under an answer names only the cited ones, under the numbers the answer's
`[n]` markers use; in a terminal with OSC 8 links each title opens its page.
In the REPL, `/sources` lists everything that was read.

### In the REPL

The REPL is nithi's: append-only output in your terminal's own scrollback,
your terminal's palette, OSC 133 prompt marks to jump between turns, and a
numbered rule closing each turn.

```
@path in a message      attach a file
/model [NAME|default]   show or set this session's model
/sources                list the last answer's sources again
/open                   open this session's thread on perplexity.ai
/session [NAME]         show or switch/resume a session
/sessions               list saved sessions
/system [TEXT|clear]    show/set/clear a steering instruction
/new                    start a new session
/retry                  ask the last question again
/edit [TEXT]            compose the message in $EDITOR
/copy                   copy the last answer to the clipboard
/save PATH              write the session to a markdown file
/history                replay this session's turns
/forget NAME            delete a saved session
/clear                  clear the screen
/exit                   quit
```

### In a launcher

`--markdown` is for a program that draws the answer itself. With
`--follow-within`, one session behaves like a chat that forgets after a
pause: a question within ten minutes of the last answer follows it, a later
one starts a new thread. In [Nodi](https://github.com/itsgg/omarchy-nodi),
as an answer in `nodi.json`:

```jsonc
"answers": [
  { "keyword": "pp", "title": "Perplexity", "timeoutMs": 180000,
    "command": ["bash", "-lc", "printf '%s' \"$NODI_QUERY\" | exec vinavu --markdown -s nodi --follow-within 10", "nodi-pp"] }
]
```

`pp <question>` then streams Perplexity's answer into Nodi's pane. The
question goes through stdin, never an argument, and `bash -l` puts a version
manager's shims on PATH (with mise, run `mise reshim` once after `make
install` so `vinavu` has one).

## OpenAI-compatible server

```bash
vinavu serve                      # http://127.0.0.1:8790/v1
```

Point any OpenAI client at `http://127.0.0.1:8790/v1` with any API key. Model
names are vinavu's (`best`, `research`, `sonar`, or a full id). Answers carry
their citations as markdown links in the text, plus the `citations` and
`search_results` fields Perplexity's own API returns.

```bash
curl -s http://127.0.0.1:8790/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"best","messages":[{"role":"user","content":"Capital of Australia?"}]}'
```

Conversations continue their Perplexity thread. An OpenAI client resends the
whole history every turn and names no thread, so after each answer the engine
maps a hash of the conversation so far (user and assistant turns, as sent) to
its thread. A request whose history matches is asked as a follow-up; any other
history, from another model or with edited answers, is folded into a new
question with the roles named. System messages become instructions at the
start of a new thread. Images arrive as base64 data URIs and are uploaded.

The server binds to 127.0.0.1 and needs no key. Set `VINAVU_API_KEY` to make it
demand one, and pass `--host` to listen wider.

As a systemd user service:

```bash
cp contrib/vinavu.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vinavu
```

## MCP

```bash
vinavu mcp                        # stdio, one tool: perplexity_ask
```

One tool rather than one per model, since an agent carries every tool schema
in its context on every turn. `perplexity_ask(question, model="best",
follow_up="")` returns the answer with linked citations, the sources, and a
thread id to pass back as `follow_up`. In Claude Code's format:

```json
{ "mcpServers": { "vinavu": { "command": "vinavu-engine", "args": ["mcp"] } } }
```

## Environment

| Variable | Effect |
|----------|--------|
| `VINAVU_SAVE` | `space` (default), `library`, or `incognito` (no memory, no trace) |
| `VINAVU_SPACE` | The Space's title, default `vinavu` |
| `VINAVU_BROWSER` | Where the sign-in is read from: `chromium`, `chrome` or `brave` (default: the first that has one) |
| `VINAVU_COOKIES` | A cookie database to read instead of searching |
| `VINAVU_SESSION_TOKEN` | Use this session token instead of the browser's |
| `VINAVU_ENGINE` | The engine command, default `vinavu-engine` |
| `VINAVU_HOME` | Sessions, the thread map and the Space id, default `~/.local/state/vinavu` |
| `VINAVU_API_KEY` | Make the server demand this key |
| `VINAVU_TIMEOUT_MS` | Default inactivity timeout, 180000 (Deep Research gets 30 minutes) |
| `NO_COLOR`, `FORCE_COLOR`, `NO_HYPERLINKS` | As in nithi |

## How it works

Two halves. The CLI (TypeScript, from [nithi](https://github.com/itsgg/nithi))
renders; the engine (Python) talks to Perplexity through
[perplexity-webui-scraper](https://github.com/henrique-coder/perplexity-webui-scraper),
which speaks the web app's private SSE endpoint with a Chrome TLS fingerprint.
Each question runs `vinavu-engine ask`: one JSON request on stdin, one JSON
event per line on stdout (status, sources, text, done or error). A process per
question costs about half a second against answers of five to fifteen, and
leaves no daemon to manage.

The session token is read from the browser's cookie store on every start,
decrypted with the browser's keyring secret, and never copied: next-auth rotates
it as the browser uses the site, so a copy goes stale and the browser's never
does. A refused token is read again and the question retried once, but only
before any of the answer has been shown.

A follow-up needs two tokens from the previous answer (its backend id and a
read-write token). The library keeps them inside a conversation object; vinavu
reads them out after each answer and puts them back before the next, from
whichever process asks. That, and catching the thread's URL slug, are the only
places vinavu reaches past the library's public API. They live in
`engine/src/vinavu_engine/upstream.py`, against the exact library version
`pyproject.toml` pins, with tests that run them against a fake stream.

The library's default rate limit of one request per two seconds is turned off:
each question is two requests back to back, as in the web app, and the limit
only added two seconds to every answer.

## Development

```bash
make test            # engine (pytest) and CLI (node --test)
make typecheck
```

| Path | Responsibility |
|------|----------------|
| `engine/src/vinavu_engine/token.py` | Reading and decrypting the browser's session cookie |
| `engine/src/vinavu_engine/ask.py` | One question as a stream of events; retries; error kinds |
| `engine/src/vinavu_engine/upstream.py` | Every use of the library's internals |
| `engine/src/vinavu_engine/space.py` | Finding or creating the Space |
| `engine/src/vinavu_engine/openai.py`, `server.py` | The OpenAI API, and threads for resent histories |
| `engine/src/vinavu_engine/mcp_server.py` | The MCP tool |
| `src/engine.ts` | Running the engine and reading its events |
| `src/cli.ts`, `render.ts`, `stream.ts`, `session.ts` | nithi's CLI, renderer and sessions |

## License

MIT
