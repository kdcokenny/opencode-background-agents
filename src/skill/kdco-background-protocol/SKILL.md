---
name: kdco-background-protocol
description: Guidelines for delegating work to specialist agents using the waiter model. Use when parallelizing research, routing to specialists, or managing background tasks.
---

# Delegation Protocol

<critical-constraints>

## CRITICAL: NEVER POLL FOR STATUS

**ABSOLUTE RULE:** After delegating, you MUST NOT call `delegation_list` to check if delegations are complete.

❌ **NEVER DO THIS:**
```
delegate(prompt: "...", agent: "kdco-librarian")
delegation_list()  // "Let me check if it's done..."
delegation_list()  // "Still running, let me check again..."
delegation_list()  // Polling wastes context and is FORBIDDEN
```

✅ **ALWAYS DO THIS:**
```
delegate(prompt: "...", agent: "kdco-librarian")
// Tell user: "Research is underway. I'll present findings when complete."
// Continue with OTHER productive work or WAIT for notification
// System WILL notify you when ALL delegations complete
```

**WHY:** Polling burns context without providing new information. The system sends a notification when delegations complete. Trust it.

**WHAT TO SAY TO USER:** "I've delegated the research. I'll synthesize and present the findings once complete."

</critical-constraints>

<philosophy>

## Core Philosophy: The Waiter Model

Delegation follows the waiter model:

1. **Order** - You request work with clear instructions
2. **Trust** - They disappear to handle it; you continue your work  
3. **Delivery** - They return with the complete result

You don't follow the waiter to the kitchen. You don't ask for progress updates.
You are the user's senior delegate - handle coordination automatically.

### Your Role: Senior Delegate

You are the user's senior delegate - like an EA to an executive or a Single-Threaded Owner at Amazon.

When you delegate to specialists:
- You handle ALL intermediate coordination
- You synthesize results automatically when they arrive
- You present COMPLETE answers to the user
- The user should NEVER have to say "continue" or "what's the status"

The user is the manager. Don't burden them with coordination work.

### Guarantees

- **Batched notification** - When ALL delegations complete, you receive a trigger notification
- **Individual notifications** - Each completion adds a silent notification to context
- **5-minute timeout** - Every delegation results in notification within 5 minutes (success/fail/timeout)
- **Artifacts are filed** - Results persist and can be retrieved via `delegation_list` and `delegation_read`

</philosophy>

<tools>

## Tools

### delegate(prompt, agent)

Routes work to a specialist agent. Returns immediately with a readable ID.

**Parameters:**
- `prompt` (required): Complete instructions for the agent. Must be self-contained.
- `agent` (required): The specialist to route to. See Agent Selection below.

**Returns:** Readable ID (e.g., `elegant-blue-tiger`)

**Example:**
```
delegate(
  prompt: "Research OAuth2 PKCE flow implementation for SPAs. Include: 
           1) Security considerations, 2) Token refresh patterns, 
           3) Code examples from popular libraries.",
  agent: "kdco-librarian"
)
```

### delegation_list()

Shows all delegations with auto-generated metadata. Use this to recall what 
research you have available, especially after context compaction.

**Output format:**
```
elegant-blue-tiger | OAuth2 PKCE Implementation | complete
  -> Best practices for SPA authentication using PKCE flow...

quiet-autumn-mesa  | React Component Patterns   | running
  -> (generating...)
```

### delegation_read(id)

Retrieves filed research by its readable ID.

**Parameters:**
- `id` (required): The readable ID from delegation_list or the completion notification

**Behavior:** 
- If delegation is **complete**: Returns result immediately
- If delegation is **still running**: BLOCKS until complete

</tools>

<agents>

## Agent Selection: Intentional Routing

Route to the right specialist. Each agent has a specific competency.

| Agent | Specialty | Route Here When |
|-------|-----------|-----------------|
| `kdco-librarian` | External research | Need docs, GitHub examples, web resources, API references |
| `kdco-writer` | Human-facing content | Crafting commits, docs, PRs, explanations |
| `explore` | Codebase exploration | Understanding internal code structure, finding patterns |
| `general` | Multi-step execution | Complex tasks requiring multiple tools, file modifications |

**The Routing Principle:** A librarian researches; a writer crafts. Don't send 
research tasks to the writer. Don't send content creation to the librarian.
Route with intention, like assigning work to departments in an organization.

