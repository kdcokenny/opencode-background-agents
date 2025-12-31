# OpenCode Background Agents

Async delegation system for [OpenCode](https://opencode.ai). Run parallel research tasks using the waiter model while you continue working.

## Installation

### CLI (Recommended)

```bash
npx ocx add kdco/kdco-background-agents
```

### Manual

Copy files from `src/` to your project's `.opencode/` directory:

```
.opencode/
├── plugin/
│   └── kdco-background-agents.ts
└── skill/
    └── kdco-background-protocol/
        └── SKILL.md
```

## Features

- **Waiter Model** - Delegate tasks and get notified when complete. No polling.
- **Parallel Execution** - Launch multiple agents simultaneously for faster research.
- **Persistent Results** - Delegation outputs survive across sessions.
- **Event-Driven** - System notifications tell you when work is done.

## Usage

Once installed, you have access to three tools:

| Tool | Description |
|------|-------------|
| `delegate` | Launch a background agent with a task |
| `delegation_list` | List all delegations for the session |
| `delegation_read` | Retrieve results from a completed delegation |

### Example

```
You: Research the differences between Bun and Node.js performance

Agent: I'll delegate this research task.
[Uses delegate tool with agent: "general"]

Agent: I've delegated the research. I'll continue with other work...

[System notification: Delegation complete]

Agent: The research is complete. Let me retrieve the results.
[Uses delegation_read tool]
```

## Available Agents

| Agent | Use Case |
|-------|----------|
| `general` | Multi-step tasks, complex research |
| `explore` | Codebase exploration, file search |

## Want More?

For specialized agents (librarian, writer) and planning tools, check out the full [KDCO Workspace](https://github.com/kdcokenny/ocx).

## License

MIT
