let lastPageInput = performance.now();
const notePageInput = () => { lastPageInput = performance.now(); };
for (const event of ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "keydown", "keyup", "close"]) {
    document.addEventListener(event, notePageInput, {capture:true, passive:true});
}
window.firelightPageIdleSeconds = () => document.querySelector("dialog[open]") ? 0 : (performance.now() - lastPageInput) / 1000;

const el = id => document.getElementById(id);
const connect = el("connect"), disconnect = el("disconnect"), status = el("status");
const link = new URLSearchParams(location.hash.slice(1));
const pinned = link.get("chat");
const dialog = el("setup"), platform = el("platform"), path = el("folder-path");
const providers = {
    codex: {name:"Codex", folder:".codex", hint:"If you set CODEX_HOME, choose that folder."},
    claude: {name:"Claude Code", folder:".claude/projects", hint:"For a custom CLAUDE_CONFIG_DIR, choose its projects folder. Start a local Claude Code chat first if the folder is missing."}
};
const sources = Object.keys(providers);
const monitors = new Map();
let folders = {};
let mode = "codex";
const selectedProvider = () => dialog.querySelector('input[name="provider"]:checked').value;
const systems = {
    mac: {steps:["In the folder picker, press ⌘⇧G to go to a folder.", "Paste the path with ⌘V and press Return. Click Open, then allow read access."]},
    windows: {steps:["In the folder picker, press Alt+D to focus the address bar.", "Paste the path with Ctrl+V and press Enter. Click Select Folder, then allow read access."]},
    linux: {steps:["In the folder picker, press Ctrl+L to enter a path.", "Paste with Ctrl+V and press Enter. Select the folder and allow read access."]}
};
const device = navigator.userAgentData?.platform || navigator.platform;
platform.value = /win/i.test(device) ? "windows" : /linux/i.test(device) ? "linux" : "mac";
function nextProvider() {
    if (selectedProvider() !== "both") return selectedProvider();
    return sources.find(id => !monitors.has(id) || monitors.get(id).error);
}
function instructions() {
    const info = systems[platform.value];
    const id = nextProvider();
    const both = selectedProvider() === "both";
    const source = providers[id];
    el("folder-details").hidden = !source;
    el("copy-status").textContent = "";
    if (!source) {
        el("browse").textContent = "Return to garden";
        return;
    }
    path.value = platform.value === "windows" ? "%USERPROFILE%\\" + source.folder.replaceAll("/", "\\") : "~/" + source.folder;
    el("path-label").textContent = "Default " + source.name + " folder";
    const other = sources.find(key => key !== id);
    const guidance = both ? (monitors.has(other) ? providers[other].name + " is connected. " :
        "Choose Codex first, then Claude Code. ") : "";
    el("folder-hint").textContent = window.showDirectoryPicker ? guidance + source.hint :
        "Open this garden in desktop Chrome over HTTPS or localhost to choose a folder.";
    el("browse").textContent = !both && mode === "both" && monitors.has(id) && !monitors.get(id).error ?
        "Use " + source.name + " only" : folders[id] && !monitors.has(id) ? "Reconnect " + source.name :
        both ? "Choose " + source.name + " folder" : "Open folder picker";
    el("copy-status").textContent = "";
    el("steps").replaceChildren(...info.steps.map(text => {
        const item = document.createElement("li"); item.textContent = text; return item;
    }));
}

for (const input of dialog.querySelectorAll('input[name="provider"]')) input.onchange = instructions;
platform.onchange = instructions;
instructions();
el("copy").onclick = async () => {
    try {
        await navigator.clipboard.writeText(path.value);
        el("copy-status").textContent = "Path copied";
    } catch {
        path.select();
        el("copy-status").textContent = platform.value === "mac" ? "Press ⌘C to copy." : "Press Ctrl+C to copy.";
    }
};

