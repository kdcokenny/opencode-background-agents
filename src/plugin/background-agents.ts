/**
 * background-agents
 * Unified delegation system for OpenCode
 *
 * Replaces native `task` tool with persistent, async-first agent delegation.
 * All agent outputs are persisted to storage, orchestrator receives only key references.
 *
 * Based on oh-my-opencode by @code-yeongyu (MIT License)
 * https://github.com/code-yeongyu/oh-my-opencode
 */

/// <reference types="bun-types" />

import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { type Plugin, type ToolContext, tool } from "@opencode-ai/plugin"
import type { createOpencodeClient, Event, Message, Part, TextPart } from "@opencode-ai/sdk"
import { adjectives, animals, colors, uniqueNamesGenerator } from "unique-names-generator"

// ==========================================
// READABLE ID GENERATION
// ==========================================

function generateReadableId(): string {
	return uniqueNamesGenerator({
		dictionaries: [adjectives, colors, animals],
		separator: "-",
		length: 3,
		style: "lowerCase",
	})
}

// ==========================================
// METADATA GENERATION (using small_model)
// ==========================================

interface GeneratedMetadata {
	title: string
	description: string
}

/**
 * Generate title and description from result content using small_model
 * Falls back to truncation if small_model unavailable
 */
async function generateMetadata(
	client: OpencodeClient,
	resultContent: string,
	debugLog: (msg: string) => Promise<void>,
): Promise<GeneratedMetadata> {
	const fallbackMetadata = (): GeneratedMetadata => {
		// Fallback: truncate first line/paragraph
		const firstLine =
			resultContent.split("\n").find((l) => l.trim().length > 0) || "Delegation result"
		const title = firstLine.slice(0, 30).trim() + (firstLine.length > 30 ? "..." : "")
		const description =
			resultContent.slice(0, 150).trim() + (resultContent.length > 150 ? "..." : "")
		return { title, description }
	}

	try {
		// Get config to check for small_model
		const config = await client.config.get()
		const configData = config.data as { small_model?: string } | undefined

		if (!configData?.small_model) {
			await debugLog("generateMetadata: No small_model configured, using fallback")
			return fallbackMetadata()
		}

		await debugLog(`generateMetadata: Using small_model ${configData.small_model}`)

		// Create a session for metadata generation
		const session = await client.session.create({
			body: { title: "Metadata Generation" },
		})

		if (!session.data?.id) {
			await debugLog("generateMetadata: Failed to create session")
			return fallbackMetadata()
		}

		// Prompt the small model for metadata
		const prompt = `Generate a title and description for this research result.

RULES:
- Title: 2-5 words, max 30 characters, sentence case
- Description: 2-3 sentences, max 150 characters, summarize key findings

RESULT CONTENT:
${resultContent.slice(0, 2000)}

Respond with ONLY valid JSON in this exact format:
{"title": "Your Title Here", "description": "Your description here."}`

		// Await prompt response directly with timeout safety net
		const PROMPT_TIMEOUT_MS = 30000
		const result = await Promise.race([
			client.session.prompt({
				path: { id: session.data.id },
				body: {
					parts: [{ type: "text", text: prompt }],
				},
			}),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Prompt timeout after 30s")), PROMPT_TIMEOUT_MS),
			),
		])

		// Extract text from the response
		const responseParts = result.data?.parts as TextPart[] | undefined
		const textPart = responseParts?.find((p): p is TextPart => p.type === "text")
		if (!textPart) {
			await debugLog("generateMetadata: No text part in response")
			return fallbackMetadata()
		}

		// Parse JSON response
		const jsonMatch = textPart.text.match(/\{[\s\S]*\}/)
		if (!jsonMatch) {
			await debugLog(`generateMetadata: No JSON found in response: ${textPart.text}`)
			return fallbackMetadata()
		}

		const parsed = JSON.parse(jsonMatch[0]) as { title?: string; description?: string }
		if (!parsed.title || !parsed.description) {
			await debugLog("generateMetadata: Invalid JSON structure")
			return fallbackMetadata()
		}

		await debugLog(`generateMetadata: Generated title="${parsed.title}"`)
		return {
			title: parsed.title.slice(0, 30),
			description: parsed.description.slice(0, 150),
		}
	} catch (error) {
		await debugLog(
			`generateMetadata error: ${error instanceof Error ? error.message : "Unknown error"}`,
		)
		return fallbackMetadata()
	}
}

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type OpencodeClient = ReturnType<typeof createOpencodeClient>

