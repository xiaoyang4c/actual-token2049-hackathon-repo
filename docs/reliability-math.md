# Reliability checker: math specification

This specification covers the B2B and B2C marketplace.
It describes the target model and proposed commercial rules.
It does not implement them.
The current scoring stub adds one for each success or failure.
It ignores transaction value and verification weight.
Read [Implementation status](implementation-status.md) for the current code.

The Beta model and value weight follow the [scoring contract](../packages/reliability/src/scoring.ts).
The decay curve, evidence-strength display, and commercial curves below are proposals.
The product owner must select and version their parameters before implementation.

## Score scope and notation

Keep one state for each entity, category, and role.
Use separate buyer and seller states.
Goods use the delivery category.
Services use the fulfillment category.
Invoices use the payment category.
A score in one category does not establish reliability in another category.

| Symbol | Meaning | Constraint |
| --- | --- | --- |
| $\alpha,\beta$ | Success and failure parameters | Positive |
| $v_j$ | Verified value of transaction $j$ | Finite, non-negative |
| $v_0$ | Value scale for the category | Finite, positive; same currency as $v_j$ |
| $a_j$ | Evidence eligibility indicator | Zero or one |
| $n_j$ | Earlier eligible transactions for the pair | Non-negative integer |
| $\lambda$ | Pair decay rate | Positive |
| $W_j$ | Effective event weight | Finite, non-negative |
| $r$ | Mean score for display | Between zero and one |
| $L$ | Lower bound for policy decisions | Between zero and one |

Choose one accounting currency for each policy.
Convert values with an identified rate and timestamp before scoring.
Do not compare raw ADA amounts with fiat amounts.
Missing values remain unknown. Do not substitute a unit weight.
Defer the score update until the required value and evidence are available.

## Eligible outcomes

Set $a_j=1$ only when an authenticated verification policy accepts the evidence.
Otherwise, set $a_j=0$.
A supplied method name or confidence number is not verification.
Self-reported ratings carry no weight.
A simulated event belongs to a separate paper score history.
It cannot establish live reliability.

A successful outcome emits success events for the applicable participant roles.
A failed outcome emits a failure event only for the at-fault role.
A failure with no assigned fault emits no score event.
Pending, disputed, cancelled, and unresolved outcomes emit no score event.
Read [event flow](../packages/reliability/src/event-flow.ts) for the role mapping.

Payment evidence must prove the required money movement.
An accepted escrow request does not prove a completed payout or refund.
B2B payment evidence must bind the agreement, due date, and verified settlement time.
B2C evidence must establish delivery or service acceptance under the agreed terms.

## Value weight and pair decay

Use the natural logarithm for the value weight.

$$
w_j=\ln\left(1+\frac{v_j}{v_0}\right).
$$

The ratio inside the logarithm is dimensionless.
A zero-value transaction has zero weight.
Larger values increase the weight at a decreasing rate.
Use `Math.log1p(v / v0)` after validating the inputs.

The proposed decay curve is:

$$
D_\lambda(n)=\frac{1}{1+\lambda n},
\qquad
W_j=a_j\cdot w_j\cdot D_\lambda(n_j).
$$

The first eligible transaction has $n_j=0$ and no pair reduction.
With $\lambda=1$, the curve matches the [decay stub](../packages/reliability/src/pair-decay.ts).
The current event flow discards the returned weight.
Changing the curve alone will not change current scores.

A proposed pair key contains buyer ID, seller ID, and category.
Read the count before the transaction's score update.
Use the same count for both role events from that transaction.
Increment the count once for an eligible transaction with positive weight.
Retries and reads do not increment it.
The product owner must decide whether reversed buyer/seller pairs share a count.
Transactions with more than two participants need an explicit pair allocation rule.
Do not select an arbitrary counterparty.

This curve reduces repeat gains. It does not eliminate collusion.
For equal transaction values, cumulative weight still grows without a fixed bound.
Identity checks and any pair contribution cap need separate rules.

## Beta updates and lower bound

Start a new entity/category/role state with a uniform prior.

$$
\alpha_0=1,\qquad\beta_0=1.
$$

