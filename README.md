# opencode-background-agents

> The ShadCN for AI coding agents. Async delegation that just works.

A plugin for [OpenCode](https://github.com/sst/opencode) that enables background task delegation using the "waiter model" - fire off tasks to specialist agents, continue working, and get notified when results are ready.

## What is this?

`opencode-background-agents` replaces the native `task` tool with a persistent, async-first delegation system:

- **Fire-and-forget** - Launch tasks and immediately continue working
- **Waiter model** - You don't follow the waiter to the kitchen. Notifications arrive when ready.
- **Persistent results** - Delegation outputs are saved and survive context compaction
- **Human-readable IDs** - Results indexed by memorable names like `elegant-blue-tiger`

## Part of KDCO

This plugin is part of the [KDCO Registry](https://github.com/kdcokenny/ocx/tree/main/registry/src/kdco) - a collection of AI agent components for OpenCode. It works great standalone, but for the full experience we recommend `kdco-workspace`, which bundles background agents with specialist agents, planning tools, and research protocols.

## Installation (Recommended)

Install via [OCX](https://github.com/kdcokenny/ocx), the package manager for OpenCode extensions:

```bash
# Install OCX
curl -fsSL https://ocx.kdco.dev/install.sh | sh
# Or: npm install -g ocx

# Initialize OCX in your project
ocx init

# Add the KDCO registry
ocx registry add --name kdco https://registry.kdco.dev

# Install background agents
ocx add kdco-background-agents
```

Want the full workspace instead? It includes background agents plus specialist agents and protocols:

```bash
ocx add kdco-workspace
```

## Manual Installation

You can copy the source files directly into your `.opencode/` directory if you prefer not to use OCX.

**Caveats:**
- You'll need to manually install dependencies (`unique-names-generator`)
- Updates require manual re-copying
- Dependency resolution is your responsibility

The source is in [`src/`](./src) - copy the plugin file to `.opencode/plugin/kdco-background-agents.ts`.

## Features

### The Waiter Model

Traditional task delegation blocks your workflow. Background agents work differently:

1. **Order** - Request work with clear instructions
2. **Trust** - The agent handles it while you continue working
3. **Delivery** - A notification arrives with the complete result

### Event-Driven Notifications

No polling. When delegations complete, you receive a `<system-reminder>` with:
- Human-readable ID
- Auto-generated title and description
- Status (complete, timeout, or error)

### Persistent Results

All delegation outputs are persisted to `~/.local/share/opencode/delegations/`. Results survive:
- Context compaction
- Session restarts
- Process crashes

Retrieve any result with `delegation_read("elegant-blue-tiger")`.

## Usage

The plugin adds three tools:

```typescript
// Launch async task
delegate(prompt: "Research OAuth2 PKCE for SPAs...", agent: "explore")

// List all delegations (use sparingly)
delegation_list()

// Read result by ID
delegation_read("elegant-blue-tiger")
```

## Source

The implementation is in [`src/`](./src). It's TypeScript, fully readable, and designed to be forked and customized.

## License

MIT
