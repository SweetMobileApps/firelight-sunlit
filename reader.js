const blockSize = 256 * 1024;
const decoder = new TextDecoder();
const boundaries = /^\{"timestamp":"[^"]+",(?:"ordinal":\d+,)?"type":"event_msg","payload":\{"type":"(?:task_started|task_complete|turn_aborted|turn_failed|task_failed)"/;
const uuid = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;

function question(text) {
    return typeof text === "string" && text.trimEnd().endsWith("?");
}

class Turn {
    base = "Last state unknown";
    finalQuestion = false;
    requests = new Map();
    consume({type, payload: p}) {
        if (!p) return;
        const key = String(p.call_id ?? p.request_id ?? p.id ?? "request");
        if (type === "event_msg") {
            switch (p.type) {
            case "task_started": this.base = "Working"; this.finalQuestion = false; this.requests.clear(); return;
            case "agent_message": this.finalQuestion = question(p.message); return;
            case "task_complete": this.base = (p.last_agent_message == null ? this.finalQuestion : question(p.last_agent_message)) ? "Has a question" : "Resting"; this.requests.clear(); return;
            case "turn_aborted": this.base = "Resting"; this.requests.clear(); return;
            case "turn_failed": case "task_failed": case "error":
                if (p.will_retry !== true) { this.base = "Turn failed"; this.requests.clear(); }
                return;
            case "exec_approval_request": case "apply_patch_approval_request": case "request_permissions":
                this.requests.set(key, "approval"); return;
            case "request_user_input": this.requests.set(key, "question"); return;
            case "exec_command_begin": case "exec_command_end": case "patch_apply_begin": case "patch_apply_end": case "server_request_resolved":
                this.requests.delete(key); return;
            }
        } else if (type === "response_item") {
            if (p.type === "function_call" || p.type === "custom_tool_call") {
                const name = p.name?.split(".").pop();
                if (name === "request_user_input_async") this.requests.set(key, "async");
                if (name === "request_user_input") this.requests.set(key, "question");
                if (name === "request_permissions") this.requests.set(key, "approval");
            }
            if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
                if (this.requests.get(key) === "async") {
                    try { if (JSON.parse(p.output).accepted === true) return; } catch {}
                }
                this.requests.delete(key);
            }
            if (p.type === "message" && p.role === "assistant" && p.phase === "final_answer")
                this.finalQuestion = question(p.content?.at(-1)?.text);
        }
        if ((type === "event_msg" && p.type === "user_message") ||
            (type === "response_item" && p.type === "message" && p.role === "user")) {
            for (const [id, kind] of this.requests) if (kind === "async") this.requests.delete(id);
        }
    }
    get activity() {
        if ([...this.requests.values()].includes("approval")) return "Needs approval";
        return this.requests.size ? "Has a question" : this.base;
    }
}

// Rollouts can contain image records hundreds of MB long. Find the latest turn
// boundary using bounded slices, then consume only complete appended records.
async function latestBoundary(file) {
    for (let end = file.size; end > 0;) {
        const start = Math.max(0, end - blockSize);
        const bytes = new Uint8Array(await file.slice(start, end + 256).arrayBuffer());
        let pos = end - start - 1;
        while ((pos = bytes.lastIndexOf(10, pos)) >= 0) {
            if (boundaries.test(decoder.decode(bytes.subarray(pos + 1, pos + 240)))) return start + pos + 1;
            if (!pos) break;
            pos--;
        }
        end = start;
    }
    return 0;
}

export class SessionReader {
    offset = 0;
    partial = "";
    oversized = false;
    constructor(TurnType = Turn, startOffset = latestBoundary) {
        this.TurnType = TurnType;
        this.startOffset = startOffset;
        this.turn = new TurnType();
    }
    modified = null;
    decoder = new TextDecoder();
    async update(file) {
        if (this.modified === null || file.size < this.offset || (file.size === this.offset && file.lastModified !== this.modified)) {
            this.offset = await this.startOffset(file);
            this.turn = new this.TurnType();
            this.partial = "";
            this.oversized = false;
            this.decoder = new TextDecoder();
        }
        while (this.offset < file.size) {
            const bytes = await file.slice(this.offset, this.offset + blockSize).arrayBuffer();
            const parts = this.decoder.decode(bytes, {stream:true}).split("\n");
            for (let i = 0; i < parts.length; i++) {
                if (!this.oversized) {
                    this.partial += parts[i];
                    if (this.partial.length > 2_000_000) { this.oversized = true; this.partial = ""; }
                }
                if (i < parts.length - 1) {
                    if (this.partial) {
                        try { this.turn.consume(JSON.parse(this.partial)); } catch {}
                    }
                    this.partial = "";
                    this.oversized = false;
                }
            }
            this.offset += bytes.byteLength;
        }
        this.modified = file.lastModified;
        return this.turn.activity;
    }
}

async function* days(dir, depth = 0) {
    if (depth === 3) { yield dir; return; }
    const dirs = [];
    for await (const h of dir.values()) if (h.kind === "directory" && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(h.name)) dirs.push(h);
    dirs.sort((a,b) => b.name.localeCompare(a.name));
    for (const h of dirs) yield* days(h, depth + 1);
}

// Walk the active rollouts, since the title index can also name archived chats.
export async function catalog(root, sessions, knownKinds) {
    const titles = new Map();
    try {
        const index = await (await root.getFileHandle("session_index.jsonl")).getFile();
        for (const line of (await index.text()).split("\n")) {
            try {
                const {id, thread_name} = JSON.parse(line);
                if (id && thread_name) titles.set(id, thread_name);
            } catch {}
        }
    } catch (err) { if (err.name !== "NotFoundError") throw err; }

    const chats = new Map();
    for await (const day of days(sessions)) {
        for await (const handle of day.values()) {
            const id = handle.name.match(uuid)?.[1];
            if (!id || handle.kind !== "file" || chats.has(id)) continue;
            try {
                const file = await handle.getFile();
                if (!knownKinds.has(id)) {
                    // Session metadata is normally the first line. Avoid reading a whole image record.
                    const prefix = await file.slice(0, 128 * 1024).text();
                    const newline = prefix.indexOf("\n");
                    if (newline < 0 && file.size < 128 * 1024) continue; // Writer is creating the file.
                    let meta;
                    try { meta = JSON.parse(prefix.slice(0, newline)).payload; } catch {}
                    const child = meta?.source?.subagent || meta?.attached_thread_parent_id;
                    knownKinds.set(id, !child);
                }
                if (knownKinds.get(id)) chats.set(id, {id, handle, updated:file.lastModified,
                    title:titles.get(id) || "Chat " + id.slice(-8)});
            } catch (err) {
                if (err.name !== "NotFoundError" && err.name !== "NotReadableError") throw err;
            }
        }
    }
    return [...chats.values()].sort((a,b) => b.updated - a.updated || a.id.localeCompare(b.id));
}
