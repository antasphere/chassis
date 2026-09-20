import { describe, expect, it } from 'vitest';
import { projectErrorHints } from '@antasphere/chassis-server/mcp';

/**
 * The project hints are composed per tool: a hint that names a tool names it
 * as it is registered, under the tool's prefix, or a model follows it to a
 * tool that does not exist.
 */
describe('projectErrorHints', () => {
  it('names the member tools under the prefix given, never bare', () => {
    const hints = projectErrorHints('acme_');
    for (const name of [
      'add_project_member',
      'set_project_member_role',
      'remove_project_member',
      'list_project_members'
    ]) {
      expect(hints.member_not_found).toContain(`acme_${name}`);
      expect(hints.member_not_found).not.toMatch(new RegExp(`(^|[^_a-z])${name}`));
    }
  });

  it('words guest_forbidden, the answer of every project route to a guest', () => {
    expect(projectErrorHints('x_').guest_forbidden).toContain('guests take no part in projects');
  });
});
