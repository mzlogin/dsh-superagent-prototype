import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import { KV, type Key } from '../src/kv.ts'
import { githubInstanceId } from '../src/sources/instance-id.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-migration12-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const ID = 'github-acme-widgets'

it('derives a readable instance id from the repository', () => {
  expect(githubInstanceId('Acme/Widgets')).toBe(ID)
  expect(githubInstanceId('a.b_c/d-e')).toBe('github-a-b-c-d-e')
  expect(githubInstanceId('')).toBe('github')
})

it('renames the legacy github instance in settings and every stored record', () => {
  const path = join(directory, 'db.sqlite')
  const store = new Store(path)
  store.saveSettings({ sources: { github: { enabled: true, config: { repository: 'Acme/Widgets', cli: '/x/gh' } } },
    policy: { sources: { github: { allowed: [{ id: 'alice' }] } } } }, { source: 'panel', policyVersion: 'v0', policyChanged: false, notified: [] })
  store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: 't', subscriptions: [], correlated: ['github:8'], pending: [], meta: {} })
  store.threads.save({ key: 'github:8', ref: { source: 'github', id: '8' }, createdAt: 't', subscriptions: [], correlated: [], pending: [], meta: {} })
  store.triggers.save({ id: 'trig-1', source: 'github', threads: [{ source: 'github', id: '7' }], actor: { source: 'github', id: 'alice' },
    human: true, at: 't', text: 'x', channel: { source: 'github', thread: 'github:7', address: { number: '7' } }, meta: {} })
  store.db.prepare('INSERT INTO ticket VALUES (?,?)').run('t1', JSON.stringify({ id: 't1', title: 'T', decisionId: 'd1',
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { source: 'github', scope: {}, sender: 'alice' }, actor: { source: 'github', id: 'alice' }, scope: 's' },
    channels: [{ source: 'github', thread: 'github:7', address: {} }], assignments: [], inputs: [], undelivered: [],
    follows: [{ thread: 'github:8', own: true }], createdAt: 't', updatedAt: 't', origin: { triggerId: 'trig-1', triggerIds: [] } }))
  store.db.prepare('INSERT INTO decision VALUES (?,?,?)').run('d1', 'github:7', JSON.stringify({ id: 'd1', evalId: 'e1', threadKey: 'github:7', triggerIds: ['trig-1'],
    policyVersion: 'v', at: 't', kind: 'accept', reason: [], strength: 'explicit', ticketId: 't1',
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { source: 'github', scope: {}, sender: 'alice' }, actor: { source: 'github', id: 'alice' }, scope: 's' } }))
  store.db.prepare('INSERT INTO outbox VALUES (?,?)').run('r1', JSON.stringify({ id: 'r1', channel: { source: 'github', thread: 'github:7', address: { number: '7' } }, text: 'hi', kind: 'reply', status: 'sent' }))
  store.set('github-since' as Key<string>, '2026-01-01')
  store.set('source-labels:github' as Key<Record<string, string>>, { alice: 'Alice' })
  store.set('settings-block-revision:source:github' as Key<number>, 3)
  store.set(KV.store.schema, 11)
  store.close()

  const migrated = new Store(path)
  expect(migrated.get(KV.store.schema)).toBe(SCHEMA_VERSION)
  const settings = migrated.settings()
  expect(Object.keys(settings.sources)).toEqual([ID])
  expect(settings.sources[ID]!.config.repository).toBe('Acme/Widgets')
  expect(Object.keys(settings.policy.sources)).toEqual([ID])
  expect(migrated.threads.list().map(thread => thread.key)).toEqual([`${ID}:7`, `${ID}:8`])
  expect(migrated.threads.get(`${ID}:7`)!.correlated).toEqual([`${ID}:8`])
  expect(migrated.triggers.get('trig-1')).toMatchObject({ source: ID, threads: [{ source: ID, id: '7' }], actor: { source: ID },
    channel: { source: ID, thread: `${ID}:7` } })
  expect(migrated.db.prepare('SELECT thread FROM trigger_thread').all().map(row => row.thread)).toEqual([`${ID}:7`])
  expect(migrated.tickets.get('t1')).toMatchObject({ mandate: { basis: { source: ID }, actor: { source: ID } },
    channels: [{ source: ID, thread: `${ID}:7` }], follows: [{ thread: `${ID}:8`, own: true }] })
  expect(migrated.decisions.get('d1')).toMatchObject({ threadKey: `${ID}:7`, mandate: { basis: { source: ID } } })
  expect(migrated.db.prepare('SELECT thread FROM decision WHERE id=?').get('d1')).toEqual({ thread: `${ID}:7` })
  expect(JSON.parse(String((migrated.db.prepare('SELECT value FROM outbox WHERE id=?').get('r1') as { value: string }).value)).channel)
    .toEqual({ source: ID, thread: `${ID}:7`, address: { number: '7' } })
  expect(migrated.get('github-since' as Key<string>)).toBeUndefined()
  expect(migrated.get(`${ID}-since` as Key<string>)).toBe('2026-01-01')
  expect(migrated.get(`${ID}-since`.replace('-since', '') as never)).toBeUndefined()
  expect(migrated.get(`source-labels:${ID}` as Key<Record<string, string>>)).toEqual({ alice: 'Alice' })
  expect(migrated.get(`settings-block-revision:source:${ID}` as Key<number>)).toBe(3)
  migrated.close()
})

it('keeps the legacy id while no repository is configured', () => {
  const path = join(directory, 'db.sqlite')
  const store = new Store(path)
  store.saveSettings({}, { source: 'internal', policyVersion: '', policyChanged: false, notified: [] })
  store.set(KV.store.schema, 11)
  store.close()
  const migrated = new Store(path)
  expect(migrated.settings().sources).toEqual({})
  expect(migrated.get(KV.store.schema)).toBe(SCHEMA_VERSION)
  migrated.close()
})
