# Contributing to opencode-engram

This plugin runs inside opencode as a long-lived hook + tool provider. Authoring rules are stricter than for an ordinary npm package because mistakes can crash opencode itself, not just engram.

## Setup

```bash
bun install
bun run check    # lint + typecheck + tests
```

`bun run check` runs three things:

1. `lint:no-zod` — fails if any plugin boundary file imports `z` from `zod` directly.
2. `typecheck` — `tsgo --noEmit`.
3. `bun test` with a 30s timeout.

## Authoring rules

### Use `tool.schema`, not `import { z } from "zod"`

In any file that exports a `Plugin` factory or registers a `tool({...})`, use `tool.schema` instead of importing `z` from `zod`:

```ts
// GOOD
import { tool } from "@opencode-ai/plugin/tool";
const z = tool.schema;

const myTool = tool({
  description: "...",
  args: { foo: z.string(), count: z.number().optional() },
  async execute(args) { /* ... */ },
});
```

```ts
// BAD — separate zod instance with potentially-different brand symbols
import { z } from "zod";
```

`bun run lint:no-zod` enforces this. Internal-only zod usage (config schemas, eval fixtures) is fine — those schemas never cross the opencode tool boundary.

### Tool args must be a `ZodRawShape` literal, not a `ZodObject`

```ts
// GOOD
args: { foo: z.string(), count: z.number().optional() }
```

```ts
// BAD — opencode iterates Object.keys(args) and dereferences method.._zod.def → TypeError
args: z.object({ foo: z.string(), count: z.number().optional() })
```

The `@mazac-fox/opencode-host-adapter` wrapper rejects ZodObject args at registration with a clear error message. The contract test (`bun test test/plugin-contract.test.ts`) exercises this.

### Wrap the default export with `wrapPlugin`

```ts
import { wrapPlugin } from "@mazac-fox/opencode-host-adapter";

export default wrapPlugin(EngramPlugin, { name: "engram" });
```

The wrapper:

- Validates every tool definition before opencode sees it.
- Wraps tool `execute` in try/catch so a single tool failure doesn't crash opencode's Effect pipeline.
- Filters bad entries from `experimental.chat.system.transform` outputs.
- Emits per-plugin and per-tool telemetry to `~/.local/share/opencode/log/plugin-lifecycle.jsonl`.

### Never re-export internal helpers from the plugin entry file

opencode's plugin loader probes named exports as potential plugin entry points. Any function-typed named export with a 1–2 argument signature can be invoked at load time with empty/undefined arguments. Only export `default` (the wrapped plugin); keep internal helpers as unexported functions or in separate files.

### Telemetry must never break a plugin hook

The host adapter's telemetry sink swallows write failures silently. If you add new telemetry, follow the same pattern.

## Versioning

This plugin tracks `@opencode-ai/plugin` version via a sentinel file `.opencode-plugin-version`. Bump it when you upgrade the dependency. The opencode preflight script warns on drift.

## Releases

```bash
bun run check                  # all quality gates
bun run sprint                 # eval refresh (optional)
git tag -a vX.Y.Z -m "..."     # tag the release
npm publish                    # publish to npm (after sentinel + lockfile committed)
```

## Debugging

If opencode launches but engram tools misbehave:

1. Check the lifecycle dashboard: `bun run ./src/cli/run.ts dashboard --plugins`
2. Run preflight: `bun run ~/.config/opencode/scripts/preflight.ts`
3. Audit zod versions: `bun run /Users/jack.mazac/Developer/opencode-host-adapter/src/cli/audit-zod.ts ./node_modules`
4. See `~/.config/opencode/runbooks/plugin-broken.md` for the full procedure.
