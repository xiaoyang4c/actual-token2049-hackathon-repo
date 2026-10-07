import type {PaymentReport} from './payment';

export const EVIDENCE_EXECUTION = {
  engine: 'chainlink-cre', mode: 'simulation', workflow: 'tally-payment-evidence',
  sdkVersion: '1.22.0', donConsensus: false,
} as const;

export const EVIDENCE_EXAMPLE = {
  txHash: '1b0cdc319bd4c4799cc2e2713156d3cf8cf97327761a862dd7fa72008927ad52',
  recipient: 'addr_test1qzt8grww0fvwn8j6e95ayeedfr706dg0pxhltrpmpxpnj6n6vv2u6sgysk32l3f0zj4cuj2crvh8773m8t4upsw0thfs36sckq',
  amount: '1',
};

export interface EvidenceResult {
  report: PaymentReport;
  execution: typeof EVIDENCE_EXECUTION;
  source: 'Blockfrost';
  checkedAt: string;
  reportHash: string;
  explorerUrl: string;
}

export interface EvidenceInfo {
  available: boolean;
  execution: typeof EVIDENCE_EXECUTION;
  network: 'preprod';
  asset: 'test USDM';
  minimumConfirmations: number;
  example: typeof EVIDENCE_EXAMPLE;
}
