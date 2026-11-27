import {SessionReader} from "./reader.js";

const sessionFile = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;

export async function claudeCatalog(projects) {
    const entries = new Map();
    for await (const project of projects.values()) {
        if (project.kind !== "directory") continue;
        // Main sessions are direct children. Nested subagent transcripts belong to their parent fairy.
        for await (const handle of project.values()) {
            const match = sessionFile.exec(handle.name);
            if (!match || handle.kind !== "file") continue;
            try {
                const file = await handle.getFile();
                const id = "claude:" + match[1];
                if ((entries.get(id)?.updated ?? -1) < file.lastModified)
                    entries.set(id, {id, title:"Claude chat " + match[1].slice(0, 8), updated:file.lastModified, handle});
            } catch (err) {
                if (err.name !== "NotFoundError" && err.name !== "NotReadableError") throw err;
            }
        }
    }
    return [...entries.values()].sort((a,b) => b.updated - a.updated || a.id.localeCompare(b.id));
}

class ClaudeTurn {
    activity = "Last state unknown";
    customTitle = "";
    aiTitle = "";
    firstPrompt = "";
    pending = new Map();

    get title() { return this.customTitle || this.aiTitle || this.firstPrompt; }
    consume(record) {
        if (record.isSidechain) return;
        if (record.type === "custom-title") this.customTitle = String(record.customTitle || "").slice(0,120);
        if (record.type === "ai-title") this.aiTitle = String(record.aiTitle || "").slice(0,120);
        if (record.type === "system" && record.subtype === "turn_duration") {
            if (this.activity === "Working") this.activity = "Resting";
            return;
        }
        const message = record.message;
        if (!message || record.isMeta) return;
        const blocks = Array.isArray(message.content) ? message.content : [];
        const text = typeof message.content === "string" ? message.content.trim() :
            blocks.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
        if (record.type === "user") {
            const results = blocks.filter(b => b.type === "tool_result");
            if (results.length) {
                for (const result of results) this.pending.delete(result.tool_use_id);
            } else {
                this.pending.clear();
                if (text.startsWith("[Request interrupted by user")) { this.activity = "Resting"; return; }
                if (!text || text.startsWith("<local-command-") || text.startsWith("<command-name>")) return;
                if (!this.firstPrompt) this.firstPrompt = text.replace(/\s+/g," ").slice(0,90);
            }
        } else if (record.type === "assistant") {
            if (record.isApiErrorMessage || record.error) {
                this.pending.clear(); this.activity = "Turn failed"; return;
            }
            const tools = blocks.filter(b => b.type === "tool_use");
            for (const tool of tools) {
                if (tool.name === "AskUserQuestion") this.pending.set(tool.id, "Has a question");
                if (tool.name === "ExitPlanMode") this.pending.set(tool.id, "Needs approval");
            }
            if (!tools.length && (message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence")) {
                this.pending.clear();
                this.activity = text.endsWith("?") ? "Has a question" : "Resting";
                return;
            }
        } else return;
        const waiting = [...this.pending.values()];
        this.activity = waiting.includes("Needs approval") ? "Needs approval" : waiting[0] || "Working";
    }
}

export function claudeReader() {
    // Replay once to recover names and unresolved tool IDs; later polls read only appended bytes.
    return new SessionReader(ClaudeTurn, () => 0);
}