interface SessionMessageItem {
	info: Message
	parts: Part[]
}

interface AssistantSessionMessageItem {
	info: Message & { role: "assistant" }
	parts: Part[]
}

interface DelegationProgress {
	toolCalls: number
	lastUpdate: Date
	lastMessage?: string
	lastMessageAt?: Date
}

const MAX_RUN_TIME_MS = 5 * 60 * 1000 // 5 minutes

interface Delegation {
	id: string // Human-readable ID (e.g., "swift-amber-falcon")
	sessionID: string
	parentSessionID: string
	parentMessageID: string
	parentAgent: string
	prompt: string
	agent: string
	status: "running" | "complete" | "error" | "cancelled" | "timeout"
	startedAt: Date
	completedAt?: Date
	progress: DelegationProgress
	error?: string
	parentModel?: { providerID: string; modelID: string }
	// Generated on completion by small_model
	title?: string
	description?: string
}

interface DelegateInput {
	parentSessionID: string
	parentMessageID: string
	parentAgent: string
	prompt: string
	agent: string
	parentModel?: { providerID: string; modelID: string }
}

interface DelegationListItem {
	id: string
	status: string
	title?: string
	description?: string
}

// ==========================================
// DELEGATION MANAGER
// ==========================================

class DelegationManager {
	private delegations: Map<string, Delegation> = new Map()
	private client: OpencodeClient
	private baseDir: string
	// Track pending delegations per parent session for batched notifications
	private pendingByParent: Map<string, Set<string>> = new Map()

	constructor(client: OpencodeClient, baseDir: string) {
		this.client = client
		this.baseDir = baseDir
	}

	/**
	 * Resolves the root session ID by walking up the parent chain.
	 */
	private async getRootSessionID(sessionID: string): Promise<string> {
		let currentID = sessionID
		// Prevent infinite loops with max depth
		for (let depth = 0; depth < 10; depth++) {
			try {
				const session = await this.client.session.get({
					path: { id: currentID },
				})

				if (!session.data?.parentID) {
					return currentID
				}

				currentID = session.data.parentID
			} catch {
				// If we can't fetch the session, assume current is root or best effort
				return currentID
			}
		}
		return currentID
	}

	/**
	 * Get the delegations directory for a session scope (root session)
	 */
	private async getDelegationsDir(sessionID: string): Promise<string> {
		const rootID = await this.getRootSessionID(sessionID)
		return path.join(this.baseDir, rootID)
	}

	/**
	 * Ensure the delegations directory exists
	 */
	private async ensureDelegationsDir(sessionID: string): Promise<string> {
		const dir = await this.getDelegationsDir(sessionID)
		await fs.mkdir(dir, { recursive: true })
		return dir
	}

