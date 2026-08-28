# Wiki source

These Markdown files are the **source of truth for the GitHub Wiki**. They live
in the repo (so they're versioned and reviewed with the code) and are mirrored to
the Wiki tab.

## Publish / update the wiki

**One-time setup:** on github.com → the repo → **Settings → Features → enable
"Wikis"**, then open the **Wiki** tab and create the first page (any content, e.g.
paste `Home.md`). That initializes `github.com/schady4/quorum.wiki.git` so it can
be pushed to.

**Every time after that**, from the repo root:

```bash
bash docs/wiki/publish.sh
```

That clones the wiki, copies every page here into it, and pushes — the whole wiki
in one command. (This `README.md` is skipped; it isn't a wiki page.)

## Pages

| File | Wiki page |
|---|---|
| `Home.md` | Home (landing) |
| `_Sidebar.md` | the wiki's left nav |
| `Getting-Started.md` | Getting Started |
| `CLI-Reference.md` | CLI Reference |
| `Using-a-Room.md` | Using a Room |
| `Hosting-and-Sharing.md` | Hosting & Sharing |
| `Build-on-the-Bus.md` | Build on the Bus (SDK) |
| `Saving-and-Reviving.md` | Saving & Reviving |
| `Providers.md` | Providers |
| `Publishing.md` | Publishing to npm |

GitHub maps a page's file name to its URL, replacing spaces with hyphens — so
`CLI-Reference.md` → `…/wiki/CLI-Reference`, which is exactly how the links between
pages (and from the main README) are written.