For the role event, let $y_j=1$ mean success and $y_j=0$ mean failure.
Update only that event's state.

$$
\alpha'=\alpha+W_jy_j,
\qquad
\beta'=\beta+W_j(1-y_j).
$$

This is a weighted Beta model.
Fractional weights act as fractional evidence under a power likelihood.
They are not counts of independent transactions.
The resulting bound depends on the model and evidence assumptions.
It is not a guarantee about the next transaction.

For the active event history $\mathcal H$:

$$
\alpha=1+\sum_{j\in\mathcal H}W_jy_j,
\qquad
\beta=1+\sum_{j\in\mathcal H}W_j(1-y_j).
$$

The display mean and variance are:

$$
r=\frac{\alpha}{\alpha+\beta},
\qquad
\mathrm{Var}(\theta)=
\frac{\alpha\beta}{(\alpha+\beta)^2(\alpha+\beta+1)}.
$$

Policy decisions use the fifth percentile of the Beta distribution.

$$
L=F^{-1}_{\mathrm{Beta}(\alpha,\beta)}(0.05),
\qquad
\Pr(\theta\ge L\mid\mathcal H)=0.95.
$$

Here, $F^{-1}$ is the inverse cumulative distribution function.
This is a one-sided 95% lower credible bound under the model.
Do not replace it with the mean or the mean multiplied by a confidence heuristic.
For the uniform prior, $r=0.5$ and $L=0.05$.
A new entity still needs restrictive onboarding terms and KYC checks.

## Evidence-strength display

Keep verification confidence, model uncertainty, and display confidence separate.
The 95% bound above does not change with a display confidence value.
The current stub uses event count $N$:

$$
C_{\mathrm{stub}}=\frac{N}{N+10},
\qquad L_{\mathrm{stub}}=rC_{\mathrm{stub}}.
$$

$L_{\mathrm{stub}}$ is not a Beta quantile.
A proposed display measure uses effective evidence mass:

$$
M=\sum_{j\in\mathcal H}W_j=\alpha+\beta-2,
\qquad
C=\frac{M}{M+\kappa},\quad\kappa>0.
$$

$C$ is a heuristic between zero and one.
It is not a probability that the score is correct.
Its scale $\kappa$ needs a product decision.
Keep the number of applied positive-weight events as a separate event count.
Do not count an unverified or zero-weight event as new evidence.

## Fees for both participants

Use the buyer's buyer-role bound $L_b$ and the seller's seller-role bound $L_s$.
Use the applicable category for each bound.
Take both score snapshots before agreeing on the transaction terms.
Do not price an agreement from the success event it later creates.

A proposed fee curve for side $x\in\lbrace b,s\rbrace$ is:

$$
f_x(L_x)=f_{x,\min}+
\left(f_{x,\max}-f_{x,\min}\right)(1-L_x)^{\eta_x},
\qquad \eta_x>0.
$$

Require $0\le f_{x,\min}\le f_{x,\max}\le10{,}000$ basis points.
Higher bounds give lower fees when the floor and ceiling differ.
With $\eta_x=1$, the curve is linear.
The current stub uses a linear offer curve for one entity.
Its buyer and seller fields do not establish both participants' charged fees.

For agreed principal $P$:

$$
\mathrm{Fee}_b=P\frac{f_b(L_b)}{10{,}000},
\qquad
\mathrm{Fee}_s=P\frac{f_s(L_s)}{10{,}000}.
$$

If the buyer pays its fee in addition to principal, and the seller fee is deducted:

$$
\mathrm{BuyerTotal}=P+\mathrm{Fee}_b,
\qquad
\mathrm{SellerNet}=P-\mathrm{Fee}_s.
$$

This collection convention is a proposal.
Record currency, rounding, fee rates, charges, and policy version in the accepted terms.
Use integer minor units for charged amounts.
Snapshot the agreed charges. Later score changes do not rewrite them.
Define refund treatment for each fee before collecting it.

## Commercial terms and exposure

The following formulas extend the [fee and terms contract](../packages/reliability/src/fees-policy.ts).
They are recommendations until an agreement accepts and enforces them.

