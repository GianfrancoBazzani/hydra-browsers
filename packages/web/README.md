# @hydra/web

The Hydra Browsers dashboard: Vite, React 19, React Router, TanStack Query, Tailwind CSS v4, Radix
primitives, and Tabler icons. `STYLE.md` at the repository root defines the tokens and the
components. Read it before you change this package (`AGENTS.md` rule 3).

The visual style comes from [macos-react](https://github.com/ridvanonal/macos-react) by Rıdvan
Önal. This package uses its design values and has its own components. No code is copied (spec
section 10.1).

## Commands

- `pnpm --filter @hydra/web dev`: the Vite dev server on `http://hydra.localhost:5173`.
- `pnpm --filter @hydra/web build`: the production build in `packages/web/dist`. The gateway serves
  it with the headers of spec section 6.8. The build has no inline scripts.
- `pnpm --filter @hydra/web test`: the tests (Vitest, jsdom, Testing Library).
- `pnpm --filter @hydra/web typecheck`: `tsc -p tsconfig.json`.

## Development URLs

Spec sections 4 and 11.7 give the development URLs. Browsers treat `*.localhost` as a secure
context, so the `Secure` and `__Host-` cookies work over HTTP. Ports do not change the site, so the
two origins are one site. The Vite dev server and the gateway listen on different ports:

- Dashboard: `http://hydra.localhost:5173` (Vite). Vite sends `/api/*` and `/s/<sid>/mcp` to the
  gateway on `127.0.0.1:8080`. It keeps the `Host` and the `Origin` header of the browser, so the
  host routing and the CSRF check of the gateway see the dashboard origin.
- Live view: `http://live.hydra.localhost:8080` (the gateway). The live iframe loads it directly.

`pnpm dev` at the repository root starts the gateway on the host with these values (spec section
11.7):

```sh
HYDRA_PUBLIC_URL=http://hydra.localhost:5173
HYDRA_LIVE_URL=http://live.hydra.localhost:8080
```

Use Chrome or Firefox. They resolve `*.localhost` to the loopback address. An MCP client on the host
(Node.js) can resolve `hydra.localhost` to `::1`, but Vite listens on `127.0.0.1` only. Add
`127.0.0.1 hydra.localhost` to `/etc/hosts` if the client cannot connect to the MCP URL of the token
sheet.
