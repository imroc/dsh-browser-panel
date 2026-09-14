# Releasing

Every release ships three things that must agree with each other: a **git tag**, a **GitHub release**, and an **npm version** — all pointing at the same code. There is no CI here, so the steps below *are* the pipeline.

## 0. Pre-flight

```sh
git status --short                 # must be clean
node test/smoke.mjs                # 43 checks, drives a real Chrome, no DSH needed
node --check lib/client.js         # the client half has no build step
```

- Bump `version` in `package.json`. Semver: while the plugin is `0.x`, a behaviour-level break is a **minor** bump (that is what `0.2.0` was) and a fix is a patch.
- `README.md` / `README.zh.md` must describe the behaviour being released, and both must stay faithful translations of each other. Anything in the docs that names a version number changes in the same commit — a stale version in the README is the most common release defect.
- `references/PITFALLS.md` gets any new mechanism learned while building the release; a claim that measurement contradicts is corrected *before* the tag, not after.

## 1. Commit and push

```sh
git add <only the files this release touches>
git commit -m "feat!: …"           # or fix: / docs:
git push origin main
```

## 2. Tag and release

Annotated tag on the release commit, then a GitHub release whose notes are the user-facing changelog:

```sh
git tag -a vX.Y.Z -m "X.Y.Z — <one line>"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "X.Y.Z — <one line>" --notes-file /tmp/relnotes-X.Y.Z.md --latest
```

The notes say, in this order: **what breaks** (if anything), **what changed and why**, **what an upgrading user must do**, and **how the release was verified**. Link or name the evidence — never claim verification that was not run. `gh release create --latest` keeps the newest release marked as such; there is no changelog file in this repository, so release notes *are* the changelog.

## 3. Publish to npm

```sh
npm pack --dry-run                 # inspect the exact tarball
npm publish                        # account imrocchan, unscoped, default access
```

- `files` in `package.json` is the allow-list and the single source of truth: `lib/`, `cordis.patch.yml`, the two READMEs and `LICENSE`. `references/`, `AGENTS.md` and `test/` stay out of the tarball on purpose.
- The registry takes roughly 40 s to serve a fresh version, and `npm view` can lag well beyond that. When in doubt, ask the registry API directly rather than trusting one `npm view`:

  ```sh
  curl -s https://registry.npmjs.org/dsh-browser-panel | \
    python3 -c "import sys,json;d=json.load(sys.stdin);print(d['dist-tags'],sorted(d['versions']))"
  ```

## 4. Verify the published artifact

The point is to prove the tarball is the code that was tested — not that the command exited 0:

```sh
mkdir -p /tmp/npm-verify && cd /tmp/npm-verify
npm pack dsh-browser-panel@X.Y.Z && tar xzf dsh-browser-panel-X.Y.Z.tgz
grep -c "<a marker only this release has>" package/lib/client.js   # expect > 0
grep -c "<a marker the previous release had>" package/lib/browser.js  # expect 0
```

## 5. Install-path check

A `link:`-installed host runs the working tree, so it proves nothing about the published package. When a release changes composition (a new bundle row, a renamed export, a new dependency), install the published version into a throwaway `DSH_HOME` and confirm the plugin mounts and its routes answer — **401 means mounted and requiring the Web UI's own authentication, 404 means the route is missing**.

## What this repository deliberately does not have

No CI, no changelog file, no release branches, no `.npmignore`, and no `prepublish` build step (the client half is plain JavaScript by design). If a release is wrong, fix it on `main` and cut the next patch version — **never retag or republish a version**, because npm will not accept the same version twice and nobody can tell which artifact they got.
