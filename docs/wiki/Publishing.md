# Publishing to npm

Maintainer guide for cutting a release of **`@schady4/quorum`** to the npm
registry. The package is public and scoped (`quorum` was taken), and ships the
built `dist/` plus `README`, `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`,
`PROTOCOL.md`, and `SAVE-FORMAT.md` (see the `files` array in `package.json`).

## Before you start

```bash
cd quorum                 # your SDK checkout
npm whoami                # prints your npm user; if not logged in: npm login
git status                # commit or stash anything uncommitted first
npm config get registry   # should be https://registry.npmjs.org/
```

You must have publish rights on the `@schady4` scope.

## Heads-up: keep the version ahead of what's on npm

npm versions are **immutable** — you can never republish or overwrite an
existing version, and the npm page always shows the **latest** version by
default. Check what's already published and make sure your new version is higher:

```bash
npm view @schady4/quorum version   # the current latest on npm
```

If your local `main` is behind what's on npm (e.g. a version was published from
another machine and not pushed to GitHub), reconcile first — pull your newest
history down, or apply the change you're releasing onto it — so you're bumping
from the real latest, not a stale number.

## Cut the release

```bash
# 1. bump the version (must be > the current npm latest)
npm version patch        # x.y.Z+1   (npm version minor / major for bigger jumps)

# 2. build — dist/ is what actually ships
npm run build

# 3. preview the tarball contents before you push anything
npm pack --dry-run       # confirm dist, README, LICENSE, NOTICE, notices, PROTOCOL, SAVE-FORMAT

# 4. publish (public scope is set in publishConfig, so no extra flags needed)
npm publish
```

## Verify

```bash
npm view @schady4/quorum version   # your new version
npm view @schady4/quorum license   # Apache-2.0
```

Open the npm page and confirm the sidebar license and the rendered README look
right. Older versions keep their old pages (immutability) — only the latest view
changes.

## Push the tag and cut a GitHub Release

`npm version` created a commit **and** a git tag locally. Get them onto GitHub so
the repo matches npm:

```bash
git push && git push --tags
```

Then draft a GitHub Release against the new tag (Releases → *Draft a new
release* → pick the tag) and paste the release notes.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `403 Forbidden` on publish | Not logged in, or no rights to the `@schady4` scope — `npm login`, confirm `npm whoami`. |
| `You cannot publish over the previously published version` | Your version isn't above the npm latest — re-run `npm version patch`. |
| Publish goes to the wrong registry | `npm config get registry` should be `https://registry.npmjs.org/`; check `.npmrc`. |
| `dist/` missing from the tarball | Run `npm run build` before `npm publish` (or rely on the `prepublishOnly` script if configured). |
