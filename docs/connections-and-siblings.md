# Connections and siblings

A **sibling** is another tool of the same Antasphere hub: a scheduling tool and a recruiting tool on
one hub are siblings. The chassis gives a tool two ways to work with a sibling, and they are independent:

| You want to                                   | Declare                                                  | Then                                                        |
| --------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| **receive** the sibling's events              | a connection source with `sibling: { toolSlug, events }` | a person clicks **Connect as me** in Settings › Connections |
| **act** on the sibling for the person (1.10+) | the `siblings` slot: `siblings: [{ toolSlug }]`          | your service calls `core.siblings.call(toolSlug, work)`     |

Both talk to the sibling **as the person**, never as your tool: the hub turns the person's own grant
on your tool into a two-minute token for the sibling, the sibling mints a key of that person, the
work runs with it, and the key is revoked before the call returns. No service key exists anywhere on
the path, so a sibling never does for your tool what the person could not do there themself.

## Receiving a sibling's events: the connection source

The connections slot (`connections.sources`) declares every inbound webhook source and every key your
tool holds. A source that comes from a sibling adds `sibling`:

```ts
connections: {
  sources: [
    {
      key: 'calendar',
      name: 'Calendar',
      kind: 'inbound',
      events: ['booking.created'],
      sibling: { toolSlug: 'calendar', events: ['booking.created'] },
      handler: async ({ workspaceId, delivery }) => {
        /* what a booking means to your tool */
      }
    }
  ];
}
```

The card of that source carries **Connect as me**: the chassis registers your receiving URL on the
sibling, in the workspace of the same organization, and stores the signing secret, so nobody copies
anything. The operator's side of it (the card, the door, disconnecting) is in the tool template's
`docs/concepts/connections.md`.

## Acting on a sibling: the sibling call

### 1. Declare the sibling

```ts
export const tool: ToolDefinition<Env, Domain> = {
  // …
  siblings: [{ toolSlug: 'calendar' }]
};
```

`toolSlug` is the sibling's slug in the hub's registry (lowercase letters, digits and dashes). A slug
declared twice or malformed stops the boot. A call to any slug that is not declared is refused before
the hub, the fleet list or the database is read.

Declaring a sibling makes the sign-in ask the hub for the `sso:connect` scope. A person who signed in
before your tool shipped the declaration holds a grant without it, and their calls answer
`sibling_scope_missing` until they sign out and in again, once.

### 2. Call it from a service

`core.siblings` reaches your `services` slot beside `core.connections`:

```ts
services: (core) => ({
  bookingLinks: {
    /** Create a booking link on the calendar tool for the person using yours, and answer its address. */
    create: (title: string) =>
      core.siblings.call('calendar', async (calendar): Promise<SiblingOutcome<{ url: string }>> => {
        const made = await calendar.request('POST', '/links', { body: { title } });
        if (made.kind !== 'ok') return made;
        const { link } = made.value.body as { link: { url: string } };
        return { kind: 'ok', value: { url: link.url } };
      })
  }
});
```

```ts
call<T>(toolSlug: string, work: (sibling: SiblingHandle) => Promise<SiblingOutcome<T>>): Promise<SiblingCallOutcome<T>>
```

The work receives a handle:

| Member                             | What it is                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `tool`                             | `{ slug, name }`: the sibling as the hub lists it                               |
| `workspaceId`                      | the sibling's workspace of the same hub organization as the request's workspace |
| `request(method, path, { body }?)` | one request on the sibling's API, as the person, in that workspace              |

`method` is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. `path` is relative to the sibling's `/api/v1`
(`/links`, `/links/abc?view=full`). A request answers:

| Answer                                               | When                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `{ kind: 'ok', value: { status, body } }`            | the sibling answered 2xx; `body` is its JSON, `null` when it sent none (a 204)    |
| `{ kind: 'sibling_refused', message, status, code }` | the sibling answered 4xx; `code` is its error code (`slug_taken`, `forbidden`, …) |
| `{ kind: 'unavailable', message }`                   | a 5xx, no answer, an answer that is not JSON, the budget spent, the call over     |

The work returns its own outcome: an `ok` with its value, or any refusal it got from a request.
TypeScript cannot infer `T` from a work that returns both, so annotate the work's return type as above.

### 3. Who acts: always the person of the request

