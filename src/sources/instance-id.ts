/** Instance ids for Source entries: settings keys (`^[a-z][a-z0-9-]*$`), readable in Thread keys and health rows. */
export const INSTANCE_ID_MAX = 48

/**
 * Derives a GitHub Source instance id from `owner/name`: lowercase, letters, digits and hyphens only,
 * cut to {@link INSTANCE_ID_MAX} characters. The caller resolves collisions by appending a counter.
 */
export function githubInstanceId(repository: string): string {
  const slug = repository.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const id = `github-${slug}`.slice(0, INSTANCE_ID_MAX).replace(/-+$/g, '')
  return id.length > 'github-'.length ? id : 'github'
}
