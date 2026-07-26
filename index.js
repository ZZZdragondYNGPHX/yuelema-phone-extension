import { mountPhoneApp } from './src/app-shell.js';
import { createServiceOrderHistoryStore } from './src/service-order-history-store.js';
import { createActionBridge } from './src/action-bridge.js';
import { readLatestState } from './src/mvu/adapter.js';
import { waitForReadableMvu } from './src/mvu/readiness.js';
import { clearSessionKeys } from './src/llm/session-key-store.js';
import { createOpenAICompatibleClient } from './src/llm/openai-compatible-client.js';
import { createImageGenerationClient } from './src/llm/image-generation-client.js';
import { createSettingsStore } from './src/settings/settings-store.js';
import { createBrowserSettingsStorage } from './src/settings/browser-storage.js';
import { createCharacterTemplateLibraryStore } from './src/characters/character-template-library-store.js';
import { createPlayerAvatarStore } from './src/player-avatar-store.js';
import { createImageLibraryStore } from './src/images/image-library-store.js';
import { createImageMatchCoordinator } from './src/images/image-match-coordinator.js';
import { createRemoteImageImporter } from './src/images/remote-image-import.js';
import { createGroupForumStore } from './src/groups/group-forum-store.js';

const EXTENSION_ROOT_ID = 'yuelema-phone-extension-root';
const browserStorage = createBrowserSettingsStorage();
const settingsStore = createSettingsStore({ storage: browserStorage });
const characterLibrary = createCharacterTemplateLibraryStore({ storage: browserStorage });
const playerAvatarStore = createPlayerAvatarStore({ storage: browserStorage });

/** @type {{ destroy: () => void } | null} */
let appInstance = null;
let unsubscribeEvents = () => {};
let pageHideHandler = null;

function safeContext(getContext) {
    try {
        return typeof getContext === 'function' ? getContext() : null;
    } catch {
        return null;
    }
}

function serviceOrderHistoryScope(getContext) {
    const context = safeContext(getContext) ?? {};
    const raw = [context.chatId, context.chat_id, context.characterId, context.character_id, context.groupId, context.group_id].find((value) => typeof value === 'string' && value.trim()) ?? 'default';
    const normalized = String(raw).replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 120);
    return normalized || 'default';
}

/**
 * Subscribes to the MVU completion event when the current host exposes the
 * documented eventSource.on/removeListener surface. CHAT_CHANGED is a narrow
 * fallback refresh trigger for the latest-message read scope. Both bindings are
 * optional because their exact availability varies by host build.
 */
function subscribeToStateUpdates({ mvu, getContext, onUpdate }) {
    const currentMvu = typeof mvu === 'function' ? mvu() : mvu;
    const context = safeContext(getContext);
    const eventSource = context?.eventSource;
    if (!eventSource || typeof eventSource.on !== 'function') return () => {};

    const subscriptions = [];
    const add = (eventName) => {
        if (typeof eventName !== 'string' || !eventName) return;
        eventSource.on(eventName, onUpdate);
        subscriptions.push(eventName);
    };

    // Primary binding: this is the same MVU event emitted after a successful
    // controlled patch. Host support remains a real-SillyTavern verification item.
    add(currentMvu?.events?.VARIABLE_UPDATE_ENDED);
    add(context?.event_types?.CHAT_CHANGED);

    return () => {
        for (const eventName of subscriptions) {
            try {
                if (typeof eventSource.removeListener === 'function') eventSource.removeListener(eventName, onUpdate);
                else if (typeof eventSource.off === 'function') eventSource.off(eventName, onUpdate);
            } catch {
                // Cleanup is best-effort only; never leave a failed listener cleanup as an uncaught host error.
            }
        }
    };
}

function bindStateUpdateSubscriptions({ mvu, getContext, onUpdate }) {
    unsubscribeEvents();
    unsubscribeEvents = subscribeToStateUpdates({ mvu, getContext, onUpdate });
}

/**
 * A card''s MVU script can finish after this extension''s lifecycle activation.
 * Waiting is read-only: once the documented helper publishes a readable Mvu
 * facade, rebind the optional event listener and refresh the app projection.
 */
