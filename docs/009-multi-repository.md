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

The first instance keeps the id `github`, so an existing profile's settings,
policy, Threads, Triggers, cursors and Tickets stay valid: keys only gain the
instance prefix when the instance is not `github`. New instances start empty.

## Configuration

The profile's `cordis.patch.yml` declares one entry per repository:

```yaml
- insert:
    - id: dsh-superagent-github
      name: dsh-superagent/github-watch
    - id: dsh-superagent-github-2
      name: dsh-superagent/github-watch
    - id: dsh-superagent-github-3
      name: dsh-superagent/github-watch
```

Each entry becomes a Source card; the repository and CLI are set in the panel,
as today. Adding a repository means adding an entry and restarting the profile.

## Phases

1. **Registry instances.** `SourceRegistry.register(kind, instanceId)`,
   `instances()`/`instance(id)`/`channelAllowed`/`scope`/`send`/`threadContext`
   resolve by instance id; health entries are namespaced. No behaviour change
   for a single instance; add registry tests.
2. **GitHub Source.** Thread/Trigger id helpers take the instance id; cursors
   and health names do too; the Source reads its instance id from the Cordis
   entry and registers it.
3. **Setup and environment.** Resolve a `Deployment` per instance; validate
   each enabled repository's push access; pick the ticket's deployment by its
   Trigger's Source; keep one worker git config and one shim directory.
4. **Panel.** Source list renders every instance with its own form, health and
   setup problem.
5. **Template and docs.** Ship a patch template with N GitHub entries,
   document adding a repository, and note the migration story.

## Out of scope

- Adding or removing an instance from the panel without editing the patch and
  restarting.
- Several Feishu bots, or a different agent account per repository.
- Moving Tickets between instances.

## Open questions

1. A fixed number of entries in the patch, or an "Add repository" button that
   edits the loader configuration at runtime?
2. Should each repository have its own allowed list, or one list shared by all
   GitHub instances?
3. Does every repository use the same agent account (one `gh-agent`), or does
   a repository need its own account?
