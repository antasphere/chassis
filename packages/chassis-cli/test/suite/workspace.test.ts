import { describe, expect, it } from 'vitest';
import {
  findWorkspace,
  isWorkspaceId,
  matchWorkspace,
  type MeResponse,
  type MeWorkspace
} from '@antasphere/chassis-cli';
import { routedHarness, tempConfigEnv } from '@antasphere/chassis-cli/testing';
import { cli, run } from '@chassis-cli-test/host';
import { filesRoute, key, meBody, meRoute, wsRow } from './signin-fixtures.js';

// The kit's workspace functions, and the literals that spell the tool (its identity).
const { describeSelection, describeSource, explainRefusal, pickWorkspaceSelection } = cli.workspace;
const { bin } = cli.identity;
const WS_ENV = `${cli.identity.envPrefix}_WORKSPACE`;
const ORG_ENV = `${cli.identity.envPrefix}_ORG`;

/**
 * PRDCT-2419, the pure half: which value selects the workspace (the
 * resolution order), and which membership a value names (the matching).
 * The wire half is workspaces-cli.test.ts.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const URL = 'https://slides.example.com';

function ws(id: string, name: string, over: Partial<MeWorkspace> = {}): MeWorkspace {
  return {
    id,
    name,
    role: 'member',
    hubOrigin: false,
    look: { theme: null, pattern: null, field: null, grain: null },
    suspended: false,
    default: false,
    centralAccountId: null,
    ...over
  };
}

const pick = (over: Partial<Parameters<typeof pickWorkspaceSelection>[0]>) =>
  pickWorkspaceSelection({ workspaceFlag: undefined, orgFlag: undefined, env: {}, ...over });

describe('the selection: --org or --workspace, then ORG or WORKSPACE, then nothing', () => {
  it('a flag wins over a variable of either kind', () => {
    expect(pick({ workspaceFlag: 'Acme', env: { [WS_ENV]: B } })).toEqual({
      value: 'Acme',
      source: 'flag',
      kind: 'workspace'
    });
    expect(pick({ workspaceFlag: 'Acme', env: { [ORG_ENV]: B } })).toEqual({
      value: 'Acme',
      source: 'flag',
      kind: 'workspace'
    });
    expect(pick({ orgFlag: 'Acme', env: { [WS_ENV]: B } })).toEqual({
      value: 'Acme',
      source: 'flag',
      kind: 'org'
    });
  });

  it('a flag wins even over two variables at once', () => {
    expect(pick({ orgFlag: 'Acme', env: { [WS_ENV]: B, [ORG_ENV]: C } })).toEqual({
      value: 'Acme',
      source: 'flag',
      kind: 'org'
    });
  });

  it('each variable selects its own kind', () => {
    expect(pick({ env: { [WS_ENV]: B } })).toEqual({ value: B, source: 'env', kind: 'workspace' });
    expect(pick({ env: { [ORG_ENV]: B } })).toEqual({ value: B, source: 'env', kind: 'org' });
  });

  it('nothing selected is undefined: no header, the server picks', () => {
    expect(pick({})).toBeUndefined();
  });

  it('values are trimmed', () => {
    expect(pick({ workspaceFlag: '  Acme  ' })?.value).toBe('Acme');
    expect(pick({ orgFlag: '  Acme  ' })?.value).toBe('Acme');
    expect(pick({ env: { [WS_ENV]: ` ${B}\n` } })?.value).toBe(B);
    expect(pick({ env: { [ORG_ENV]: ` ${B}\n` } })?.value).toBe(B);
  });

  it('both flags at once is a usage error', () => {
    expect(() => pick({ orgFlag: 'Acme', workspaceFlag: 'Beta' })).toThrow(
      'Pass --org or --workspace, not both.'
    );
  });

  it('both variables at once is a usage error', () => {
    expect(() => pick({ env: { [ORG_ENV]: A, [WS_ENV]: B } })).toThrow(
      `Set ${ORG_ENV} or ${WS_ENV}, not both.`
    );
  });

  it('an empty flag is a usage error, never a silent fall-through', () => {
    expect(() => pick({ workspaceFlag: '   ', env: { [WS_ENV]: B } })).toThrow(/--workspace needs/);
    expect(() => pick({ orgFlag: '  ', env: { [ORG_ENV]: B } })).toThrow(
      '--org needs an organization id or name.'
    );
  });

  it('an empty environment variable is an unset one and falls through', () => {
    expect(pick({ env: { [WS_ENV]: '' } })).toBeUndefined();
    expect(pick({ env: { [WS_ENV]: '  ' } })).toBeUndefined();
    expect(pick({ env: { [ORG_ENV]: ' ', [WS_ENV]: B } })).toEqual({
      value: B,
      source: 'env',
      kind: 'workspace'
    });
    expect(pick({ env: { [ORG_ENV]: B, [WS_ENV]: '' } })).toEqual({ value: B, source: 'env', kind: 'org' });
  });
});

describe('matching a value against the memberships', () => {
  const list = [ws(A, 'Acme'), ws(B, 'Atelier Nord'), ws(C, 'atelier sud')];

  it('an exact id matches', () => {
    expect(matchWorkspace(list, B).name).toBe('Atelier Nord');
  });

  it('a name matches without regard to case, and around spaces', () => {
    expect(matchWorkspace(list, 'acme').id).toBe(A);
    expect(matchWorkspace(list, '  ATELIER NORD ').id).toBe(B);
  });

  it('a name is matched whole, never as a prefix', () => {
    expect(() => matchWorkspace(list, 'Atelier')).toThrow(/not one of your workspaces/);
  });

  it('the id wins over a workspace that carries that id as its name', () => {
    const tricky = [ws(A, B), ws(B, 'Real')];
    expect(matchWorkspace(tricky, B).name).toBe('Real');
  });

  it('an ambiguous name errors and lists only the candidates, by id', () => {
    const twins = [ws(A, 'Acme'), ws(B, 'ACME'), ws(C, 'Other')];
    let message = '';
    try {
      matchWorkspace(twins, 'acme');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('Several of your workspaces are named "acme"');
    expect(message).toContain(A);
    expect(message).toContain(B);
    expect(message).not.toContain(C);
  });

  it('an unknown value errors and lists every workspace', () => {
    let message = '';
    try {
      matchWorkspace(list, 'Nowhere');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('"Nowhere" is not one of your workspaces');
    for (const w of list) expect(message).toContain(`${w.id}  member  ${w.name}`);
  });

  it('an unknown value with no membership at all still reads', () => {
    expect(() => matchWorkspace([], 'x')).toThrow(/\(none\)/);
  });

  it('findWorkspace reports the ambiguity without throwing', () => {
    expect(findWorkspace([ws(A, 'x'), ws(B, 'X')], 'x')).toMatchObject({ match: null });
    expect(findWorkspace([ws(A, 'x'), ws(B, 'X')], 'x').ambiguous).toHaveLength(2);
    expect(findWorkspace(list, 'nope')).toEqual({ match: null, ambiguous: [] });
  });

  it('a hub organization id matches the row that projects it, without regard to case', () => {
    const O = '99999999-9999-4999-8999-999999999999';
    const withOrg = [ws(A, 'Acme', { centralAccountId: O }), ws(B, 'Beta')];
    expect(findWorkspace(withOrg, O).match?.id).toBe(A);
    expect(findWorkspace(withOrg, O.toUpperCase()).match?.id).toBe(A);
  });

  it('the workspace id wins over a row carrying that id as its organization id', () => {
    const tricky = [ws(A, 'First', { centralAccountId: B }), ws(B, 'Second')];
    expect(findWorkspace(tricky, B).match?.name).toBe('Second');
  });

  it('the organization id wins over a row carrying it as its name', () => {
    const O = '99999999-9999-4999-8999-999999999999';
    const tricky = [ws(A, O), ws(B, 'Real', { centralAccountId: O })];
    expect(findWorkspace(tricky, O).match?.name).toBe('Real');
  });

  it('a row from an older server, with no organization id, still matches by id and name', () => {
    const older = { ...ws(A, 'Acme') } as Partial<MeWorkspace>;
    delete older.centralAccountId;
    expect(findWorkspace([older as MeWorkspace], 'acme').match?.id).toBe(A);
    expect(findWorkspace([older as MeWorkspace], A).match?.id).toBe(A);
  });

  it('the candidate lines name the organization of a row that has one', () => {
    const O = '99999999-9999-4999-8999-999999999999';
    let message = '';
    try {
      matchWorkspace([ws(A, 'Acme', { centralAccountId: O }), ws(B, 'Beta')], 'Nowhere');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`${A}  member  Acme  (organization ${O})`);
    expect(message).toContain(`${B}  member  Beta\n`.trimEnd());
    expect(message).not.toContain(`Beta  (organization`);
  });

  it('only the server selector shape is an id', () => {
    expect(isWorkspaceId(A)).toBe(true);
    expect(isWorkspaceId(A.toUpperCase())).toBe(true);
    expect(isWorkspaceId('Acme')).toBe(false);
    expect(isWorkspaceId(`${A} `)).toBe(false);
    expect(isWorkspaceId(A.replace(/-/g, ''))).toBe(false);
  });
});

describe('the words for a source', () => {
  it('names each flag, each variable and the default', () => {
    expect(describeSelection({ source: 'flag', kind: 'org' })).toBe('the --org flag');
    expect(describeSelection({ source: 'flag', kind: 'workspace' })).toBe('the --workspace flag');
    expect(describeSelection({ source: 'env', kind: 'org' })).toBe(ORG_ENV);
    expect(describeSelection({ source: 'env', kind: 'workspace' })).toBe(WS_ENV);
    expect(describeSource('default', undefined)).toBe("the server's default (nothing selected)");
    expect(describeSource('default', 'org')).toBe("the server's default (nothing selected)");
    expect(describeSource('flag', undefined)).toBe("the server's default (nothing selected)");
    expect(describeSource('flag', 'org')).toBe('the --org flag');
    expect(describeSource('env', 'workspace')).toBe(WS_ENV);
  });
});

describe('explaining a refusal the selection caused', () => {
  const me = {
    user: { id: 'u1', email: 'ada@x.co', name: 'Ada' },
    workspace: { id: A, name: 'Acme', hubOrigin: false },
    workspaces: [ws(A, 'Acme', { default: true }), ws(B, 'Atelier Nord')],
    activeWorkspaceId: A
  } as unknown as MeResponse;

  it('403 workspace_mismatch names the pin and the selected workspace', () => {
    const text = explainRefusal({
      code: 'workspace_mismatch',
      status: 403,
      selection: { value: 'atelier nord', source: 'flag', kind: 'workspace' },
      workspaceId: B,
      me,
      baseUrl: URL
    });
    expect(text).toContain(`pinned to the workspace "Acme" (${A})`);
    expect(text).toContain(`the --workspace flag selects "Atelier Nord" (${B})`);
  });

  it('401 on a workspace that is not yours says the key works and lists yours', () => {
    const text = explainRefusal({
      code: 'invalid_api_key',
      status: 401,
      selection: { value: C, source: 'env', kind: 'workspace' },
      workspaceId: C,
      me,
      baseUrl: URL
    });
    expect(text).toBe(
      `The workspace "${C}" (selected by ${WS_ENV}) is not one of yours on ${URL}; the API key itself works. ` +
        `Yours:\n  ${A}  member  Acme\n  ${B}  member  Atelier Nord`
    );
    expect(text).not.toContain('--clear');
    expect(text).not.toContain(`${bin} workspace use`);
  });

  it('401 on an organization that is not yours says organization, and names the --org flag', () => {
    const text = explainRefusal({
      code: 'invalid_api_key',
      status: 401,
      selection: { value: 'Nowhere', source: 'flag', kind: 'org' },
      workspaceId: C,
      me,
      baseUrl: URL
    });
    expect(text).toBe(
      `The organization "Nowhere" (selected by the --org flag) is not one of yours on ${URL}; the API key itself works. ` +
        `Yours:\n  ${A}  member  Acme\n  ${B}  member  Atelier Nord`
    );
  });

  it('403 workspace_mismatch finds the selected row by its organization id too', () => {
    const O = '99999999-9999-4999-8999-999999999999';
    const withOrg = {
      ...me,
      workspaces: [ws(A, 'Acme', { default: true }), ws(B, 'Atelier Nord', { centralAccountId: O })]
    } as unknown as MeResponse;
    const text = explainRefusal({
      code: 'workspace_mismatch',
      status: 403,
      selection: { value: O, source: 'flag', kind: 'org' },
      workspaceId: O,
      me: withOrg,
      baseUrl: URL
    });
    expect(text).toContain(`pinned to the workspace "Acme" (${A})`);
    expect(text).toContain(`the --org flag selects "Atelier Nord" (${B})`);
  });

  it('401 on an organization id that IS yours (by its hub id) is not explained away', () => {
    const O = '99999999-9999-4999-8999-999999999999';
    const withOrg = {
      ...me,
      workspaces: [ws(A, 'Acme'), ws(B, 'Atelier Nord', { centralAccountId: O })]
    } as unknown as MeResponse;
    expect(
      explainRefusal({
        code: 'invalid_api_key',
        status: 401,
        selection: { value: O, source: 'flag', kind: 'org' },
        workspaceId: O,
        me: withOrg,
        baseUrl: URL
      })
    ).toBeNull();
  });

  it('401 on a workspace that IS yours is not explained away: the plain error stands', () => {
    expect(
      explainRefusal({
        code: 'invalid_api_key',
        status: 401,
        selection: { value: B, source: 'flag', kind: 'workspace' },
        workspaceId: B,
        me,
        baseUrl: URL
      })
    ).toBeNull();
  });

  it('G8: workspace_mismatch is the pin only at 403; any other status keeps the plain error', () => {
    expect(
      explainRefusal({
        code: 'workspace_mismatch',
        status: 500,
        selection: { value: B, source: 'flag', kind: 'workspace' },
        workspaceId: B,
        me,
        baseUrl: URL
      })
    ).toBeNull();
  });

  it('any other refusal is not the selection to explain', () => {
    expect(
      explainRefusal({
        code: 'forbidden',
        status: 403,
        selection: { value: C, source: 'flag', kind: 'workspace' },
        workspaceId: C,
        me,
        baseUrl: URL
      })
    ).toBeNull();
  });
});

describe('the selection on the wire: a name is looked up, an id is sent as it is (verifier round 1, N3)', () => {
  const ORG_OF_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const ROWS = [
    wsRow(A, 'Acme', { default: true }),
    wsRow(B, 'Beta', { hubOrigin: true, centralAccountId: ORG_OF_B })
  ];

  async function signedIn(): Promise<Record<string, string>> {
    const env = await tempConfigEnv();
    cli.saveConfig(env, {
      activeProfile: 'inst',
      profiles: { inst: { apiKey: key('work'), baseUrl: 'http://inst' } }
    });
    return env;
  }

  it.each([
    ['--workspace <name>', ['--workspace', 'beta']],
    ['--org <name>', ['--org', 'Beta']]
  ] as const)('%s: one bare /me, then the LOCAL id as x-workspace-id', async (_label, args) => {
    const h = routedHarness([meRoute(meBody({ workspaces: ROWS })), filesRoute], await signedIn());
    expect(await run(['files', 'list', ...args], h.io)).toBe(0);
    expect(h.wire.map((c) => `${c.method} ${c.path} ${c.workspace ?? '-'}`)).toEqual([
      'GET /api/v1/me -',
      `GET /api/v1/files ${B}`
    ]);
  });

  it('--org <hub organization id>: sent as it is, no lookup (the server maps it)', async () => {
    const h = routedHarness([meRoute(meBody({ workspaces: ROWS })), filesRoute], await signedIn());
    expect(await run(['files', 'list', '--org', ORG_OF_B], h.io)).toBe(0);
    expect(h.wire.map((c) => `${c.method} ${c.path} ${c.workspace ?? '-'}`)).toEqual([
      `GET /api/v1/files ${ORG_OF_B}`
    ]);
  });
});
