# Two Amplify editions

Build both websites from this repository with [amplify.yml](../amplify.yml).
Amplify serves `web/dist`.
It does not run `api/demo.ts` or create a SQLite database.
The HTTPS server supplies the API.
Read the [Amplify build guide](https://docs.aws.amazon.com/amplify/latest/userguide/build-settings.html).

## Apps and build variables

Keep the existing Amplify app A for the demo.
Its URL is <https://main.d23gra1a9ugqjs.amplifyapp.com>.
Create a second Amplify app B from `xiaoyang4c/actual-token2049-hackathon-repo`.
Use `app-edition` to preview this PR.
Use `main` for both apps after merge.
Select the repository root as the build root.
Check the repository owner in Amplify.
The existing app was linked to the GiftedNovaHD fork.
That fork does not receive merges from xiaoyang4c automatically.

| App | Build variables |
| --- | --- |
| Demo A | `VITE_TALLY_EDITION=demo`, `VITE_TALLY_SERVER_URL=https://13.210.42.0`, `VITE_COWORKER_ASK_URL=https://13.210.42.0` |
| App B | `VITE_TALLY_EDITION=app`, `VITE_TALLY_SERVER_URL=https://13.210.42.0/app-api`, `VITE_COWORKER_ASK_URL=https://13.210.42.0/app-api` |

An unset edition builds the demo.
Build variables are public.
Store no key or session token in Amplify variables.
App B uses a separate server instance and `app-data/agent.sqlite`.
Do not seed that database with showcase records.

## Rewrites

Set these rules in each app's Amplify console.
Replace `<server>` with that edition's HTTPS server URL.
Keep the proxy rules before the SPA rule.
Read the [Amplify rewrite examples](https://docs.aws.amazon.com/amplify/latest/userguide/redirect-rewrite-examples.html).

| Order | Source | Target | Type |
| --- | --- | --- | --- |
| 1 | `/reliability/<*>` | `<server>/reliability/<*>` | 200 (Rewrite) |
| 2 | `/coworkers/ask` | `<server>/coworkers/ask` | 200 (Rewrite) |
| 3 | `</^[^.]+$|\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>` | `/index.html` | 200 (Rewrite) |

App account and deal requests use `VITE_TALLY_SERVER_URL` directly.
This preserves POST bodies and Bearer tokens at the UI gate.
Public demo reads use the rewrite.
Check a direct refresh of `/deals/new` after deploy.
Check an API query with a contract id.
An unknown API route must return an API error, not the SPA HTML.

## Custom headers

Set custom headers separately in each app's console.
Use the same values as [vercel.json](../vercel.json).
Replace the CSP `connect-src` host with that app's HTTPS server.
Add the chat server if `VITE_COWORKER_ASK_URL` uses another host.
Read the [Amplify header guide](https://docs.aws.amazon.com/amplify/latest/userguide/custom-headers.html).

Paste this YAML in the custom headers editor.
Replace `<server>` before saving.
If the console build uses `applications` with `appRoot: web`, wrap these headers
in `applications`, then `appRoot: web`, then `customHeaders`.
Read the [monorepo header requirements](https://docs.aws.amazon.com/amplify/latest/userguide/monorepo-custom-headers.html).

```yaml
customHeaders:
  - pattern: '**/*'
    headers:
      - key: Content-Security-Policy
        value: "default-src 'self'; script-src 'self' chrome-extension: moz-extension:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' <server>; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
      - key: X-Content-Type-Options
        value: nosniff
      - key: X-Frame-Options
        value: DENY
      - key: Referrer-Policy
        value: strict-origin-when-cross-origin
      - key: Permissions-Policy
        value: 'camera=(), microphone=(), geolocation=(), payment=()'
```

## App server

Follow [the app server steps](../deploy/preprod/README.md#app-edition-server).
The app UI gate listens on 8798.
It forwards session-gated routes to the app control API on 8797.
The contract worker uses the app database.
The deposit worker credits the app database from its own preprod pool.
The AWS IP has a trusted HTTPS certificate.
Caddy renews the certificate and exposes the UI gates.
The app gate uses `/app-api` on the same HTTPS address.
The two gates still use separate processes and databases.
Keep internal ports closed in the AWS security group.
The app keeps the existing public Coworker preview.
That worker reads the demo database and cannot open private app cases.

Set `TALLY_WEB_ORIGINS` to App B's exact HTTPS origin.
Set `TALLY_SIGN_IN_DOMAIN` to App B's hostname, without `https://`.
The web client reads that domain from `/reliability/app/me` for deal key derivation.
Keep the domain stable after users register deal keys.
Changing the domain changes the derived key.

Use Cardano preprod, test USDM, and mock KYC only.
Live means a real preprod transaction with test funds.
Paper means simulated escrow.
Tier 1 two-sided agreement, mutual termination, and inspector templates are not in the app yet.
The Mediation desk remains private.