There is no user parameter. The call acts as the person of the request your code is serving, whatever
credential they came with: a **session** (the console), an **API key** (the CLI, a script), an
**OAuth bearer** (an MCP client; an MCP tool reaches your routes through your own API, so it is the
same request). The sibling sees that person with their own role and rights there, and nothing more.

Code that runs outside a person's request (a job, a timer, a webhook handler, a public route) has
nobody to act as: the call answers `no_person`. The chassis never acts on a sibling as your tool.

The key the sibling minted is revoked in a `finally` on every path: an answer, a refusal, a work past
the budget, a work that throws. Your code never sees it, and the handle answers `unavailable` to any
request made after the call returned, so keeping the handle buys nothing.

The key carries the person's full rights on the sibling, whatever narrower scope the credential that
reached your tool had. Put a call that changes something behind one of your write routes.

### 4. Every answer of the call

The call never throws for a refusal. Each answer, and what to tell the person:

| `kind`                      | When                                                                                                         | What the person does                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `ok`                        | the work's own value                                                                                         |                                                        |
| `sibling_not_declared`      | the slug is not in your `siblings` slot (a mistake in your code)                                             | nothing; fix the declaration                           |
| `not_on_hub`                | this instance is not on a hub: a local stack, password accounts (see below)                                  | nothing; the sibling act does not exist here           |
| `no_person`                 | the call runs outside a person's request                                                                     | nothing; move the call into a route                    |
| `hub_reauth_required`       | the person's grant on your tool is gone or dead                                                              | sign in again                                          |
| `sibling_scope_missing`     | the person's grant predates your tool asking for `sso:connect`                                               | sign out, sign in again                                |
| `sibling_unknown`           | the hub lists no tool of that slug, or no tool at its address                                                | nothing; the sibling is not on this hub                |
| `sibling_access_denied`     | the hub does not let this person into the sibling                                                            | ask an admin of the hub for access                     |
| `sibling_grant_missing`     | the sibling does not know the person yet                                                                     | open the sibling once, then retry                      |
| `sibling_workspace_missing` | the request's workspace is local (no hub organization), or the sibling has no workspace of that organization | open the sibling in that organization once, then retry |
| `sibling_refused`           | the hub or the sibling refused for a reason of its own; `message` is theirs                                  | depends on the message                                 |
| `unavailable`               | the hub or the sibling did not answer, answered 5xx, or the call ran past its budget                         | try again in a moment                                  |

A route usually answers `ok` with its value, maps `hub_reauth_required` to 401, the five the person
can fix (`sibling_scope_missing`, `sibling_access_denied`, `sibling_grant_missing`,
`sibling_workspace_missing`, `sibling_refused`) to a 4xx carrying the sentence above, `unavailable`
to 502, and the three that are about your code or your instance (`sibling_not_declared`,
`not_on_hub`, `no_person`) to what your screen shows when the feature is off.

What is thrown is a bug: a `path` that would leave the sibling's `/api/v1` (`//host`, a `..` segment,
an absolute URL) or a method outside the five throws a `TypeError`, and an error your work throws is
rethrown, each once the key is revoked.

### 5. The budget

The whole call, the work included, has 60 seconds (`DEFAULT_SIBLING_OVERALL_MS`), and each request
the instance's hub timeout (5 seconds by default). Past the budget the call answers `unavailable` and
revokes the key even if the work has not finished; whatever the work does afterwards reaches nobody.
A call is one deliberate act of a person, a few requests long: do not loop over a list inside one.

### 6. A local stack, with no hub

A tool run locally with password accounts (`EDITION=oss`, no `HUB_ISSUER_URL`) has no hub, so no
sibling: every call answers `not_on_hub` (after `sibling_not_declared`, which is checked first), and
nothing is thrown. Read it to hide or explain the feature on that instance; the rest of your screens
work as they do.

### 7. Testing your call

The chassis's own suites prove the call end to end: `test/unit/sibling-call.test.ts` with the hub and
the sibling played by an injected fetch, and `test/integration/sibling-call.test.ts` with the fake hub
(`FakeHub` from `@antasphere/chassis-server/testing`) and two instances of a tool on real ports, one
calling the other. The integration suite skips under a real tool's host (`host.siblings` unset). To
prove your own call the same way, boot your tool twice against the fake hub, list both with
`hub.setTools`, sign the person in on both, and drive your route.
