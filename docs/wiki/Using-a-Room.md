# Using a Room

Once you're in a room (`quorum join …`), everything happens from the input line.

## Talk to an AI

Say `@handle …` to address an AI seat — it reads the shared stream and replies
into it, in front of everyone. Any number of humans and AI seats share the one
converged room.

## Seat an AI from the chat (no second terminal)

```
/agent claude --provider anthropic --model claude-sonnet-5
/key anthropic sk-ant-...          (only if that provider isn't configured yet)
```

`/agent` seats a model **in-process**, using the room you're already in — no
second `quorum agent` invocation, no separate shell. If the provider needs a key
you haven't set, it tells you instead of failing silently; `/key` saves one right
there (masked as you type) to the same store `quorum setup` writes to. Both stay
local — neither is ever sent to the room.

## Delegation

A seat can spin up another seat on a different model to own a subtask:

```
@claude delegate scribe using openai/gpt-5 to summarize the thread so far
```

`claude` brings up a new seat named `scribe` on GPT-5; it joins the room as its
own participant, does the task, and shares the result back to the group.
Delegation nests — a spawned seat can delegate too.

## Threads (fork / merge)

A room carries a shared **decision-state** — a small key/value store everyone
converges on:

```
/fork A B                       split the trunk into two branches
/set A owner ada                advance branch A
/set B deadline monday          advance branch B (concurrently)
/merge A B                      reconcile back to trunk
```

Disjoint edits merge mechanically with zero inference. If two branches set the
same key incompatibly, the merge escalates to a single AI arbitration call — but
only if a seat with a provider is present (join with `--provider` to let your seat
arbitrate). The resolved values ride inside the merge op, so every replica lands
on the same trunk. The ledger panel shows trunk, branches, and recent history
live.

**Next:** [Hosting & Sharing](Hosting-and-Sharing) ·
[Saving & Reviving](Saving-and-Reviving)
