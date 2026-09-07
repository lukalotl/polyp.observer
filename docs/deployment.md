# polyp.observer deployment

Vercel serves the browser build at **https://polyp.observer**, with the existing
alias **https://popyl-observer.vercel.app**. Research uses a persistent Linux
service in the Polyp workspace; it cannot run as a static Vercel deployment.

`vercel.json` sends `/api/*` to the production service at
`https://4180-5cwdx5.soft-machine.io`. API responses are not cached. Set
`VITE_RESEARCH_WS_ORIGIN` to that same HTTPS origin in Vercel's build environment
so live WebSockets connect directly to the VM. HTTP requests and downloads stay
on the website's `/api/*` routes. Leaving the variable unset preserves the
normal same-origin workspace development setup.

The production service uses a separate checkout and run directory, so edits and
experiments in the development checkout do not become public automatically.
It is limited to one active run, six evaluation workers and seven training
threads. The website is a shared research workbench: its visitors share the
production registry and controls. Development checkpoints are not copied into
the production datastore.

## Backend startup

After `npm ci && npm run build` in the production checkout:

```sh
PUBLIC_ORIGIN=https://popyl-observer.vercel.app \
PUBLIC_ORIGINS=https://polyp-observer-git-deploy-vercel-lukalots-projects.vercel.app,https://polyp.observer \
POLYP_RUNS_DIR=.polyp/production \
POLYP_MAX_ACTIVE_RUNS=1 POLYP_MAX_EVALUATION_WORKERS=6 POLYP_CPU_BUDGET=7 \
npm start -- --host 0.0.0.0 --port 4180 --strictPort
```

The six-worker limit is a ceiling; each run chooses its CPU worker count in
the run creator. The seventh training thread coordinates evaluation, with one
CPU reserved for previews on this eight-CPU VM. Existing run configurations keep
their worker count; use Fork to create a run with a different count.

`PUBLIC_ORIGIN` and comma-separated `PUBLIC_ORIGINS` accept exact origins for
both mutations and WebSocket upgrades. No wildcard preview domains are allowed.
They are origin checks, not login authentication.

Keep this workspace running for research availability. Its forwarded HTTPS
address wakes a sleeping machine, but a machine reboot still requires starting
the backend process again. Checkpoints recover on service restart. Never run a
second process against the same data directory.

## Release

Build and test `main`, update the production checkout/backend to that commit,
then push to GitHub. Vercel deploys `main` automatically. The Vercel project is
`polyp-observer` under `lukalots-projects`.
Keep the backend origin, Vercel API rewrite and WebSocket environment variable
in sync if the VM changes. Restart the backend gracefully when updating its
version, then verify health, live subscriptions and a disposable run before
promoting the website. The stable preview alias above is allowed for these
checks; arbitrary deployment URLs are not.

The production checkout for this release is `/workspace/polyp-vercel`, with
research files in `.polyp/production/`. Do not remove that checkout while the
website depends on it.
