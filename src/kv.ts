/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { AssistantContextConfig, AssistantStoredMessage, PendingUserQuestion } from './app/claw-assistant.ts'
import type { DeviceGroupPacket, DeviceIdentityRecord } from './app/device-group.ts'
import type { LcmDagState, LearningEntry } from './app/lossless-and-learning.ts'
import type { MemoryEntry, PluginRegistryState } from './app/memory-plugin.ts'
import type { ModelProfilesConfig } from './app/model-profiles.ts'
import type { ClawFeedNotificationRecord } from './app/personal-skills.ts'
import type { SessionProgressCard } from './app/research-and-ux-plugins.ts'
import type { ModelUsageState, RuntimeGuardStats } from './app/runtime-guard-plugin.ts'
import type { PromptVersion } from './app/prompts.ts'
import type { SettingsVersion } from './app/store.ts'
import type { WorkerNodeRecord } from './app/worker-nodes.ts'
import type { SettingsSave } from './policy.ts'
import type { Retry } from './sources/github.ts'
import type { PanelStoredMessage } from './sources/panel.ts'

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Runtime: the main Session's ID. */
  runtime: { masterId: record<string>('master-id') },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Schema 11 migration: legacy main-Session queues imported into the effect table. */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
   * per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
   * counts reported CI changes so each produces a distinct Trigger ID).
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:') },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
  /** Local Panel Source: stored outbound and inbound messages per conversation. */
  panel: { messages: family<PanelStoredMessage[], [conversation: string]>('panel-messages:') },
  /** Distributed LAN Worker Nodes registry and per-Ticket assigned node ID. */
  nodes: {
    registry: record<WorkerNodeRecord[]>('worker-nodes-registry'),
    ticketNode: family<{ nodeId: string; nodeName: string; gitSource?: string; branch?: string; synced?: boolean }, [ticketId: string]>('ticket-worker-node:'),
  },
  /** Decentralized Device Group identity and signed group membership packet. */
  deviceGroup: {
    identity: record<DeviceIdentityRecord>('device-group-identity'),
    packet: record<DeviceGroupPacket>('device-group-packet'),
  },
  /** Model configuration profiles (Preset 1, 2, 3) and peak/off-peak time-window scheduler. */
  modelProfiles: {
    config: record<ModelProfilesConfig>('model-profiles-config'),
  },
  /** First-class Memory plugin entries and Plugin Manager enabled/disabled state. */
  memory: {
    items: record<MemoryEntry[]>('memory-plugin-entries'),
  },
  plugins: {
    state: record<PluginRegistryState>('plugin-registry-state'),
    config: family<Record<string, unknown>, [pluginId: string]>('plugin-custom-config:'),
  },
  /** Personal Assistant (Claw Assistant) conversation messages, sliding context window config, pending questions, and engineering handoff statuses. */
  assistant: {
    messages: record<AssistantStoredMessage[]>('claw-assistant-messages'),
    contextConfig: record<AssistantContextConfig>('claw-assistant-context-config'),
    questions: record<PendingUserQuestion[]>('claw-assistant-questions'),
  },
  /** ClawFeed External Git-Repo Plugin (`@rharness/plugin-clawfeed`) notification ring buffer. */
  clawfeed: {
    items: record<ClawFeedNotificationRecord[]>('clawfeed-plugin-notifications'),
  },
  /** Runtime Guardrails (`@rharness/plugin-runtime-guard`) & Model Usage Telemetry (`@rharness/plugin-model-usage`). */
  runtimeGuard: {
    stats: record<RuntimeGuardStats>('runtime-guard-stats'),
  },
  modelUsage: {
    state: record<ModelUsageState>('model-usage-telemetry'),
  },
  /** Lossless Context DAG (`@rharness/plugin-lossless-context`), Self-Improving Ledger (`@rharness/plugin-self-improving`), and Session Progress Cards (`@rharness/plugin-progress-card`). */
  lossless: {
    dag: record<LcmDagState>('lossless-context-dag'),
  },
  learnings: {
    items: record<LearningEntry[]>('self-improving-learnings'),
  },
  progressCards: {
    bySession: record<Record<string, SessionProgressCard>>('session-progress-cards'),
  },
}