	/**
	 * Delegate a task to an agent
	 */
	async delegate(input: DelegateInput): Promise<Delegation> {
		// Generate readable ID
		const id = generateReadableId()
		await this.debugLog(`delegate() called, generated ID: ${id}`)

		// Check for ID collisions (regenerate if needed)
		let finalId = id
		let attempts = 0
		while (this.delegations.has(finalId) && attempts < 10) {
			finalId = generateReadableId()
			attempts++
		}
		if (this.delegations.has(finalId)) {
			throw new Error("Failed to generate unique delegation ID after 10 attempts")
		}

		// Create isolated session for delegation
		const sessionResult = await this.client.session.create({
			body: {
				title: `Delegation: ${finalId}`,
				parentID: input.parentSessionID,
			},
		})

		await this.debugLog(`session.create result: ${JSON.stringify(sessionResult.data)}`)

		if (!sessionResult.data?.id) {
			throw new Error("Failed to create delegation session")
		}

		const delegation: Delegation = {
			id: finalId,
			sessionID: sessionResult.data.id,
			parentSessionID: input.parentSessionID,
			parentMessageID: input.parentMessageID,
			parentAgent: input.parentAgent,
			prompt: input.prompt,
			agent: input.agent,
			status: "running",
			startedAt: new Date(),
			progress: {
				toolCalls: 0,
				lastUpdate: new Date(),
			},
			parentModel: input.parentModel,
		}

		await this.debugLog(`Created delegation ${delegation.id}`)
		this.delegations.set(delegation.id, delegation)

		// Track this delegation for batched notification
		const parentId = input.parentSessionID
		if (!this.pendingByParent.has(parentId)) {
			this.pendingByParent.set(parentId, new Set())
		}
		this.pendingByParent.get(parentId)?.add(delegation.id)
		await this.debugLog(
			`Tracking delegation ${delegation.id} for parent ${parentId}. Pending count: ${this.pendingByParent.get(parentId)?.size}`,
		)

		await this.debugLog(
			`Delegation added to map. Current delegations: ${Array.from(this.delegations.keys()).join(", ")}`,
		)

		// Set a timer for the global max run time
		setTimeout(() => {
			const current = this.delegations.get(delegation.id)
			if (current && current.status === "running") {
				this.handleTimeout(delegation.id)
			}
		}, MAX_RUN_TIME_MS + 5000) // Adding 5s buffer

		// Ensure delegations directory exists (early check)
		await this.ensureDelegationsDir(input.parentSessionID)

		// Fire the prompt asynchronously
		this.client.session
			.promptAsync({
				path: { id: delegation.sessionID },
				body: {
					agent: input.agent,
					model: input.parentModel,
					// Anti-recursion: disable nested delegations
					tools: {
						task: false,
						delegate: false,
					},
					parts: [{ type: "text", text: input.prompt }],
				},
			})
			.catch((error: Error) => {
				delegation.status = "error"
				delegation.error = error.message
				delegation.completedAt = new Date()
				this.persistOutput(delegation, `Error: ${error.message}`)
				this.notifyParent(delegation)
			})

		return delegation
	}

	/**
	 * Handle delegation timeout
	 */
	private async handleTimeout(delegationId: string): Promise<void> {
		const delegation = this.delegations.get(delegationId)
		if (!delegation || delegation.status !== "running") return

		await this.debugLog(`handleTimeout for delegation ${delegation.id}`)

		delegation.status = "timeout"
		delegation.completedAt = new Date()
		delegation.error = `Delegation timed out after ${MAX_RUN_TIME_MS / 1000}s`

		// Try to cancel the session
		try {
			await this.client.session.delete({
				path: { id: delegation.sessionID },
			})
		} catch {
			// Ignore
		}

		// Get whatever result was produced so far
		const result = await this.getResult(delegation)
		await this.persistOutput(delegation, `${result}\n\n[TIMEOUT REACHED]`)

		// Notify parent session
		await this.notifyParent(delegation)
	}

	/**
	 * Wait for a delegation to complete (polling)
	 */
	private async waitForCompletion(delegationId: string): Promise<void> {
		const pollInterval = 1000
		const startTime = Date.now()

		const delegation = this.delegations.get(delegationId)
		if (!delegation) return

		while (
			delegation.status === "running" &&
			Date.now() - startTime < MAX_RUN_TIME_MS + 10000 // Slightly more than global limit
		) {
			await new Promise((resolve) => setTimeout(resolve, pollInterval))
		}
	}

	/**
	 * Handle session.idle event - called when a session becomes idle
	 */
	async handleSessionIdle(sessionID: string): Promise<void> {
		const delegation = this.findBySession(sessionID)
		if (!delegation || delegation.status !== "running") return

		await this.debugLog(`handleSessionIdle for delegation ${delegation.id}`)

		delegation.status = "complete"
		delegation.completedAt = new Date()

		// Get the result
		const result = await this.getResult(delegation)

		// Generate title and description using small model
		const metadata = await generateMetadata(this.client, result, (msg) => this.debugLog(msg))
		delegation.title = metadata.title
		delegation.description = metadata.description

		// Persist output with generated metadata
		await this.persistOutput(delegation, result)

		// Notify parent session
		await this.notifyParent(delegation)
	}