</agents>

<prompts>

## Writing Effective Prompts

The agent receiving your delegation has NO access to your conversation history.
Your prompt must be entirely self-contained.

### Include:

1. **Clear objective** - What exactly do you need?
2. **Context** - Why do you need it? What problem are you solving?
3. **Constraints** - Any limitations, preferences, or requirements?
4. **Output format** - How should results be structured?

### Good Prompt:
```
Research authentication patterns for Next.js App Router applications.

Context: Building a SaaS app that needs OAuth2 with multiple providers 
(Google, GitHub). Using Next.js 14 with App Router.

Need:
1. Recommended libraries (next-auth, lucia, etc.) with tradeoffs
2. Session management patterns for App Router
3. Code examples for protected routes
4. Security best practices

Format: Summarize each option with pros/cons, then recommend best approach.
```

### Bad Prompt:
```
Find auth stuff for the project we discussed.
```

The agent doesn't know "the project" or what you "discussed."

</prompts>

<workflow>

## Workflow Pattern

### Launch in Parallel

When you have multiple independent research needs, launch ALL delegations
in a single message:

```
// CORRECT: Single message, parallel execution
delegate(prompt: "Research OAuth2...", agent: "kdco-librarian")
delegate(prompt: "Find React patterns...", agent: "kdco-librarian")
delegate(prompt: "Explore auth code...", agent: "explore")
```

All three run concurrently. You receive a trigger notification when ALL complete.

### Continue Productive Work

After delegating, immediately continue with work you CAN do:
- Implement features that don't depend on the research
- Review existing code
- Write tests
- Plan next steps

NEVER sit idle waiting for delegations.

### Handle Notifications

When all delegations complete, you receive a trigger notification:

```
<system-reminder>
All delegations complete.

Completed:
- elegant-blue-tiger | OAuth2 PKCE Implementation Guide
- quiet-autumn-mesa | React Component Patterns

Use delegation_read(id) to retrieve full results.
</system-reminder>
```

Synthesize the results and present a complete answer to the user.

### Failure Notifications

If a delegation times out or fails, you still receive notification:

```
<system-reminder>
Delegation failed.

**ID:** elegant-blue-tiger
**Status:** timeout
**Reason:** Exceeded 5 minute limit

Consider retrying with a more focused prompt or breaking into smaller tasks.
</system-reminder>
```

</workflow>

<anti-patterns>

## Anti-Patterns

### Never Poll or Check Status

```
// WRONG: Polling
delegation_list()  // "Is it done yet?"
// ... wait ...
delegation_list()  // "How about now?"
```

You WILL be notified. Trust the system.

### Never Launch Sequentially When Parallel is Possible

```
// WRONG: Sequential launches
delegate(prompt: "Research A...", agent: "kdco-librarian")
// wait for notification
delegate(prompt: "Research B...", agent: "kdco-librarian")

// CORRECT: Parallel launches
delegate(prompt: "Research A...", agent: "kdco-librarian")
delegate(prompt: "Research B...", agent: "kdco-librarian")
```

### Never Wait Idle

```
// WRONG: Doing nothing while waiting
delegate(prompt: "...", agent: "kdco-librarian")
// ... sit and wait ...

// CORRECT: Continue productive work
delegate(prompt: "...", agent: "kdco-librarian")
// immediately continue with other tasks
```

### Never Burden the User with Coordination

```
// WRONG: Asking user to continue
"The research is complete. Should I continue?"
"I received the results. What would you like me to do next?"

// CORRECT: Handle automatically
// Synthesize results, present complete answer
"Based on the research, here's my recommendation..."
```

</anti-patterns>

<guidelines>

## When to Delegate vs Do Directly

### Delegate When:
- External research is needed (docs, GitHub, web)
- Work is independent and can run in background
- Task requires specialized tools you don't have
- You want to parallelize effort

### Do Directly When:
- You already have the information
- Task is faster to do than to explain
- Work depends on delegation results (do it after notification)
- Simple file reads or edits in the current codebase

## Limitations

- Delegated agents cannot spawn their own delegations (anti-recursion)
- Delegated agents have isolated context (no access to parent conversation)
- Results retrieved via `delegation_read` (only ID returned inline)

</guidelines>
