# pe — a coding assistant CLI

`pe` is a command-line client for chatting with pé through the **fuco-agent worker** (a Cloudflare Worker, OpenAI-compatible).
All three milestones are complete: **Step 0** (`ask`/`chat`/`init`/`doctor`/`model` + file/image attachments), **Step 1** (an agent with tools inside your project: `pe do`, `pe edit`, `pe undo`), **Step 2** (persistent chat sessions + auto-compact + `pe assign` for long-running tasks via a queue), **Step 3** (packaged as a single `.exe`). It also includes streaming and per-project memory.

## Installation

Requires Node.js ≥ 18. Zero external dependencies.

```bash
git clone https://github.com/ndtp0908/fuco-cli.git
cd fuco-cli
npm link        # makes `pe` available everywhere (or run: node src/pe.mjs ...)
```

## First-time setup

```bash
pe init
```

The wizard asks for the Worker URL, the **Proxy secret** (`MY_SECRET` on the worker, entered hidden) and the default model (must end in `:free`), saves them to `~/.pe/config.json` (mode 600), then tests the connection right away.

**Configuration is global**: run `pe init` once and it works in **every project directory**. Environment variables override the file when present: `PE_WORKER_URL`, `PE_PROXY_SECRET`, `PE_MODEL`, `PE_APPROVAL`, `PE_HOME`.

### Managing configuration (v0.10)

No need to hunt for files anymore — everything is visible and editable from the CLI itself:

```bash
pe config                 # overview: every effective value + its source
                          # (env / project / file / default), plus the state
                          # of context.md, lessons.md, .muserules
pe config get model       # read one value (secrets are always masked)
pe config set <key> <value>            # write to the global config
pe config set --project model <id>     # write to the project's .pe/config.json
pe config edit [global|project|context|lessons|rules]   # open the file in your editor
pe config path            # print all important paths
```

Global keys: `workerUrl`, `peWorkerUrl`, `proxySecret`, `model`, `approval`, `fallbackModels`, `updateUrl`.

### Per-project configuration + memory (optional)

```bash
cd my-project
pe init --project
```

Creates a `.pe/` folder in the project:

- `.pe/config.json` — overrides `model` and the approval level for this project only (secrets are never read from a project).
- `.pe/context.md` — **project memory**: write your stack, code conventions, build/test commands... Pé loads it into every question while you are inside the project (including subfolders). Precedence: environment variables > `.pe/config.json` > `~/.pe/config.json`.

## Usage

```bash
pe ask "explain this piece of code"        # STREAMING answer, text flows live
pe chat                                     # continuous conversation (agent built in)
pe do "add divide-by-zero handling to Calculator.cs, then build"
pe edit src\Calculator.cs "add a divide-by-zero check"   # shows a diff, writes only after you approve
pe undo src\Calculator.cs                   # roll back to the version before pé edited it
pe doctor                                   # check configuration + worker connection
pe model list                               # list :free models
pe help do                                  # detailed help for each command
```

### File / image attachments (ask & chat)

```bash
pe ask "review this file" --file src\Program.cs        # ≤ 256 KB/file
pe ask "what is wrong in this screenshot" --image err.png   # needs a vision :free model
pe ask "fix the bug in @src\Helper.cs please"           # @path right inside the question
type Program.cs | pe ask "find the bug"                 # stdin is sent as a file
```

Inside `pe chat`: `/file`, `/image` stage an attachment for the next message, `/attach` shows what is staged.
The default model cannot see images — use a vision `:free` model, e.g. `nvidia/nemotron-3.5-super-vl:free` (the CLI suggests one automatically when you pick wrong).

### Agent & approval levels (Step 1)

`pe do "<task>"` and `pe chat` (tools on by default, disable with `/tools off`) let the model use tools right inside your project: `read_file`, `write_file`, `edit_file`, `list_files`, `grep`, `run_bash`. The model calls tools via native tool-calls or JSON blocks (automatic fallback). Every operation is locked inside the project folder; every file write is **backed up first** to `~/.pe/backups`, so `pe undo` can always restore it.

Approval levels (`pe do --approval`, `/approval` in chat, or `approval` in config):

- **1** — ask before every edit/command
- **2** — (default) read + write freely inside the project, ask for unfamiliar shell commands, read-only commands (git status, ls...) run automatically
- **3** — `--yolo`: everything goes, only destructive commands are hard-blocked (format, rm -rf /, ...)

Also in chat: `/tools on|off`, `/approval 1|2|3`, `/undo [file]`, `/model`, `/models`, `/web on|off`, `/lesson <text>`, `/clear`, `/help`.

`pe edit` is the short path for company code workflow: pé proposes an edit → shows a **diff** → you approve → only then it writes (with backup). `--dry` previews the diff only, `--yes` writes immediately without asking. If the model's reply is malformed, `pe edit` retries once with the specific problem fed back (v0.9).

## Better every day

**Self-healing agent (v0.9):** if the model tries to finish while tool errors are still unresolved, the agent refuses to end the turn and makes it fix them (1 extra "heal" round). `pe do "<task>" --verify "<command>"` runs a verification command after the work; on failure the output goes back to the agent for up to 2 fix rounds.

