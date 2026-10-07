# Preprod server

This folder rebuilds Tally's Cardano preprod server:
the Masumi payment service (MPS), its database, a public HTTPS entry point, and the three Coworker registrations.

Nothing here holds a secret. Secrets stay on the server in `~/tally-secrets` (mode 600) and in the env files that this folder only shows as examples.

## What runs

| Part | Where | Exposure |
| --- | --- | --- |
| MPS at revision `d569a33` | Docker, `compose.yaml` service `mps` | `127.0.0.1:3001` only. Use an SSH tunnel |
| PostgreSQL 16 | Docker, service `postgres` | Docker network only |
| Marketplace control API and payment service | systemd, [`tally-services.service`](tally-services.service) | Ports 8787 and 8788 on all interfaces. **Only the AWS security group blocks them.** Never open these ports |
| Operator UI | systemd, [`tally-ui.service`](tally-ui.service) | `127.0.0.1:8791`, public through Caddy |
| Caddy | systemd, [`Caddyfile`](Caddyfile) | Ports 80 and 443. Serves `/brand/*` and the operator UI at `/` |

The current server: AWS EC2 `t3.medium`, Ubuntu 24.04, region `ap-southeast-2`, Elastic IP `13.210.42.0`, HTTPS address `https://13.210.42.0`.
The hackathon AWS account allows EC2 only in `ap-southeast-2`.

## Rules

- Never print a wallet seed phrase, the encryption key, the admin key, or the Blockfrost key. Not in a terminal, not in a log, not in chat.
- Read a secret with [`tally-set-secret NAME`](tally-set-secret). It reads hidden input and writes `~/tally-secrets/NAME` with mode 600.
- Keep a backup of `mps_encryption_key`. MPS encrypts the wallet seed phrases with it.
- The security group allows SSH from one IP address and HTTPS from anywhere. MPS is never public.
- The instance requires IMDSv2.

## Build

1. Install Docker (the official apt repository), Caddy (the official apt repository), `jq`, and `librsvg2-bin`. Add 4 GB of swap: the MPS build needs more than 4 GB of memory.
2. Build both MPS images at the tested revision:

   ```sh
   git clone https://github.com/masumi-network/masumi-payment-service.git ~/masumi-payment-service
   cd ~/masumi-payment-service && git checkout d569a33
   sudo docker build -t tally/masumi-payment-service:d569a33 .
   sudo docker build --target backend-builder -t tally/mps-builder:d569a33 .
   ```

3. Create the secrets:

   ```sh
   sudo install -m 755 tally-set-secret /usr/local/bin/tally-set-secret
   umask 077; mkdir -p ~/tally-secrets
   for s in mps_encryption_key:32 mps_admin_key:24 postgres_password:24; do
     f=~/tally-secrets/${s%%:*}; [ -s "$f" ] || openssl rand -hex ${s##*:} | tr -d '\n' > "$f"
   done
   tally-set-secret blockfrost_preprod   # checks the key against Blockfrost before it saves
   ```

4. Generate the two wallet seed phrases inside the image. The output goes to a file, never to the screen:

   ```sh
   for w in purchase_wallet_preprod_mnemonic selling_wallet_preprod_mnemonic; do
     [ -s ~/tally-secrets/$w ] || sudo docker run --rm tally/masumi-payment-service:d569a33 node -e \
       "import('@meshsdk/core').then(({MeshWallet})=>process.stdout.write(MeshWallet.brew(false).join(' ')))" > ~/tally-secrets/$w
   done
   ```

5. Write `pg.env`, `mps.env`, and `seed.env` next to `compose.yaml` from the secrets. Follow the `.example` files. Use mode 600.
6. Start the database, then migrate and seed:

   ```sh
   sudo docker compose up -d postgres
   sudo docker compose --profile setup run --rm mps-setup pnpm run prisma:migrate
   sudo docker compose --profile setup run --rm mps-setup pnpm run prisma:seed > ~/tally-secrets/mps-seed.log 2>&1
   shred -u seed.env
   sudo docker compose up -d mps
   curl -s http://127.0.0.1:3001/api/v1/health
   ```