let interaction = 0;
const db = new Promise((resolve, reject) => {
    const request = indexedDB.open("firelight-folder", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("folder");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
}).catch(() => null);
async function folderRecord(action, handle) {
    const store = await db;
    if (!store) return;
    return new Promise((resolve, reject) => {
        const tx = store.transaction("folder", action === "read" ? "readonly" : "readwrite");
        const bucket = tx.objectStore("folder");
        const req = action === "read" ? bucket.get("codex") :
            action === "save" ? bucket.put(handle, "codex") : bucket.delete("codex");
        tx.oncomplete = () => resolve(req.result);
        tx.onabort = () => reject(tx.error);
    }).catch(() => undefined);
}
function offline(message) {
    window.firelightSnapshot = {connected:false, message, chats:[]};
    status.textContent = message;
}
function stop(id) {
    monitors.get(id)?.worker.terminate();
    monitors.delete(id);
}
function publish() {
    const active = [...monitors.values()];
    const chats = active.flatMap(source => source.chats || []);
    const connected = active.some(source => source.chats !== null);
    const errors = active.filter(source => source.error).map(source => source.error);
    let message = errors.join(" ");
    if (!message && !chats.length) message = connected ? "No local chats yet." : "Looking for chats…";
    window.firelightSnapshot = {connected, message, chats};
    status.textContent = message;
    disconnect.hidden = !active.length && !Object.keys(folders).length;
    connect.textContent = mode === "both" ? "Chat folders" : providers[mode].name + " folder";
}

const fullscreen = el("fullscreen");
function updateFullscreenButton() {
    fullscreen.textContent = document.fullscreenElement ? "Exit fullscreen" : "Enter fullscreen";
}
fullscreen.hidden = !document.fullscreenEnabled;
document.addEventListener("fullscreenchange", updateFullscreenButton);
fullscreen.onclick = async () => {
    try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
    } catch {
        status.textContent = "Chrome couldn’t change fullscreen mode.";
    }
};
disconnect.onclick = async () => {
    const version = ++interaction;
    for (const id of sources) stop(id);
    folders = {};
    disconnect.hidden = true;
    mode = "codex";
    dialog.querySelector('input[value="codex"]').checked = true;
    offline("Disconnecting…");
    await folderRecord("forget");
    if (version !== interaction) return;
    connect.textContent = "Choose chat folder";
    offline("Disconnected. Choose a folder to reconnect.");
    instructions();
    dialog.showModal();
};
function openFolderSetup() {
    if (dialog.open) return;
    ++interaction;
    dialog.querySelector('input[value="' + mode + '"]').checked = true;
    instructions();
    dialog.showModal();
}
connect.onclick = openFolderSetup;
window.firelightOpenFolderSetup = openFolderSetup;
el("browse").onclick = async () => {
    const choice = selectedProvider();
    const provider = nextProvider();
    if (!provider) { dialog.close(); return; }
    const label = providers[provider].name;
    el("browse").disabled = true;
    try {
        let picked;
        if (choice !== "both" && mode === "both" && monitors.has(provider) && !monitors.get(provider).error) {
            picked = folders[provider];
        } else if (folders[provider] && !monitors.has(provider)) {
            picked = folders[provider];
            if (await picked.requestPermission({mode:"read"}) !== "granted") {
                delete folders[provider];
                await folderRecord("save", {mode, folders});
                instructions();
                el("copy-status").textContent = "Access expired. Choose the folder again.";
                return;
            }
        } else {
            const options = {id:"firelight-" + provider, mode:"read"};
            if (folders[provider]) options.startIn = folders[provider];
            picked = await window.showDirectoryPicker(options);
        }
        if (!(provider === "claude" && picked.name === "projects"))
            await picked.getDirectoryHandle(provider === "claude" ? "projects" : "sessions");
        if (choice !== "both") {
            for (const other of sources.filter(id => id !== provider)) {
                stop(other);
                delete folders[other];
            }
        }
        mode = choice;
        if (picked !== folders[provider] || !monitors.has(provider) || monitors.get(provider).error)
            monitor(picked, provider);
        folders[provider] = picked;
        await folderRecord("save", {mode, folders});
        publish();
        if (choice === "both" && nextProvider()) instructions();
        else dialog.close();
    } catch (err) {
        if (err.name !== "AbortError") el("copy-status").textContent = "Choose the " + label + " folder shown above and allow read access.";
    } finally {
        el("browse").disabled = false;
    }
};
function monitor(root, provider) {
    stop(provider);
    const worker = new Worker("./reader-worker.js", {type:"module"});
    const state = {worker, chats:null, error:""};
    monitors.set(provider, state);
    function update(chats, error = "") {
        if (monitors.get(provider) !== state) return;
        state.chats = chats;
        state.error = error ? providers[provider].name + ": " + error : "";
        publish();
    }
    worker.onerror = () => update(null, "Reader stopped. Reconnect the folder.");
    worker.onmessage = ({data}) => update(data.error ? null : data.chats, data.error);
    worker.postMessage({root, pinned:provider === "codex" ? pinned : null, provider});
}
if (!window.showDirectoryPicker) {
    el("browse").disabled = true;
    offline("Open this garden in desktop Chrome over HTTPS or localhost to choose a folder.");
} else {
    const saved = await folderRecord("read");
    if (!interaction) {
        const prior = saved?.provider === "claude" ? "claude" : "codex";
        const stored = saved?.folders || (saved ? {[prior]: saved.handle || saved} : {});
        mode = saved?.mode === "both" ? "both" : providers[saved?.mode] ? saved.mode : prior;
        dialog.querySelector('input[value="' + mode + '"]').checked = true;
        for (const provider of sources) {
            const handle = stored[provider];
            if (!handle) continue;
            let permission;
            try { permission = await handle.queryPermission({mode:"read"}); } catch {}
            if (interaction) break;
            if (permission === "prompt" || permission === "granted") folders[provider] = handle;
            if (permission === "granted") monitor(handle, provider);
        }
        if (!interaction) {
            if (monitors.size) publish();
            if (!monitors.size || (mode === "both" && nextProvider())) {
                instructions();
                dialog.showModal();
            }
        }
    }
}

