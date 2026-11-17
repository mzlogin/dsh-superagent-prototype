# 009 Multi-repository

> Design note for the `feat/multi-repository` branch. It extends the model in
> [001 Domain model](001-domain.md) and [007 Architecture](007-architecture.md)
> without changing the single-repository behaviour of a profile that keeps one
> GitHub Source.

## Goal

One dsh-superagent deployment watches several GitHub repositories at the same
time: each repository is a Source instance with its own read position, allowed
list, Threads and Tickets. The agent account is the same for all of them; the
executor keeps one checkout root per repository.

## Model

"Source" today means a Source *kind*: its id is the kind (`github`), so one
deployment can hold one GitHub repository. This branch makes the id an
*instance* id, derived from the Cordis entry id by stripping the
`dsh-superagent-` prefix:

| Entry id in `cordis.patch.yml` | Source instance id |
| --- | --- |
| `dsh-superagent-github` | `github` |
| `dsh-superagent-github-2` | `github-2` |
| `dsh-superagent-feishu` | `feishu` |

Everything that is keyed by a Source is keyed by the instance id from then on:

- `Trigger.source` and `Thread.source` carry the instance id, so Policy,
  Channels, Outbox and Subscriptions resolve the right instance.
- `settings.sources[instanceId]` holds `{enabled, config}`; a GitHub instance's
  config keeps `repository`, `cli`, `pollSeconds`, the `observe*` switches.
- `policy.sources[instanceId]` holds that repository's allowed list, bots and
  admission table.
- Thread keys become `<instanceId>:<number>` and `<instanceId>:ci:<branch>`;
  Trigger ids add the instance id to the same hash input.
- Polling cursors become `<instanceId>-since`, `<instanceId>-cursor:<n>`,
  `<instanceId>-ci:<branch>` and so on.
- Health entries are renamed per instance (`github`, `github-2`, ...), so the
  status board and the panel show one row per repository.
- Setup resolves one deployment per enabled instance: the same agent CLI and
  account, one push-access check per repository. `Deployment` gains a map
  keyed by instance id instead of one `repository`.
- The executor keeps one prepare command. Each ticket's process environment
  already carries `DSH_SUPERAGENT_GITHUB_REPOSITORY` from the Source that
  created it, so a single command dispatches on that variable to the right
  clone.
- The panel lists one card per instance, each with its own repository, CLI,
  allowed list and health.

## Compatibility

Every instance uses the same rule, including the first one. A profile created
before this change stores its single repository as `github`, so a schema 12
migration renames that instance to `github-<owner>-<repo>` in one transaction:
settings and their stored versions, the Policy, Thread keys and their
`correlated`/`context` references, `trigger`/`trigger_thread`, `decision`,
`ticket` Mandates and bases, the Outbox, and the `github-*` KV keys (cursors,
retries, streams, CI revisions). A profile with no repository configured keeps
`github` until its first save assigns the derived id.

## Configuration

One Cordis entry stays the only GitHub entry. The instance list lives in
settings: `settings.sources` holds every `github`-prefixed key (`github`,
`github-teacher-ios`, ...), so the panel can add and remove repositories
without editing the loader configuration. The plugin keeps one watcher per
enabled instance and disposes it when the instance is removed.

The instance id keeps the settings-key rule `[a-z][a-z0-9-]*`. A new instance
takes `github-<owner>-<repo>`, slugified to lowercase letters, digits and
hyphens (GitHub allows dots, underscores and capitals, which become hyphens)
and cut to 48 characters; a collision gets a `-2`, `-3` suffix. The id is a
stable handle chosen when the repository is added and does not change when its
`repository` configuration is edited later; the panel always shows the live
`owner/name` from the configuration, not the id.

## Phases

0. **Schema 12 migration.** Rename the legacy `github` instance to its
   derived id before the runtime reads Settings, Threads or `kv`.
1. **Registry instances.** `SourceRegistry.register(kind, instanceId)`,
   `instances()`/`instance(id)`/`channelAllowed`/`scope`/`send`/`threadContext`
   resolve by instance id; health entries are namespaced; settings and policy
   validate an instance by its kind prefix. No behaviour change for a single
   instance; add registry tests.
2. **GitHub Source.** Thread/Trigger id helpers take the instance id; cursors
   and health names do too; the Source reads its instance id from the Cordis
   entry and registers it.
3. **Setup and environment.** Resolve a `Deployment` per instance; validate
   each enabled repository's push access; pick the ticket's deployment by its
   Trigger's Source; keep one worker git config and one shim directory.
4. **Panel.** Source list renders every instance with its own form, health and
   setup problem, plus Add and Remove actions that save the `source:<id>`
   block.
5. **Template and docs.** Ship a patch template with N GitHub entries,
   document adding a repository, and note the migration story.

## Decisions

- Repositories may be added and removed from the panel; no patch edit or
  profile restart is required for the source list itself.
- Every repository has its own allowed list and admission table.
- Every repository uses the same agent account (one `gh-agent`).

## Out of scope

- Several Feishu bots, or a different agent account per repository.
- Moving Tickets between instances.