$$
d(L)=d_{\max}(1-L),\qquad p(L)=k(1-L),
$$

$$
u(L)=\max(u_{\min},u_0(1-L)),
$$

$$
t(L)=t_{\min}+(t_{\max}-t_{\min})L.
$$

$d$ is the deposit amount. $p$ is the premium amount.
Their scales use the agreement's currency.
$u$ is a verification probability, with $0\le u_{\min}\le u_0\le1$.
An implementation that uses checks per period needs a separate unit definition.
$t$ is the payment period in days, with $0\le t_{\min}\le t_{\max}$.
The policy must specify rounding and which role controls each term.

A proposed exposure limit is:

$$
E(L)=\min(E_{\max}L^\gamma,E_{\mathrm{KYC}}),
\qquad\gamma>0.
$$

Use the same currency for both caps and the proposed transaction exposure.
KYC restrictions can reduce the cap to zero.
A higher score cannot override an identity or authorization requirement.
This prototype formula does not establish an optimal lending or insurance limit.

## Corrections and deterministic history

Keep one active outcome revision for each transaction and affected role.
A retry of the same revision changes nothing.
A changed payload with the same command identity is a conflict.

When a dispute changes an outcome, replace the active score contributions.
Rebuild the affected states from the prior and the active history.
Do not add a failure while retaining the same transaction's earlier success credit.
Use authoritative event times and a stable transaction-ID tie-break for replay.
If eligibility or pair membership changes, rebuild later affected pair weights too.

Store the evidence reference, normalized value, pair count, weight, and policy version.
Keep observation time separate from outcome decision time.
A read must not alter a weight, pair count, or decision timestamp.
The lifecycle now implements stable decision times and active-event corrections.
It archives replaced events and preserves imported score baselines.
The current stub rebuilds each affected state as:

$$
\alpha=\alpha_{\mathrm{base}}+\sum_{e\in H_{\mathrm{active}}}\mathbf{1}[e=\mathrm{success}],
\qquad
\beta=\beta_{\mathrm{base}}+\sum_{e\in H_{\mathrm{active}}}\mathbf{1}[e=\mathrm{failure}].
$$

$H_{\mathrm{active}}$ contains only active events for that entity, category, and role.
The sums use unit weights. They do not implement the proposed value or pair weights.
For an earlier success followed by seller fault, the seller changes from $(2,1)$ to $(1,2)$.
The buyer returns from $(2,1)$ to its prior $(1,1)$.
These examples assume one transaction and the unit prior.
A repeated read changes neither state.
Weighted revisions and policy migrations still need complete policy input history.
Read [implementation status](implementation-status.md).

## Worked example

This example illustrates the proposal. It is not a production parameter choice.
Use $v=v_0$, $a=1$, and $\lambda=1$.

The first successful transaction has $W_1=\ln 2\approx0.693147$.
Starting from the prior, its state is:

$$
\alpha=1+\ln2,\qquad\beta=1,
\qquad r\approx0.628687,\qquad L\approx0.170448.
$$

The next transaction with the same pair and category has $n_2=1$.
Its weight is $W_2=\ln2/2\approx0.346574$.
If the seller is at fault, only the seller's applicable state receives that failure.
The seller's state becomes:

$$
\alpha=1+\ln2,\qquad\beta=1+\frac{\ln2}{2},
\qquad r\approx0.557007,\qquad L\approx0.135821.
$$

With the illustrative choice $\kappa=10$, $M\approx1.039721$ and $C\approx0.094180$.
A repeated command changes none of these values.
A new unverified event adds no weight.

## Decisions before implementation

Select the value currency, conversion rules, and category-specific $v_0$.
Select evidence acceptance rules and paper/live history separation.
Select pair direction, decay rate, and any contribution cap.
Select the display scale $\kappa$ and validate the model's calibration.
Select fee floors, ceilings, curve powers, rounding, and refund rules.
Select commercial term scales, exposure limits, and KYC caps.
Version these choices together with the score policy.

The current interfaces remain in [domain types](../packages/reliability/src/types.ts).
Any required type changes need a separate small PR under the repository rules.