window.firelightOfferGarden = (file, summary) => {
    const dialog = document.createElement("dialog");
    dialog.className = "share-garden";
    dialog.setAttribute("aria-label", "Share your garden");
    const url = URL.createObjectURL(file);
    const make = (tag, text) => {
        const node = document.createElement(tag);
        if (text) node.textContent = text;
        return node;
    };
    const title = make("h1", "Share your garden");
    const close = make("button", "×");
    close.className = "close";
    close.setAttribute("aria-label", "Close");
    close.onclick = () => dialog.close();
    const image = make("img");
    image.src = url;
    image.alt = "Animated tour from the river to the end of the garden";
    const stats = make("p", summary);
    stats.className = "share-stats";
    const actions = make("div");
    actions.className = "share-actions";
    const save = make("a", "Save GIF");
    save.href = url;
    save.download = file.name;
    const copy = make("button", "Copy stats");
    const feedback = make("p");
    feedback.setAttribute("role", "status");
    copy.onclick = async () => {
        try { await navigator.clipboard.writeText(summary); feedback.textContent = "Stats copied."; }
        catch { const range = document.createRange(); range.selectNodeContents(stats);
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
            feedback.textContent = "Stats selected. Use your copy shortcut."; }
    };
    if (navigator.canShare?.({files:[file]})) {
        const share = make("button", "Share GIF…");
        share.onclick = async () => {
            try { await navigator.share({files:[file], text:summary, title:"Firelight garden"}); }
            catch (err) { if (err.name !== "AbortError") feedback.textContent = "Use Save GIF and Copy stats to share."; }
        };
        actions.append(share);
    }
    actions.append(save, copy);
    dialog.append(close, title, image, stats, actions, feedback);
    dialog.onclose = () => { URL.revokeObjectURL(url); dialog.remove(); document.querySelector("canvas")?.focus(); };
    document.body.append(dialog);
    dialog.showModal();
};
