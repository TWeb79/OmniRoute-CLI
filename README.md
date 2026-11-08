# OmniRoute-CLI

A lightweight, CLI-based AI gateway that runs as a backend service.  
One OpenAI-compatible endpoint, multiple providers, file-based config — no dashboard, no database, no Electron.

Also bridges Anthropic's `/v1/messages` API, so tools like Claude Code can point at it directly without format translation on the client side.

Inspired by [OmniRoute](https://github.com/cheaper-inference/OmniRoute).

## Quick start

```bash
# Install
npm install -g omniroute-cli

# Configure
cp config.example.yml config.yml
# edit config.yml — add your API keys

# Start
omniroute-cli start
# or with a custom config path:
omniroute-cli start --config /path/to/config.yml
```

The server starts on `http://localhost:20128/v1` by default.

## Use with Claude Code

```bash
# no /v1 — the client appends /v1/messages itself
ANTHROPIC_BASE_URL=http://localhost:20128 \
ANTHROPIC_API_KEY=your-local-key \
claude
```

## Use with Cursor / other OpenAI-compatible tools

Point your tool at:
- Base URL: `http://localhost:20128/v1`
- API key: whatever you set in `auth.api_key` (or any string if auth is disabled); both `Authorization: Bearer` and `x-api-key` are accepted

## Configuration

See [`config.example.yml`](config.example.yml) for all options.

| Field | Description |
|---|---|
| `port` | Server port (default: 20128) |
| `host` | Bind address (default: `127.0.0.1`; use `0.0.0.0` only with `auth.enabled`) |
| `providers[].name` | Display name |
| `providers[].api_key` | API key — supports `${ENV_VAR}` |
| `providers[].base_url` | Provider's OpenAI-compatible base URL |
| `providers[].models` | Model IDs this provider serves |
| `providers[].priority` | Lower number = tried first |
| `routing.strategy` | `priority` / `round-robin` / `random` |
| `routing.fallback` | Try next provider on error |
| `auth.enabled` | Require bearer token |
| `auth.api_key` | Required token value |

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/v1/models` | List all configured models |
| `POST` | `/v1/chat/completions` | Proxy chat completions (OpenAI format) |
| `POST` | `/v1/messages` | Proxy completions (Anthropic format, incl. tools and streaming — translated internally) |
| `POST` | `/v1/messages/count_tokens` | Rough token estimate (~4 chars/token) |

## Build from source

```bash
npm install
npm run build
node dist/index.js start
```

## License

MIT
