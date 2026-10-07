# Chainlink payment evidence

Open `/evidence` in the Tally UI. Select **Load Masumi receipt**. Select **Check receipt**.
The example is a live Cardano preprod transaction for 1 test USDM.
Users do not need the CRE CLI, a wallet, or a Blockfrost key.

The checker runs `cre/evidence-checker` with the official Chainlink CRE simulator.
The workflow reads Blockfrost with the CRE HTTP capability.
It checks the transaction hash, script validity, recipient, net amount, and confirmations.
The amount must match exactly. The transaction must have at least three confirmations.
Reference inputs and collateral do not count as payment inputs or outputs.

The UI labels the result **Chainlink CRE simulation** and **Live preprod evidence**.
Simulation uses one node. It does not produce a DON signature.
The report fingerprint is a SHA-256 digest, not an oracle signature.
The checker trusts Blockfrost as its source. It does not verify a delivery or a contract obligation.
It does not change a contract, reliability score, or payment.
The marketplace showcase contracts remain paper contracts.

See the [Chainlink simulation guide](https://docs.chain.link/cre/guides/operations/simulating-workflows).

## Local use

Install the [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation).
Sign in with `cre login`. Install the workflow packages with `bun install` in `cre/evidence-checker`.
Run `bun run evidence:compile` from the repo root.

Set these server variables. Use absolute paths for each file or directory.

| Variable | Value |
| --- | --- |
| `CHAINLINK_CRE_BINARY` | Path to the CRE executable. |
| `CHAINLINK_EVIDENCE_PROJECT` | Path to `cre/evidence-checker`. |
| `CHAINLINK_EVIDENCE_WASM` | Path to the compiled `main.wasm`. |
| `CHAINLINK_BLOCKFROST_KEY_FILE` | Path to a private file with the preprod key. |
| `CHAINLINK_EVIDENCE_PORT` | Optional port. Default: `8793`. |

The workflow can also read `BLOCKFROST_API_KEY_PREPROD` from the server environment.
Keep all keys on the server. Do not put keys in `VITE_*` variables.
Use an existing CRE login or set `CRE_API_KEY` for non-interactive authentication.

Run `bun run evidence:server`. It binds to `127.0.0.1`.
Run `bun run services` for the paper marketplace reads.
Run `bun run dev` from `web`. Open `http://localhost:5190/evidence`.

## Hosted demo

The EC2 release is staged. Activation waits for CRE authentication.
After activation, the checker uses `https://13-210-42-0.sslip.io/evidence`.
The Caddy config exposes only the two evidence GET routes and the static UI files.
The CRE service stays on loopback. Masumi and PostgreSQL stay private.
The new service does not restart the payment workers or replace the control API.
Its optional environment file is `/home/ubuntu/tally-secrets/chainlink-evidence.env`.
Use [the example file](../deploy/preprod/chainlink-evidence.env.example) for server-only API key settings.
Protect the real file with mode `600`.

The Vercel frontend proxies the same two routes to EC2.
Set `CHAINLINK_EVIDENCE_URL` to change the server-side proxy host.
Set the same `CHAINLINK_EVIDENCE_PROXY_TOKEN` on both servers to preserve per-visitor limits through that proxy.
Without this token, Vercel visitors share the limit for the proxy address.

The demo permits five checks per visitor every ten minutes.
It runs one workflow at a time and at most ten workflows a minute.
It caches a verified report for 60 seconds. Other reports expire after ten seconds.
Provider errors return an unavailable result. They never return a verified result.

Before a DON deployment, add authorized HTTP trigger keys and configure Vault secrets.
Verify signed reports before the application accepts them.
The current simulation target has no authorized keys. Do not deploy this target to a DON.