function refreshWhenMvuReady({ instance, mvu, getContext, onUpdate }) {
    void waitForReadableMvu({
        getMvu: () => (typeof mvu === 'function' ? mvu() : mvu),
        retryReadiness: true,
    }).then((result) => {
        if (!result.ok || appInstance !== instance) return;
        bindStateUpdateSubscriptions({ mvu, getContext, onUpdate });
        instance.refreshState();
    }).catch(() => {
        // Host readiness helpers are optional. A failed wait leaves the safe
        // unavailable UI intact and must never surface as an unhandled error.
    });
}
function destroyActiveInstance() {
    // Drop only the short-lived in-memory mirror. The separately user-approved
    // browser cache remains available to the next extension activation.
    clearSessionKeys();
    unsubscribeEvents();
    unsubscribeEvents = () => {};
    appInstance?.destroy();
    appInstance = null;
    if (pageHideHandler && typeof globalThis.removeEventListener === 'function') {
        globalThis.removeEventListener('pagehide', pageHideHandler);
    }
    pageHideHandler = null;
}

/** SillyTavern v1.17+ activation hook (declared in manifest.json). */
export async function onActivate() {
    destroyActiveInstance();

    const documentRef = globalThis.document;
    if (!documentRef?.body) {
        console.warn('[约了吗小手机] 未找到宿主 document.body，手机界面未挂载。');
        return;
    }

    // Hot-reload protection: do not leave a stale root owned by an old module copy.
    documentRef.getElementById(EXTENSION_ROOT_ID)?.remove();

    const mvu = () => globalThis.Mvu;
    const getContext = globalThis.SillyTavern?.getContext?.bind(globalThis.SillyTavern);
    const fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
    const llmClient = fetchImpl ? createOpenAICompatibleClient({ fetchImpl }) : null;
    const imageGenerationClient = fetchImpl ? createImageGenerationClient({ fetchImpl }) : null;
    // 一次性远程图片导入（用户主动触发才请求；URL 不落库、不作渲染来源）。
    const remoteImageImporter = fetchImpl ? createRemoteImageImporter({ fetchImpl }) : null;
    // Resolve the host's localforage adapter at activation time because SillyTavern may publish libs after module import.
    const imageLibrary = createImageLibraryStore({ storage: globalThis.SillyTavern?.libs?.localforage });
    const imageMatchCoordinator = createImageMatchCoordinator({ imageLibrary, settingsStore, llmClient });
    // Group/forum conversations and their summaries are intentionally separate
    // from MVU. localforage keeps their bounded browser cache out of settings.json
    // and out of the main narrative prompt; a blocked adapter degrades to memory.
    let groupForumStore = createGroupForumStore({ storage: globalThis.SillyTavern?.libs?.localforage });
    try { await groupForumStore.ready(); }
    catch {
        groupForumStore = createGroupForumStore();
        await groupForumStore.ready();
    }
    const serviceOrderHistoryStore = createServiceOrderHistoryStore({ getScope: () => serviceOrderHistoryScope(getContext) });
    const actionBridge = createActionBridge({
        documentRef,
        mvu,
        eventEmit: globalThis.eventEmit,
        getContext,
        settingsStore,
        llmClient,
        imageGenerationClient,
        imageMatchCoordinator,
    });
    appInstance = mountPhoneApp({
        documentRef,
        rootId: EXTENSION_ROOT_ID,
        actionBridge,
        settingsStore,
        llmClient,
        characterLibrary,
        playerAvatarStore,
        imageLibrary,
        imageMatchCoordinator,
        remoteImageImporter,
        groupForumStore,
        serviceOrderHistoryStore,
        readState: () => readLatestState({ mvu: mvu() }),
    });

    const instance = appInstance;
    const refreshFromHostEvent = () => appInstance?.refreshState();
    bindStateUpdateSubscriptions({ mvu, getContext, onUpdate: refreshFromHostEvent });
    refreshWhenMvuReady({ instance, mvu, getContext, onUpdate: refreshFromHostEvent });
    pageHideHandler = () => destroyActiveInstance();
    if (typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('pagehide', pageHideHandler, { once: true });
    }
}

/**
 * SillyTavern v1.18+ disable hook (declared in manifest.json).
 * It clears the in-memory Key mirror and releases all event/DOM resources before
 * the extension becomes inactive; the user-approved browser-local Key cache stays.
 */
export function onDisable() {
    destroyActiveInstance();
}

/** SillyTavern v1.18+ deletion hook; it uses the same runtime-only cleanup. */
export function onDelete() {
    destroyActiveInstance();
}