	/**
	 * Get the result from a delegation's session
	 */
	private async getResult(delegation: Delegation): Promise<string> {
		try {
			const messages = await this.client.session.messages({
				path: { id: delegation.sessionID },
			})

			const messageData = messages.data as SessionMessageItem[] | undefined

			if (!messageData || messageData.length === 0) {
				await this.debugLog(`getResult: No messages found for session ${delegation.sessionID}`)
				return `Delegation "${delegation.description}" completed but produced no output.`
			}

			await this.debugLog(
				`getResult: Found ${messageData.length} messages. Roles: ${messageData.map((m) => m.info.role).join(", ")}`,
			)

			// Find the last message from the assistant/model
			const isAssistantMessage = (m: SessionMessageItem): m is AssistantSessionMessageItem =>
				m.info.role === "assistant"

			const assistantMessages = messageData.filter(isAssistantMessage)

			if (assistantMessages.length === 0) {
				await this.debugLog(
					`getResult: No assistant messages found in ${JSON.stringify(messageData.map((m) => ({ role: m.info.role, keys: Object.keys(m) })))}`,
				)
				return `Delegation "${delegation.description}" completed but produced no assistant response.`
			}

			const lastMessage = assistantMessages[assistantMessages.length - 1]

			// Extract text parts from the message
			const isTextPart = (p: Part): p is TextPart => p.type === "text"
			const textParts = lastMessage.parts.filter(isTextPart)

			if (textParts.length === 0) {
				await this.debugLog(
					`getResult: No text parts found in message: ${JSON.stringify(lastMessage)}`,
				)
				return `Delegation "${delegation.description}" completed but produced no text content.`
			}

			return textParts.map((p) => p.text).join("\n")
		} catch (error) {
			await this.debugLog(
				`getResult error: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
			return `Delegation "${delegation.description}" completed but result could not be retrieved: ${
				error instanceof Error ? error.message : "Unknown error"
			}`
		}
	}

	/**
	 * Persist delegation output to storage
	 */
	private async persistOutput(delegation: Delegation, content: string): Promise<void> {
		try {
			// Ensure we resolve the root session ID of the PARENT session for storage
			const dir = await this.ensureDelegationsDir(delegation.parentSessionID)
			const filePath = path.join(dir, `${delegation.id}.md`)

			// Use title/description if available (generated by small model), otherwise fallback
			const title = delegation.title || delegation.id
			const description = delegation.description || "(No description generated)"

			const header = `# ${title}

${description}

**ID:** ${delegation.id}
**Agent:** ${delegation.agent}
**Status:** ${delegation.status}
**Started:** ${delegation.startedAt.toISOString()}
**Completed:** ${delegation.completedAt?.toISOString() || "N/A"}

---

`
			await fs.writeFile(filePath, header + content, "utf8")
			await this.debugLog(`Persisted output to ${filePath}`)
		} catch (error) {
			await this.debugLog(
				`Failed to persist output: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}

	/**
	 * Notify parent session that delegation is complete.
	 * Uses batching: individual notifications are silent (noReply: true),
	 * but when ALL delegations for a parent session complete, triggers a response.
	 */
	private async notifyParent(delegation: Delegation): Promise<void> {
		try {
			// Use generated title/description if available
			const title = delegation.title || delegation.id
			const description = delegation.description || "(No description)"
			const statusText = delegation.status === "complete" ? "complete" : delegation.status

			// Mark this delegation as complete in the pending tracker
			const pendingSet = this.pendingByParent.get(delegation.parentSessionID)
			if (pendingSet) {
				pendingSet.delete(delegation.id)
			}

			// Check if ALL delegations for this parent are now complete
			const allComplete = !pendingSet || pendingSet.size === 0

			// Clean up if all complete
			if (allComplete && pendingSet) {
				this.pendingByParent.delete(delegation.parentSessionID)
			}

			const remainingCount = pendingSet?.size || 0

			// Build notification based on whether all are complete or some remain
			let notification: string
			if (allComplete) {
				// All delegations complete - list all that completed for this parent
				const completedDelegations = Array.from(this.delegations.values())
					.filter(
						(d) =>
							d.parentSessionID === delegation.parentSessionID &&
							(d.status === "complete" || d.status === "timeout" || d.status === "error"),
					)
					.map((d) => `- \`${d.id}\`: ${d.title || d.id}`)
					.join("\n")

				notification = `<system-reminder>
All delegations complete.

**Completed:**
${completedDelegations || `- \`${delegation.id}\`: ${title}`}

Use \`delegation_read(id)\` to retrieve each result.
</system-reminder>`
			} else {
				// Individual completion - show remaining count with anti-polling reinforcement
				notification = `<system-reminder>
Delegation ${statusText}.

**ID:** \`${delegation.id}\`
**Title:** ${title}
**Description:** ${description}
**Status:** ${delegation.status}${delegation.error ? `\n**Error:** ${delegation.error}` : ""}

**${remainingCount} delegation${remainingCount === 1 ? "" : "s"} still in progress.** You WILL be notified when ALL complete.
❌ Do NOT poll \`delegation_list\` - continue productive work.

Use \`delegation_read("${delegation.id}")\` to retrieve this result when ready.
</system-reminder>`
			}

			// If all delegations complete, trigger a response (noReply: false)
			// Otherwise, add notification silently (noReply: true)
			const shouldTriggerResponse = allComplete

			await this.client.session.prompt({
				path: { id: delegation.parentSessionID },
				body: {
					noReply: !shouldTriggerResponse,
					agent: delegation.parentAgent,
					parts: [{ type: "text", text: notification }],
				},
			})

			await this.debugLog(
				`Notified parent session ${delegation.parentSessionID} (trigger=${shouldTriggerResponse}, remaining=${pendingSet?.size || 0})`,
			)
		} catch (error) {
			await this.debugLog(
				`Failed to notify parent: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}

	/**
	 * Read a delegation's output by ID. Blocks if the delegation is still running.
	 */
	async readOutput(sessionID: string, id: string): Promise<string> {
		// Try to find the file
		let filePath: string | undefined
		try {
			const dir = await this.getDelegationsDir(sessionID)
			filePath = path.join(dir, `${id}.md`)
			// Check if file exists
			await fs.access(filePath)
			return await fs.readFile(filePath, "utf8")
		} catch {
			// File doesn't exist yet, continue to check memory
		}

		// Check if it's currently running in memory
		const delegation = this.delegations.get(id)
		if (delegation) {
			if (delegation.status === "running") {
				await this.debugLog(`readOutput: waiting for delegation ${delegation.id} to complete`)
				await this.waitForCompletion(delegation.id)

				// Re-check after waiting
				const dir = await this.getDelegationsDir(sessionID)
				filePath = path.join(dir, `${id}.md`)
				try {
					return await fs.readFile(filePath, "utf8")
				} catch {
					// Still failed to read
				}

				// If still no file after waiting (e.g. error/timeout/cancel)
				const updated = this.delegations.get(id)
				if (updated && updated.status !== "running") {
					const title = updated.title || updated.id
					return `Delegation "${title}" ended with status: ${updated.status}. ${updated.error || ""}`
				}
			}
		}

		throw new Error(`Delegation not found: ${id}`)
	}

	/**
	 * List all delegations for a session
	 */
	async listDelegations(sessionID: string): Promise<DelegationListItem[]> {
		const results: DelegationListItem[] = []

		// Add in-memory delegations that match this session (or parent)
		for (const delegation of this.delegations.values()) {
			results.push({
				id: delegation.id,
				status: delegation.status,
				title: delegation.title || "(generating...)",
				description: delegation.description || "(generating...)",
			})
		}

		// Check filesystem for persisted delegations
		try {
			const dir = await this.getDelegationsDir(sessionID)
			const files = await fs.readdir(dir)

			for (const file of files) {
				if (file.endsWith(".md")) {
					const id = file.replace(".md", "")
					// Deduplicate: prioritize in-memory status
					if (!results.find((r) => r.id === id)) {
						// Try to read title from file
						let title = "(loaded from storage)"
						let description = ""
						try {
							const filePath = path.join(dir, file)
							const content = await fs.readFile(filePath, "utf8")
							const titleMatch = content.match(/^# (.+)$/m)
							if (titleMatch) title = titleMatch[1]
							// Get first paragraph after title as description
							const lines = content.split("\n")
							if (lines.length > 2 && lines[2]) {
								description = lines[2].slice(0, 150)
							}
						} catch {
							// Ignore read errors
						}
						results.push({
							id,
							status: "complete",
							title,
							description,
						})
					}
				}
			}
		} catch {
			// Directory may not exist yet
		}

		return results
	}

	/**
	 * Delete a delegation by id (cancels if running, removes from storage)
	 * Used internally for cleanup (timeout, etc.)
	 */
	async deleteDelegation(sessionID: string, id: string): Promise<boolean> {
		// Find delegation by id
		let delegationId: string | undefined
		for (const [dId, d] of this.delegations) {
			if (d.id === id) {
				delegationId = dId
				break
			}
		}

		if (delegationId) {
			const delegation = this.delegations.get(delegationId)
			if (delegation?.status === "running") {
				try {
					await this.client.session.delete({
						path: { id: delegation.sessionID },
					})
				} catch {
					// Session may already be deleted
				}
				delegation.status = "cancelled"
				delegation.completedAt = new Date()
			}
			this.delegations.delete(delegationId)
		}

		// Remove from filesystem
		try {
			const dir = await this.getDelegationsDir(sessionID)
			const filePath = path.join(dir, `${id}.md`)
			await fs.unlink(filePath)
			return true
		} catch {
			return false
		}
	}

	/**
	 * Find a delegation by its session ID
	 */
	findBySession(sessionID: string): Delegation | undefined {
		return Array.from(this.delegations.values()).find((d) => d.sessionID === sessionID)
	}

	/**
	 * Handle message events for progress tracking
	 */
	handleMessageEvent(sessionID: string, messageText?: string): void {
		const delegation = this.findBySession(sessionID)
		if (!delegation || delegation.status !== "running") return

		delegation.progress.lastUpdate = new Date()
		if (messageText) {
			delegation.progress.lastMessage = messageText
			delegation.progress.lastMessageAt = new Date()
		}
	}

	/**
	 * Get count of pending delegations for a parent session
	 */
	getPendingCount(parentSessionID: string): number {
		const pendingSet = this.pendingByParent.get(parentSessionID)
		return pendingSet ? pendingSet.size : 0
	}

	/**
	 * Log debug messages
	 */
	async debugLog(msg: string): Promise<void> {
		// Only log if debug is enabled (could be env var or static const)
		// For now, mirroring previous behavior but writing to the new baseDir/debug.log
		const timestamp = new Date().toISOString()
		const line = `${timestamp}: ${msg}\n`
		const debugFile = path.join(this.baseDir, "background-agents-debug.log")

		try {
			await fs.appendFile(debugFile, line, "utf8")
		} catch {
			// Ignore errors, try to ensure dir once if it fails?
			// Simpler to just ignore for debug logs
		}
	}
}

// ==========================================
// TOOL CREATORS
// ==========================================

interface DelegateArgs {
	prompt: string
	agent: string
}

function createDelegate(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Delegate a task to an agent. Returns immediately with a readable ID.

Use this for:
- Research tasks (will be auto-saved)
- Parallel work that can run in background
- Any task where you want persistent, retrievable output

On completion, a notification will arrive with the ID, title, and description.
Use \`delegation_read\` with the ID to retrieve the full result.`,
		args: {
			prompt: tool.schema
				.string()
				.describe("The full detailed prompt for the agent. Must be in English."),
			agent: tool.schema
				.string()
				.describe(
					'The agent to delegate to. Use agents available in your configuration (e.g., "explore", "general").',
				),
		},
		async execute(args: DelegateArgs, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				throw new Error("delegate requires sessionID")
			}
			if (!toolCtx?.messageID) {
				throw new Error("delegate requires messageID")
			}

			const delegation = await manager.delegate({
				parentSessionID: toolCtx.sessionID,
				parentMessageID: toolCtx.messageID,
				parentAgent: toolCtx.agent,
				prompt: args.prompt,
				agent: args.agent,
			})

			// Get total active count for this parent session
			const pendingSet = manager.getPendingCount(toolCtx.sessionID)
			const totalActive = pendingSet

			let response = `Delegation started: ${delegation.id}\nAgent: ${args.agent}`
			if (totalActive > 1) {
				response += `\n\n${totalActive} delegations now active.`
			}
			response += `\nYou WILL be notified when ${totalActive > 1 ? "ALL complete" : "complete"}. Do NOT poll.`

			return response
		},
	})
}

function createDelegationRead(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Read the output of a delegation by its ID.
Use this to retrieve results from delegated tasks.`,
		args: {
			id: tool.schema.string().describe("The delegation ID (e.g., 'elegant-blue-tiger')"),
		},
		async execute(args: { id: string }, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				throw new Error("delegation_read requires sessionID")
			}

			return await manager.readOutput(toolCtx.sessionID, args.id)
		},
	})
}

function createDelegationList(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `List all delegations for the current session.
Shows both running and completed delegations.`,
		args: {},
		async execute(_args: Record<string, never>, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				throw new Error("delegation_list requires sessionID")
			}

			const delegations = await manager.listDelegations(toolCtx.sessionID)

			if (delegations.length === 0) {
				return "No delegations found for this session."
			}

			const lines = delegations.map((d) => {
				const titlePart = d.title ? ` | ${d.title}` : ""
				const descPart = d.description ? `\n  → ${d.description}` : ""
				return `- **${d.id}**${titlePart} [${d.status}]${descPart}`
			})

			return `## Delegations\n\n${lines.join("\n")}`
		},
	})
}

