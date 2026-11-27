import {catalog, SessionReader} from "./reader.js";

import {claudeCatalog, claudeReader} from "./claude.js";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const day = 24 * 60 * 60 * 1000;
self.onmessage = async ({data:{root, pinned, provider}}) => {
    const claude = provider === "claude";
    const knownKinds = new Map();
    const readers = new Map();
    let refreshAt = 0;
    let previous;
    try {
        const sessions = claude && root.name === "projects" ? root : await root.getDirectoryHandle(claude ? "projects" : "sessions");
        let entries = [];
        while (true) {
            if (Date.now() >= refreshAt) {
                entries = claude ? await claudeCatalog(sessions) : await catalog(root, sessions, knownKinds);
                const present = new Set(entries.map(chat => chat.id));
                for (const id of readers.keys()) if (!present.has(id)) readers.delete(id);
                refreshAt = Date.now() + 15000;
            }
            const publish = () => {
                const chats = entries.map(({id, title}) => ({
                    id, title:readers.get(id)?.reader.turn.title || title, activity:readers.get(id)?.activity || "Last state unknown"
                }));
                const json = JSON.stringify(chats);
                if (json !== previous) { previous = json; postMessage({chats}); }
            };
            publish();
            // Old, unchanged rollouts retain their last status. A new append wakes them
            // on the next catalog refresh, even if their fairy is currently hidden.
            for (const entry of entries) {
                let state = readers.get(entry.id);
                if (!state) {
                    state = {reader:claude ? claudeReader() : new SessionReader(), activity:"Last state unknown", next:0};
                    readers.set(entry.id, state);
                }
                if (Date.now() < state.next && state.reader.modified === entry.updated) continue;
                try {
                    const file = await entry.handle.getFile();
                    state.activity = await state.reader.update(file);
                    entry.updated = file.lastModified;
                    if (claude && state.activity === "Working" && entry.updated < Date.now() - 30 * 60 * 1000)
                        state.activity = "Last state unknown";
                } catch (err) {
                    if (err.name === "NotAllowedError") throw err;
                    if (err.name !== "NotReadableError") state.activity = "Disconnected";
                }
                state.next = Date.now() + (entry.id === pinned || entry.updated >= Date.now() - day ? 850 : 15000);
            }
            publish();
            await pause(850);
        }
    } catch (err) {
        postMessage({error:err.name === "NotFoundError" ?
            (claude ? "Choose the Claude Code projects folder or its parent configuration folder." : "Choose the Codex folder that contains the sessions folder.") : err.message});
    }
};
