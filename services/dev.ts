// Starts the marketplace control API and shared payment service.
import { start as startCardanoAgent } from "./cardano-agent"
import { startMarketplace } from "./control-api"
import {loadPaymentConfig} from './cardano-agents-ts/config'

const CONTROL_API_PORT = Number(process.env.CONTROL_API_PORT ?? 8787)
const CARDANO_AGENT_PORT = Number(process.env.CARDANO_AGENT_PORT ?? 8788)
startMarketplace(CONTROL_API_PORT)
const paymentConfig = loadPaymentConfig()
startCardanoAgent(CARDANO_AGENT_PORT, {config: paymentConfig})

console.log(`control-api     http://localhost:${CONTROL_API_PORT}`)
console.log(`cardano-agent   http://localhost:${CARDANO_AGENT_PORT}  (${paymentConfig.mode}, API access ${paymentConfig.allowNetwork ? 'enabled' : 'disabled'})`)