7. Read the wallet addresses (`GET /api/v1/wallet/list`, header `token` = the admin key). Fund both at <https://dispenser.masumi.network>: the purchasing wallet needs tADA and test USDM, the selling wallet needs tADA.
8. Configure Caddy with [`Caddyfile`](Caddyfile). Copy the brand images from [`docs/brand`](../../docs/brand) to `/srv/tally/brand`.

## Operator UI

The public address <https://13.210.42.0> shows the team's operator UI ([`ui/`](../../ui)).
It is read-only. The UI server forwards only GET requests on a fixed list of `/reliability` read routes. It refuses every other method with 405.
There are two exceptions: the Coworker chat (`/coworkers/ask`, read [the Coworker README](../../services/reliability/coworkers/README.md#on-the-tally-website)) and the wallet account routes (read [Wallet accounts](../../docs/wallets.md)).
The Vercel web app calls the chat and the account routes from the browser. `TALLY_WEB_ORIGINS` in [`tally-ui.service`](tally-ui.service) lists the origins that may do this. No other route allows another origin.
After you change the unit, copy it to `/etc/systemd/system`, run `sudo systemctl daemon-reload`, and restart `tally-ui`.
The control API, the demo services, and the payment service are not reachable from the internet.

The services run in paper mode: `CARDANO_MODE` is not set, so escrow is simulated.
The database is `~/tally-app/data/agent.sqlite` (`CONTROL_DB_PATH`). Each release links `services/.data` to `~/tally-app/data`, so data survives deploys.

Deploy a git ref from the repo root:

```sh
deploy/preprod/deploy-app.sh lane-a/coworkers
```

The script copies the ref with `git archive` (the server needs no GitHub access), installs packages, switches `~/tally-app/current`, restarts both services, and checks the public address.
To roll back, point `~/tally-app/current` at an older folder in `~/tally-app/releases` and restart `tally-services` and `tally-ui`.

First setup on a new server: copy the two unit files to `/etc/systemd/system`, run `sudo systemctl daemon-reload`, run the deploy script, then `sudo systemctl enable tally-services tally-ui`.

Seed the demo contracts once, so the UI has deals to show:

```sh
sudo systemctl stop tally-services
cd ~/tally-app/current && CONTROL_DB_PATH=$HOME/tally-app/data/agent.sqlite ~/.bun/bin/bun run contracts:showcase
sudo systemctl start tally-services
```

The seed refuses a store that already has the showcase parties. All showcase contracts are SIMULATED.

## Coworker worker

[`tally-coworkers.service`](tally-coworkers.service) runs the Task worker. Read [the Coworker README](../../services/reliability/coworkers/README.md#the-task-worker).
Its configuration is [`coworkers.json`](coworkers.json): the Coworker ids, the agent identifiers, the selling wallet, and the price per Task. All of it is public.

It needs these secrets in `~/tally-secrets`:

| File | What | How to create it |
| --- | --- | --- |
| `mps_worker_token` | A payment service API key with read and pay permission, Preprod only. Not the admin key | `POST /api/v1/api-key` with the admin key |
| `coworker_deal_desk_key`, `coworker_mediator_key`, `coworker_trust_check_key` | Each Coworker's runtime key (`coworker_...`) | `sokosumi --preprod coworkers api-key <id> --json`, piped into the file. Never print it |
| `gemini_api_key`, `bedrock_api_key`, or `openai_compatible_api_key` | Only for `COWORKER_MODEL_PROVIDER=gemini`, `bedrock`, or `openai-compatible` | `tally-set-secret gemini_api_key` |

`COWORKER_ASK_PORT=8792` in the unit also starts the Coworker chat server for the website, on `127.0.0.1` only. The `tally-ui` server forwards `/coworkers/ask` to it.

Install and start: copy the unit to `/etc/systemd/system`, run `sudo systemctl daemon-reload`, then `sudo systemctl enable --now tally-coworkers`.
Read its log with `journalctl -u tally-coworkers -f`. The journal of each Task is in `~/tally-app/data/coworker-worker`.

## Settlement anchors

[`tally-anchors.service`](tally-anchors.service) fingerprints settled records and, with `ANCHOR_SUBMIT=on`, posts them to Cardano preprod. Read [Settlement anchors](../../docs/settlement-anchors.md).

| File in `~/tally-secrets` | What | How to create it |
| --- | --- | --- |
| `anchor_wallet_skey` | The anchor wallet key. It pays only anchor fees | `bun run anchors:wallet` creates it and prints only the address |
| `blockfrost_preprod` | Already present for the payment service | |

Fund the address with test ADA, check `bun run anchors:status`, then install the unit like the others. It starts with submission off.

## Wallet accounts and deposits

Read [Wallet accounts](../../docs/wallets.md). Sign-in and KYC need no setup. Live deposits need three steps:

1. Read the purchasing wallet address of the payment service (`GET /api/v1/wallet/list`). Deposits go there, so they can fund Masumi escrow.
2. Set `TALLY_DEPOSIT_ADDRESS` to that address in [`tally-services.service`](tally-services.service) and [`tally-deposits.service`](tally-deposits.service). Both read `blockfrost_preprod` from `~/tally-secrets`.
3. Copy both units to `/etc/systemd/system`, run `sudo systemctl daemon-reload`, restart `tally-services`, and run `sudo systemctl enable --now tally-deposits`.

Check with `bun run deposits:status`. Read the log with `journalctl -u tally-deposits -f`.

[`tally-services.service`](tally-services.service) sets `MARKETPLACE_REQUIRE_WALLET=on`: every sale and contract needs a proven wallet.
[`tally-ui.service`](tally-ui.service) lists the web app in `TALLY_WEB_ORIGINS`, so the browser can call the account routes.

## Register the Coworkers

### Masumi registry (on-chain)

[`registry/`](registry) holds the three registration bodies.
`sellingWalletVkey` is the payment key hash of the selling wallet (`walletVkey` in the wallet list).
Change it if you rebuild the wallets.

```sh
curl -s -X POST -H "token: <admin key>" -H "Content-Type: application/json" \
  --data @registry/deal-desk.json http://127.0.0.1:3001/api/v1/registry/
```

The state goes from `RegistrationRequested` to `RegistrationConfirmed`.
The three current registrations confirmed in transaction `e72ca0405c431f9f02db1dbf5743557344f0e0a11dc65678580aafb4073b2352`.

### Sokosumi (preprod)

```sh
sokosumi --preprod vendors create --name "Tally" --slug tally
sokosumi --preprod coworkers provision --vendor-id <vendor id> --name "Tally Deal Desk" \
  --caption "..." --description "..." --capability tasks
sokosumi --preprod coworkers connect <coworker id> --vendor-id <vendor id> --workspace-id <organization id>
```

- `connect` answers `PENDING` until a workspace owner or admin approves. Run it again after approval.
- Sokosumi rejects `--image`, `--company`, and `--company-logo` through the API. Set the images in the web app.
- On Windows, `sokosumi auth login` in CLI 1.0.4 opens a broken sign-in link: `cmd /c start` cuts the URL at the first `&`.
  Log in with a user API key (`auth login --api-key-stdin`), or open the sign-in URL without `cmd`.

Current ids are in [the Coworker README](../../services/reliability/coworkers/README.md#preprod-registrations).

## Operate

| Task | Command |
| --- | --- |
| Dashboard | `ssh -i <key> -L 3001:127.0.0.1:3001 ubuntu@13.210.42.0`, then open <http://localhost:3001/admin> |
| Service state | `sudo docker compose ps` |
| Logs | `sudo docker compose logs mps --since 15m`, `journalctl -u tally-services -u tally-ui --since -15min` |
| Restart | `sudo docker compose restart mps` |
| Wallet balances | Blockfrost `GET /addresses/<address>` with the preprod key |

## App edition server

The app edition uses the same release code as the demo.
It runs separate processes and separate SQLite files.
Read [Two Amplify editions](../../docs/amplify.md) for both website setups.

| Part | Unit | Port or database |
| --- | --- | --- |
| App control API and payment service | `tally-app-services.service` | 8797 and 8799; `app-data/agent.sqlite` and `app-data/cardano.sqlite` |
| App UI gate | `tally-app-ui.service` | `127.0.0.1:8798` |
| App contract worker | `tally-app-contracts.service` | `app-data/agent.sqlite` |
| App deposit worker | `tally-app-deposits.service` | `app-data/agent.sqlite` |

1. Deploy the reviewed release with `deploy-app.sh`.
2. Create `/home/ubuntu/tally-app/app-data` for the app databases.
3. Copy `app.env.example` to `/home/ubuntu/tally-app/app.env` on the server.
4. Set its file mode to 600.
5. Replace the public placeholders with App B's domain, its deposit address, its agent identifier, and the mediator public key.
6. Set `MASUMI_BUYER_API_KEY` and `MASUMI_SELLER_API_KEY` privately in that env file.
7. Set `BLOCKFROST_PROJECT_ID_PREPROD` privately for the payment client.
8. Put the deposit worker's `blockfrost_preprod` secret in `/home/ubuntu/tally-app-secrets`.
9. Use a dedicated app purchasing wallet and app API keys in the preprod payment service.
10. Fund the app payment wallets with preprod test ADA and test USDM.
11. Copy the four `tally-app-*.service` files to `/etc/systemd/system`.
12. Run `sudo systemctl daemon-reload`.
13. Run `sudo systemctl enable --now tally-app-services tally-app-ui tally-app-contracts tally-app-deposits`.
14. Add the `/app-api/*` handler from `Caddyfile` to the server's HTTPS site.
15. Validate the Caddy config.
16. Reload Caddy.

Do not run `contracts:showcase` against the app database.
Do not copy the demo SQLite file to `app-data`.
Keep the app deposit pool separate from the demo pool.
Both workers must use the same app pool address and confirmation setting.
Keep ports 8797, 8798, and 8799 closed in the AWS security group.
Only Caddy exposes the app gate at `https://13.210.42.0/app-api`.
The demo units keep their ports and database.
The Elastic IP uses a short-lived public certificate from Let's Encrypt.
Caddy 2.11.7 renews that certificate automatically.
Keep port 443 open for the TLS certificate challenge.
The demo UI unit now includes App A's Amplify origin in `TALLY_WEB_ORIGINS`.
The app gateway uses the existing public Coworker preview on 8792.
That worker keeps the demo database. Do not give it the private app database.

`TALLY_EDITION=app` limits public reads and enables the signed-in deal proxy.
`MARKETPLACE_REQUIRE_WALLET=on` requires proven wallets.
`CARDANO_MODE=preprod` and `CARDANO_ALLOW_NETWORK=true` enable live preprod escrow.
Each app action uses server time.
The contract worker processes funding, confirmations, deadlines, and settlement.
For a local paper check, set the two Cardano gates to `simulated` and `false` in the env file.
Keep the contract worker running in paper mode so deadlines progress without traffic.

After each code release, restart the four app units too.
`deploy-app.sh` restarts only the existing demo units.
To roll back, select the earlier release and restart both sets of units.
Keep both sets of data directories.

The browser account key stays with the user.
The payment service uses platform test wallets for escrow.
Read [Wallet accounts](../../docs/wallets.md) and [Contract lifecycle](../../docs/contract-lifecycle.md) before a live preprod run.
Actual test USDM settlement verification still needs a live end-to-end run.
No mainnet mode is supported.
