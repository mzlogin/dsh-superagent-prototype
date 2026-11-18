/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

/** Settings keys that belong to `kind`, including the numbered instances a GitHub Source may have. */
export const sourceIdsOf = (settings: Settings, kind: string): string[] =>
  Object.keys(settings.sources).filter(id => id === kind || id.startsWith(`${kind}-`)).sort()
const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).flatMap(([kind, keys]) =>
    sourceIdsOf(settings, kind).map(id => [id, ...keys.map(key => settings.sources[id]?.config[key] ?? '')])))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** Deployments resolved for GitHub instances beyond the first, keyed by instance id. */
  private readonly deployments = new Map<string, Deployment>()
  /** Problems of individual Source instances: the GitHub account is shared, each repository is checked on its own. */
  readonly problems: Record<string, SetupProblem> = {}
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  /** The deployment of one Source instance: the shared account, with that instance's repository. */
  deploymentFor(id: string): Deployment { return this.deployments.get(id) ?? this.deployment }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    this.deployments.clear()
    for (const key of Object.keys(this.problems)) delete this.problems[key]
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const id = block.slice('source:'.length)
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources[id]?.config, this.probe())
      : resolveDeployment(machine, settings.sources[id]?.config, this.probe())
    // The check covers only this block, so its setup error always refuses the save; a source instance's place is its
    // kind, not its id, so comparing places would swallow it.
    await check.catch((error: unknown) => { if (error instanceof SetupError) throw error; throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    // The first configured GitHub instance carries the repository the worker environment is written for; every other
    // instance is checked on its own and its failure stays on that instance.
    const configured = sourceIdsOf(settings, 'github').filter(id => String((settings.sources[id]?.config as Record<string, unknown> | undefined)?.repository ?? '') !== '')
    const primary = configured[0]
    const deployment = await resolveDeployment(machine, primary ? settings.sources[primary]?.config : undefined, probe)
    this.deployments.set(primary ?? 'github', deployment)
    for (const id of configured.slice(1)) {
      try { this.deployments.set(id, await resolveDeployment(machine, settings.sources[id]?.config, probe)) }
      catch (error) {
        if (!(error instanceof SetupError)) throw error
        this.problems[id] = error.problem
      }
    }
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