// ==========================================
// DELEGATION RULES (injected into system prompt)
// ==========================================

const DELEGATION_RULES = `<system-reminder>
<delegation-system>

## Async Delegation

You have tools for parallel background work:
- \`delegate(prompt, agent)\` - Launch task, returns ID immediately
- \`delegation_read(id)\` - Retrieve completed result
- \`delegation_list()\` - List delegations (use sparingly)

## How It Works

1. Call \`delegate\` with a detailed prompt and agent name
2. Continue productive work while it runs
3. Receive \`<system-reminder>\` notification when ALL complete
4. Call \`delegation_read(id)\` to retrieve results

## Critical Constraints

**NEVER poll \`delegation_list\` to check completion.**
You WILL be notified via \`<system-reminder>\`. Polling wastes tokens.

**NEVER wait idle.** Always have productive work while delegations run.

</delegation-system>
</system-reminder>`

// ==========================================
// PLUGIN EXPORT
// ==========================================

/**
 * Expected input for experimental.chat.system.transform hook.
 */
interface SystemTransformInput {
	agent?: string
	sessionID?: string
}

export const BackgroundAgentsPlugin: Plugin = async (ctx) => {
	const { client, directory } = ctx

	// Project-level storage directory (shared across sessions)
	// Matches logic in workspace-plugin.ts
	const realDir = await fs.realpath(directory)
	const normalizedDir = realDir.endsWith(path.sep) ? realDir.slice(0, -1) : realDir
	const projectHash = crypto.createHash("sha256").update(normalizedDir).digest("hex").slice(0, 40)
	const baseDir = path.join(os.homedir(), ".local", "share", "opencode", "delegations", projectHash)

	// Ensure base directory exists (for debug logs etc)
	await fs.mkdir(baseDir, { recursive: true })

	const manager = new DelegationManager(client as OpencodeClient, baseDir)

	await manager.debugLog("BackgroundAgentsPlugin initialized with delegation system")

	return {
		tool: {
			delegate: createDelegate(manager),
			delegation_read: createDelegationRead(manager),
			delegation_list: createDelegationList(manager),
		},
		// Inject delegation rules into system prompt
		"experimental.chat.system.transform": async (_input: SystemTransformInput, output) => {
			output.system.push(DELEGATION_RULES)
		},

		// Event hook
		event: async ({ event }: { event: Event }): Promise<void> => {
			if (event.type === "session.idle") {
				const sessionID = event.properties.sessionID
				const delegation = manager.findBySession(sessionID)
				if (delegation) {
					await manager.handleSessionIdle(sessionID)
				}
			}

			if (event.type === "message.updated") {
				const sessionID = event.properties.info.sessionID
				if (sessionID) {
					manager.handleMessageEvent(sessionID)
				}
			}
		},
	}
}

export default BackgroundAgentsPlugin
