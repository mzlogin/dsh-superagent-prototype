/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'

/** Health entries a Source kind declares, renamed per instance: `github` stays `github`, `github-2` uses `github-2`. */
export const instanceHealthNames = (kind: { kind: string; health: readonly string[] }, instanceId: string): string[] =>
  kind.health.map(name => instanceId === kind.kind ? name : name === kind.kind ? instanceId : name.replace(kind.kind, instanceId))

/**
 * Manages registered SourceKind plugins, their instances, validates their configurations, and implements SourceScope for the Engine.
 * Claims each instance's health entries on HealthBoard and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly registrations = new Map<string, { kind: SourceKind; health: Map<string, HealthEntry> }>()
  private readonly health = new Map<string, HealthEntry>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /** Registers one instance of a SourceKind (the kind id by default), claims the instance's health entries, and returns an unregister disposer. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>, instanceId: string = kind.kind): () => void {
    if (this.registrations.has(instanceId)) throw new Error(`Source instance already registered: ${instanceId}`)
    const refused = (name: string) => new Error(`Source instance ${instanceId} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const names = instanceHealthNames(kind, instanceId)
    const entries = new Map<string, HealthEntry>()
    const release = () => { for (const [name, entry] of entries) { entry.release(); this.health.delete(name) } }
    for (const name of names) {
      try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw refused(name) }
    }
    for (const [name, entry] of entries) this.health.set(name, entry)
    const fresh = !this.kinds.has(kind.kind)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    this.registrations.set(instanceId, { kind: kind as unknown as SourceKind, health: entries })
    const unregistered = fresh ? this.registered(kind as unknown as SourceKind) : () => {}
    return () => {
      this.registrations.delete(instanceId)
      if (![...this.registrations.values()].some(entry => entry.kind.kind === kind.kind)) this.kinds.delete(kind.kind)
      release()
      unregistered()
    }
  }
  /** Returns the active health entries for `names`, translated to the instance that registered them. */
  healthEntries(names: readonly string[]): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => { const entry = this.health.get(name); return entry ? [[name, entry] as const] : [] }))
  }
  /** True when an instance with this id is already registered. */
  has(id: string): boolean { return this.registrations.has(id) }
  /** The kind with this id, or the kind of an instance whose id is not the kind id. */
  kind(id: string): SourceKind | undefined { return this.kinds.get(id) ?? (this.kindOf(id) ? this.kinds.get(this.kindOf(id)!.kind) : undefined) }
  /** Resolves an instance id to its kind: the kind id itself or a `<kind>-<suffix>` instance. */
  kindOf(id: string): SourceKind | undefined {
    const exact = this.kinds.get(id)
    if (exact) return exact
    let found: SourceKind | undefined
    for (const kind of this.kinds.values()) {
      if (!id.startsWith(`${kind.kind}-`)) continue
      if (!found || kind.kind.length > found.kind.length) found = kind
    }
    return found
  }
  /** Every registered instance ordered by ID, followed by stored instances that no registration covers (their kind kept when installed). */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const registered = [...this.registrations.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([id, { kind }]) => ({ ...this.resolve(kind, settings.sources[id], id), installed: true }))
    const covered = new Set(this.registrations.keys())
    const pending = Object.entries(settings.sources).filter(([id]) => !covered.has(id))
      .map(([id, stored]) => ({ id, kind: this.kindOf(id)?.kind ?? id, enabled: stored.enabled, config: stored.config, installed: this.kindOf(id) !== undefined }))
    return [...registered, ...pending]
  }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const kind = this.kindOf(id)
    return kind ? this.resolve(kind, settings.sources[id], id) as SourceInstance<C> : undefined
  }
  validate(id: string, value: { enabled: boolean; config: unknown }): { enabled: boolean; config: Record<string, unknown> } {
    const kind = this.kindOf(id)
    if (!kind) throw new Error(`Source kind not installed: ${id}`)
    return { enabled: value.enabled, config: kind.schema.parse(value.config) }
  }
  /** Validates each Source's part of a submitted Policy against its kind; policy parts for uninstalled Source kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kindOf(id)?.policy
      // `admission` is validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kindOf(id)?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const kind = this.kindOf(channel.source)
    if (!kind) return false
    const instance = this.resolve(kind, settings.sources[channel.source], channel.source)
    return instance.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  environments(settings = this.settings()) {
    return [...this.registrations.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([id, { kind }]) => {
      const instance = this.resolve(kind, settings.sources[id], id)
      return kind.environment && instance.enabled ? [{ kind, environment: kind.environment, config: instance.config }] : []
    })
  }
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kindOf(message.channel.source)
    if (!kind) return 'waiting'
    return kind.channel ? kind.channel.send({ commands }, message) : 'gone'
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const link = this.kindOf(channel.source)?.channel?.link(channel.address, links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const found = [...this.registrations.entries()].flatMap(([id, { kind }]) => kind.find ? [kind.find(query, id)] : [])
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kindOf(trigger.source)?.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kindOf(trigger.source)
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const { config } = this.resolve(kind, settings.sources[trigger.source], trigger.source)
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(commands, trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, commands, trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const kind = this.kindOf(input.source)
    const stored = settings.sources[input.source]
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!kind) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.resolve(kind, stored, input.source)
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve(kind: SourceKind, stored: { enabled: boolean; config: Record<string, unknown> } | undefined, id = kind.kind): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}
