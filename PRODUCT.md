# Tally

Tally helps buyers and sellers agree on evidence for business deals.
Its marketplace uses contracts, Masumi escrow, and separate reliability records.
The public demo uses paper contracts on Cardano preprod with test USDM.
Role views are lenses. They do not provide access control.

The payment evidence checker is a read-only demo feature.
Users load a Masumi receipt or enter a hash, recipient, and expected amount.
The result compares live preprod data through a Chainlink CRE simulation.
Users need only the UI. They do not need a CLI, API key, wallet, or signature.
The checker does not change a contract or reliability score.

The checker extends the existing Tally interface.
It uses the existing fonts, colors, inputs, buttons, and status tags.
It adds no visual theme.

Read [PLAN.md](PLAN.md) for the product scope.
Read [Chainlink payment evidence](docs/chainlink-evidence.md) for the feature limits.
