# Product walkthrough

Open the [video](tally-product-walkthrough.mp4).
The video runs for 2 minutes and 30 seconds.
It uses 1920 × 1080 video at 30 frames per second, narration, captions, and seven chapters.

The recording shows the [production app](https://main.d35ht8wka9lmbz.amplifyapp.com)
and the [public demo](https://main.d23gra1a9ugqjs.amplifyapp.com).
It covers Highland Estates, Trust Check, Deal Desk, paper settlement, and payment verification.
The structured Trust Check request needs no AI model.

The marketplace deals and settlement are paper.
The paper settlement sends no chain transaction.
The payment checker reads a separate live preprod transaction for 1 test USDM.
The browser check and separate CRE CLI simulation use the same transaction and recipient.
The browser observed 1,735 confirmations.
The CLI observed 1,736 confirmations after another block arrived.

CRE simulation runs on one node without DON consensus or a DON signature.
Read the [Chainlink simulation guide](https://docs.chain.link/cre/guides/operations/simulating-workflows).
The video compares the payment with the [AdaStat preprod explorer](https://preprod.adastat.net/transactions/1b0cdc319bd4c4799cc2e2713156d3cf8cf97327761a862dd7fa72008927ad52).

Supporting files:

- [Captions](tally-product-walkthrough.srt).
- [Payment check reports](payment-check-evidence.json).
- [Actual CRE CLI log](cre-cli.log).
