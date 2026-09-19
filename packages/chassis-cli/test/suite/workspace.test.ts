import { describe, expect, it } from 'vitest';
import {
  findWorkspace,
  isWorkspaceId,
  matchWorkspace,
  type MeResponse,
  type MeWorkspace
} from '@antasphere/chassis-cli';
import { cli } from '@chassis-cli-test/host';

// The kit's workspace functions, and the literals that spell the tool (its identity).
const { describeSelection, describeSource, explainRefusal, pickWorkspaceSelection } = cli.workspace;
const { bin } = cli.identity;
const WS_ENV = `${cli.identity.envPrefix}_WORKSPACE`;

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
    ...over
  };
}

const pick = (over: Partial<Parameters<typeof pickWorkspaceSelection>[0]>) =>
  pickWorkspaceSelection({
    flag: undefined,
    env: {},
    profile: undefined,
    profileName: undefined,
    baseUrl: URL,
    ...over
  });

describe('the resolution order: flag, then environment, then profile, then nothing', () => {
  const profile = { baseUrl: URL, activeWorkspaceId: C };

  it('the flag wins over the environment and the profile', () => {
    expect(pick({ flag: 'Acme', env: { [WS_ENV]: B }, profile, profileName: 'work' })).toEqual({
      value: 'Acme',
      source: 'flag'
    });
  });

  it('the environment wins over the profile', () => {
    expect(pick({ env: { [WS_ENV]: B }, profile, profileName: 'work' })).toEqual({
      value: B,
      source: 'env'
    });
  });

  it('the profile field is last, and carries the profile name', () => {
    expect(pick({ profile, profileName: 'work' })).toEqual({
      value: C,
      source: 'profile',
      profileName: 'work'
    });
  });

  it('nothing selected is undefined: no header, the server picks', () => {
    expect(pick({})).toBeUndefined();
    expect(pick({ profile: { baseUrl: URL }, profileName: 'work' })).toBeUndefined();
  });

  it('values are trimmed', () => {
    expect(pick({ flag: '  Acme  ' })?.value).toBe('Acme');
    expect(pick({ env: { [WS_ENV]: ` ${B}\n` } })?.value).toBe(B);
  });

  it('an empty flag is a usage error, never a silent fall-through', () => {
    expect(() => pick({ flag: '   ', env: { [WS_ENV]: B } })).toThrow(/--workspace needs/);
  });

  it('an empty environment variable is an unset one and falls through to the profile', () => {
    expect(pick({ env: { [WS_ENV]: '' }, profile, profileName: 'work' })?.source).toBe('profile');
    expect(pick({ env: { [WS_ENV]: '  ' } })).toBeUndefined();
  });

  it('the profile field counts only for the instance the profile names', () => {
    expect(pick({ profile, profileName: 'work', baseUrl: 'https://other.example.com' })).toBeUndefined();
    // A trailing slash is the same instance.
    expect(pick({ profile: { baseUrl: `${URL}/`, activeWorkspaceId: C }, profileName: 'work' })?.value).toBe(
      C
    );
    // A profile with no instance of its own selects nothing.
    expect(pick({ profile: { activeWorkspaceId: C }, profileName: 'work' })).toBeUndefined();
  });

  it('a profile field that is not a usable string selects nothing', () => {
    const bad = { baseUrl: URL, activeWorkspaceId: 42 as unknown as string };
    expect(pick({ profile: bad, profileName: 'work' })).toBeUndefined();
    expect(pick({ profile: { baseUrl: URL, activeWorkspaceId: ' ' }, profileName: 'work' })).toBeUndefined();
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

  it('only the server selector shape is an id', () => {
    expect(isWorkspaceId(A)).toBe(true);
    expect(isWorkspaceId(A.toUpperCase())).toBe(true);
    expect(isWorkspaceId('Acme')).toBe(false);
    expect(isWorkspaceId(`${A} `)).toBe(false);
    expect(isWorkspaceId(A.replace(/-/g, ''))).toBe(false);
  });
});

describe('the words for a source', () => {
  it('names the flag, the variable, the profile and the default', () => {
    expect(describeSelection({ source: 'flag' })).toBe('the --workspace flag');
    expect(describeSelection({ source: 'env' })).toBe(WS_ENV);
    expect(describeSelection({ source: 'profile', profileName: 'work' })).toBe('profile "work"');
    expect(describeSource('default', undefined)).toContain("the server's default");
    expect(describeSource('profile', 'work')).toBe('profile "work"');
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
      selection: { value: 'atelier nord', source: 'flag' },
      workspaceId: B,
      me,
      baseUrl: URL
    });
    expect(text).toContain(`pinned to the workspace "Acme" (${A})`);
    expect(text).toContain(`the --workspace flag selects "Atelier Nord" (${B})`);
  });

  it('401 on a workspace that is not yours says the key works, lists yours, and offers --clear for a profile', () => {
    const text = explainRefusal({
      code: 'invalid_api_key',
      status: 401,
      selection: { value: C, source: 'profile', profileName: 'work' },
      workspaceId: C,
      me,
      baseUrl: URL
    });
    expect(text).toContain(`The workspace "${C}" (selected by profile "work") is not one of yours on ${URL}`);
    expect(text).toContain('the API key itself works');
    expect(text).toContain(`${B}  member  Atelier Nord`);
    expect(text).toContain(`${bin} workspace use --clear`);
  });

  it('the --clear advice is for a profile selection only', () => {
    const text = explainRefusal({
      code: 'invalid_api_key',
      status: 401,
      selection: { value: C, source: 'env' },
      workspaceId: C,
      me,
      baseUrl: URL
    });
    expect(text).not.toContain('--clear');
  });

  it('401 on a workspace that IS yours is not explained away: the plain error stands', () => {
    expect(
      explainRefusal({
        code: 'invalid_api_key',
        status: 401,
        selection: { value: B, source: 'flag' },
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
        selection: { value: B, source: 'flag' },
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
        selection: { value: C, source: 'flag' },
        workspaceId: C,
        me,
        baseUrl: URL
      })
    ).toBeNull();
  });
});