**Lessons learned (v0.8):** when the agent makes a mistake during `pe do`/`pe chat` but fixes it, pé distills a short lesson (Mistake / Root cause / Next time) and **asks for your approval** before saving it to `.pe/lessons.md` (project) or `~/.pe/lessons.md` (global). Lessons are reloaded into the system prompt of later sessions; a repeated mistake bumps a counter (×2, ×3...) instead of duplicating. Manage them with `pe lessons`, `/lesson` in chat, and export them to Cline via `pe rules export`.

**Smarter loop detection (v0.6):** loops are detected by *progress* (same tool + same args + identical result 3 times in a row), not by call count — long paged file reads no longer trigger false loop alarms. `read_file` pages at 400 lines with a footer pointing to the next `start`.

**Web search (v0.7):** `pe ask --web`, `pe do --web`, `pe chat --web` (or `/web on`) — the worker searches the web server-side and injects results + sources into the answer.

**Polish (v0.5.x):** network errors give specific hints (SELF_SIGNED_CERT_IN_CHAIN → corporate proxy CA guidance via `NODE_EXTRA_CA_CERTS`). `pe backup [--out]` / `pe restore <file> [--force]` pack the entire state (config + all chat sessions + assigned tasks) into one password-encrypted `.pebak` file; restore on a new machine brings everything back.

**Corporate machine pack (v0.4):**

- `pe connect export` → generates a connection code encrypted with a password; on a new machine just run `pe init --code <code>` and the configuration is done — no typing long URLs/secrets.
- `pe update [--check]` → checks for a new version via the manifest `release/pe-update.json`, downloads it, **verifies SHA256**, then replaces the exe (the old one is kept as `.old`).
- `pe result <id> --apply` → when an assign result contains files, review the diff and write them straight into the current project (with backup).

**Stable models:**

- **Automatic fallback models**: when the main model is congested / rate-limited / renamed (429/5xx/model 400), the CLI automatically switches to a fallback free model (set via `fallbackModels` in config or `PE_FALLBACK_MODELS`) and clearly reports which model is serving.
- `pe model list --vision` filters vision-capable models; pressing **Ctrl+C** in chat cancels the current turn without leaving the session.

**Cline + pe unified:**

- `pe rules [install|export|import]` — one project memory for both tools: pé loads both `.pe/context.md` and `.muserules`; `install` adds pé's standard Cline rule pack (read before editing, never loop more than twice, verify before claiming done...).
- `pe chat` automatically resumes the session belonging to the project you are standing in (`/new` starts a fresh one).

## Tests

```bash
npm test   # 84 checks: config/env/project override, mock worker (wrong secret,
           # non-free model, network down), streaming SSE, file/image/@mention/
           # stdin attachments, per-command help, pe edit + undo, the pe do
           # agent (read→edit a file), glob list_files, multi-tool JSON chat,
           # sessions + resume + rm, auto-compact, assign/tasks/result, lessons
           # (distill/approve/dedupe), heal rounds, edit retry, --verify,
           # pe config get/set, connect/backup/restore, update manifest
```

## Design decisions (D1–D7, settled)

- Command name `pe` (D1); dedicated repo `ndtp0908/fuco-cli` (D7)
- `pe assign` sends long tasks through the KV queue (D2) — done in Step 2
- Default approval level 2 (D3) — in real use since Step 1
- Default model = the same free model as the app, change with `/model` or `pe model` (D4)
- Secrets live in `~/.pe/config.json` via the wizard, env overrides (D5)
- Packaged as a single `.exe` with Node SEA (D6) — Step 3

## Chat sessions & long-running tasks (Step 2)

```bash
pe chat                 # the session auto-saves to ~/.pe/sessions after every turn
pe chat --resume        # reopen the latest session (even after shutting down)
pe sessions             # list saved sessions
pe sessions rm <id>     # delete one session (v0.10)
pe assign "review the login PR, look for security issues" --type review   # hand a task to pé
pe tasks                # view the queue
pe result <task_id>     # fetch the result (or add --wait to assign)
```

Long chats **auto-compact**: when the history exceeds ~75% of the limit (default 100k tokens, change with `PE_CONTEXT_LIMIT`), pé summarizes the oldest messages and keeps the 12 most recent ones — the summary is stored inside the session, so resuming stays seamless.

`pe assign` pushes the task into the pe-worker KV queue; pé processes it on a cycle (08:00–21:30, Mon–Sat). Types: `ask | review | plan | analyze | research | transform`.

## Packaging the .exe (Step 3)

```bash
npm install
npm run build:exe        # build for the current OS -> dist-exe/pe
npm run build:exe:win    # download the Windows x64 node.exe -> dist-exe/pe.exe (~90 MB)
```

The `.exe` runs standalone — **no Node installation needed**. Because it is self-packaged (Node SEA, a blob injected into node.exe), Windows may show "unknown publisher"/SmartScreen the first time — choose *More info → Run anyway*.

## Roadmap

- ✅ Step 0: ask/chat/init/doctor/model (+ attachments, detailed help, streaming, project memory)
- ✅ Step 1: agent + tools, `pe do`, `pe edit`/`pe undo`
- ✅ Step 2: persistent chat sessions + auto-compact, `pe assign` via the KV queue
- ✅ Step 3: single-file `.exe` packaging with Node SEA
- ✅ v0.4–v0.10: connect codes, self-update, backup/restore, model fallback chain, Cline rules sync, web search, lessons learned, self-healing agent, full config manager in the CLI, Vietnamese UI with full diacritics
