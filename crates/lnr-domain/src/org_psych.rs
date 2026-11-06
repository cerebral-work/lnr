//! Five-Subject Business School (`Wharton` · `LSE` · `HBS` · `MIT Sloan` · `Stanford`) and
//! Applied I/O Psychology Domain Suite.
//!
//! Executes five formal organizational-economics and psychological models in sequence:
//! 1. **Subject 1 — Multi-Task Principal-Agent Theory & Audit Sampling**
//!    (*Holmström & Milgrom 1991; Aghion & Tirole 1997; Tetlock 1985*): [`PrincipalAgentAuditReport`]
//! 2. **Subject 2 — Transactive Memory Systems (TMS), Relational Coordination & Handoff Entropy**
//!    (*Wegner 1987; Gittell 2002 HBS; Puranam 2014 LSE/INSEAD; Endsley 1995*): [`TransactiveMemoryReport`]
//! 3. **Subject 3 — High-Reliability Organizations (HRO), Normal Accidents & Swiss-Cheese Safety**
//!    (*Perrow 1984; Edmondson 1999 HBS; Weick & Sutcliffe 2001; Reason 1990*): [`HroSafetyReport`]
//! 4. **Subject 4 — Sequential Decision Fatigue, Vigilance Decrement & Choice Architecture**
//!    (*Danziger, Levav & Avnaim-Pesso 2011; Milkman, Beshears et al. 2011 Wharton/HBS; Mackworth 1948*):
//!    [`DecisionHygieneReport`]
//! 5. **Subject 5 — Exploration vs. Exploitation & Parallel vs. Sequential R&D Swarms**
//!    (*Loch, Terwiesch & Thomke 2001 Wharton/HBS; March 1991; Manso 2011*): [`RdPortfolioReport`]

use crate::math::DBR_MAX_UTILIZATION;
use serde::{Deserialize, Serialize};

/// Aghion & Tirole (*Quarterly Journal of Economics*, 1997) authority allocation regime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityRegime {
    /// Agent holds real authority within calibrated `Green` bounds ($\rho_{\text{eff}} \le 0.80$, high credibility).
    RealDelegation,
    /// Critic subagent performs stochastic process-accountability sampling (`Yellow` / `Sweep`).
    CriticSampling,
    /// Human governor retains formal & real authority (`Red` / `Interrupt`).
    FormalExecutiveGate,
    /// Principal is overloaded ($\rho_{\text{eff}} > 1.0$), risking unverified rubber-stamping or `Outcome::Expired`.
    OverloadMoralHazard,
}

impl AuthorityRegime {
    /// Compact label for `80x24` terminal tables.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RealDelegation => "RealDeleg(Grn)",
            Self::CriticSampling => "CriticSamp(Swp)",
            Self::FormalExecutiveGate => "FormalExec(Red)",
            Self::OverloadMoralHazard => "MoralHazard(>1)",
        }
    }
}

/// Subject 1 diagnostic: Multi-Task Principal-Agent incentive compatibility and optimal Critic audit rate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrincipalAgentAuditReport {
    /// Agent's historical calibration / verification fidelity ($C \in [0, 1]$).
    pub agent_calibration: f64,
    /// Temptation ratio of skipping unmeasured verification ($c_{\text{verify}} / L_{\text{blast}}$).
    pub shortcut_temptation: f64,
    /// Optimal stochastic Critic/governor audit probability $p_{\text{audit}}^* \in [0.05, 1.00]$
    /// under Tetlock (1985) process accountability (independent read-back verification).
    pub optimal_audit_prob: f64,
    /// Audit probability required under naive outcome-only checks (higher due to proxy gaming).
    pub outcome_only_audit_prob: f64,
    /// Active Aghion-Tirole (1997) authority regime.
    pub authority_regime: AuthorityRegime,
}

impl PrincipalAgentAuditReport {
    /// Compute the Holmström-Milgrom (1991) & Aghion-Tirole (1997) audit sampling report.
    ///
    /// - `agent_calibration`: Historical verified-claim rate $\in [0, 1]$ (e.g. `0.88`).
    /// - `verify_cost_ratio`: Ratio of verification effort to blast-radius penalty $c_{\text{verify}} / L_{\text{blast}}$.
    /// - `rho_eff`: Current operator Cobham + Sweller utilization $\rho_{\text{eff}}$.
    #[must_use]
    pub fn evaluate(agent_calibration: f64, verify_cost_ratio: f64, rho_eff: f64) -> Self {
        let cal = agent_calibration.clamp(0.0, 1.0);
        let temptation = verify_cost_ratio.clamp(0.01, 1.0);

        let uncalibrated_gap = 1.0 - cal;
        let optimal_audit_prob = (0.5 * temptation + 0.85 * uncalibrated_gap).clamp(0.05, 1.0);
        let outcome_only_audit_prob = (temptation + 1.35 * uncalibrated_gap).clamp(0.10, 1.0);

        let authority_regime = if rho_eff >= 1.0 {
            AuthorityRegime::OverloadMoralHazard
        } else if cal >= 0.90 && verify_cost_ratio <= 0.15 && rho_eff <= DBR_MAX_UTILIZATION {
            AuthorityRegime::RealDelegation
        } else if verify_cost_ratio <= 0.45 {
            AuthorityRegime::CriticSampling
        } else {
            AuthorityRegime::FormalExecutiveGate
        };

        Self {
            agent_calibration: cal,
            shortcut_temptation: temptation,
            optimal_audit_prob,
            outcome_only_audit_prob,
            authority_regime,
        }
    }
}

/// Subject 2 diagnostic: Wegner (1987) Transactive Memory System (TMS) & Gittell (2002) Relational Coordination.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransactiveMemoryReport {
    /// Total mesh peers across federated hosts (`ceres`, `ganymede`, `markspc`).
    pub mesh_peers: usize,
    /// Episodic/semantic memory observations anchored in `reverie` (`:7437`).
    pub reverie_observations: u64,
    /// Wegner Specialization pillar ($S_{\text{spec}} \in [0, 1]$ across the 5 Subject Matter Meshes).
    pub specialization_score: f64,
    /// Wegner Credibility pillar ($S_{\text{cred}} \in [0, 1]$ from verified handoff round-trips).
    pub credibility_score: f64,
    /// Wegner Coordination pillar ($S_{\text{coord}} \in [0, 1]$, inverse of cross-session drift).
    pub coordination_score: f64,
    /// Composite Gittell (2002, HBS) Relational Coordination & TMS Index $\in [0, 1]$.
    pub composite_tms_index: f64,
    /// Cumulative information loss over a $k$-hop unanchored handoff chain vs. a `reverie`-anchored chain.
    pub unanchored_3hop_loss_pct: f64,
    /// Information loss over a 3-hop chain anchored by `reverie` `RESUMABLE HANDOFF` + `ctx-state`.
    pub reverie_anchored_3hop_loss_pct: f64,
}

impl TransactiveMemoryReport {
    /// Evaluate the estate's Transactive Memory System and multi-hop handoff entropy.
    #[must_use]
    pub fn evaluate(
        mesh_peers: usize,
        reverie_observations: u64,
        specialization_score: f64,
        credibility_score: f64,
        per_hop_unanchored_loss: f64,
    ) -> Self {
        let spec = specialization_score.clamp(0.0, 1.0);
        let cred = credibility_score.clamp(0.0, 1.0);
        let hop_loss = per_hop_unanchored_loss.clamp(0.0, 0.95);

        let unanchored_3hop_loss = 1.0 - (1.0 - hop_loss).powi(3);
        let anchored_hop_loss = hop_loss * 0.18;
        let anchored_3hop_loss = 1.0 - (1.0 - anchored_hop_loss).powi(3);

        let coord = (1.0 - anchored_3hop_loss).clamp(0.0, 1.0);
        let composite_tms_index = (spec + cred + coord) / 3.0;

        Self {
            mesh_peers,
            reverie_observations,
            specialization_score: spec,
            credibility_score: cred,
            coordination_score: coord,
            composite_tms_index,
            unanchored_3hop_loss_pct: unanchored_3hop_loss * 100.0,
            reverie_anchored_3hop_loss_pct: anchored_3hop_loss * 100.0,
        }
    }
}

/// Charles Perrow (1984) *Normal Accidents* Interaction Complexity $\times$ Coupling quadrant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PerrowQuadrant {
    /// Linear interactions + Loose coupling (Bounded pod + `DeltaDB` + `Sweep` buffer).
    LinearLooseSafe,
    /// Linear interactions + Tight coupling (Deterministic CI `Land-on-Green` pipeline).
    LinearTightPipeline,
    /// Complex interactions + Loose coupling (Isolated multi-agent `SCI-SWARM` research fan-out).
    ComplexLooseModular,
    /// Complex interactions + Tight coupling (Unbuffered `w26` $N=23$ hub -> Normal Accident zone!).
    ComplexTightNormalAccident,
}

impl PerrowQuadrant {
    /// Compact label for terminal tables.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LinearLooseSafe => "Lin+Loose(Safe)",
            Self::LinearTightPipeline => "Lin+Tight(CI)",
            Self::ComplexLooseModular => "Cmp+Loose(Pod)",
            Self::ComplexTightNormalAccident => "Cmp+Tight(NAT!)",
        }
    }
}

/// Subject 3 diagnostic: Perrow (1984) Normal Accident classification, Reason (1990) Swiss-Cheese
/// defense penetration probability, and Edmondson (1999, HBS) psychological safety / voice index.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HroSafetyReport {
    /// Perrow Interaction Complexity $\times$ Tight Coupling classification.
    pub quadrant: PerrowQuadrant,
    /// Number of independent Reason (1990) Swiss-Cheese defensive barriers active ($L$).
    pub defense_layers: usize,
    /// Cumulative breach probability across all $L$ Swiss-Cheese layers with common-mode coupling $\gamma$.
    pub swiss_cheese_breach_prob: f64,
    /// Edmondson (1999, HBS) voice / anti-sycophancy index $\in [0, 1]$ (bad-news parity ratio).
    pub edmondson_voice_index: f64,
}

impl HroSafetyReport {
    /// Evaluate HRO safety for a given interaction complexity $\in [0, 1]$, tight coupling $\in [0, 1]$,
    /// per-layer hole probabilities, and Edmondson bad-news voice parity $\in [0, 1]$.
    #[must_use]
    pub fn evaluate(
        interactive_complexity: f64,
        tight_coupling: f64,
        layer_hole_probs: &[f64],
        edmondson_voice_index: f64,
    ) -> Self {
        let comp = interactive_complexity.clamp(0.0, 1.0);
        let coup = tight_coupling.clamp(0.0, 1.0);
        let voice = edmondson_voice_index.clamp(0.0, 1.0);

        let quadrant = match (comp >= 0.50, coup >= 0.50) {
            (false, false) => PerrowQuadrant::LinearLooseSafe,
            (false, true) => PerrowQuadrant::LinearTightPipeline,
            (true, false) => PerrowQuadrant::ComplexLooseModular,
            (true, true) => PerrowQuadrant::ComplexTightNormalAccident,
        };

        let independent_prod: f64 = if layer_hole_probs.is_empty() {
            1.0
        } else {
            layer_hole_probs
                .iter()
                .map(|&p| p.clamp(0.001, 1.0))
                .product()
        };
        let common_mode_multiplier = 1.0 + 4.0 * coup * (1.0 - voice);
        let swiss_cheese_breach_prob = (independent_prod * common_mode_multiplier).clamp(0.0, 1.0);

        Self {
            quadrant,
            defense_layers: layer_hole_probs.len(),
            swiss_cheese_breach_prob,
            edmondson_voice_index: voice,
        }
    }
}

/// Subject 4 diagnostic: Mackworth (1948) vigilance sensitivity $d'$, Danziger-Levav (2011)
/// sequential decision depletion, and Milkman-Beshears (Wharton/HBS) choice architecture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecisionHygieneReport {
    /// Raw signal-to-noise ratio before `Sweep` filtering (e.g., `32 / 1970 = 0.0162` in `revenant`).
    pub raw_signal_purity: f64,
    /// Post-filter signal purity in `Urgency::Interrupt` after parking compensable cards in `Sweep`.
    pub filtered_signal_purity: f64,
    /// Mackworth signal-detection sensitivity $d'$ under raw unthrottled stream after $k$ decisions.
    pub raw_vigilance_d_prime: f64,
    /// Mackworth signal-detection sensitivity $d'$ under `herdr-attn` filtered + batched stream.
    pub filtered_vigilance_d_prime: f64,
    /// Danziger-Levav (2011, *PNAS*) probability of defaulting to status-quo refusal after $k$ consecutive turns.
    pub sequential_status_quo_bias_pct: f64,
    /// Recommended maximum governance cards per `Sweep` batch before a mandatory reset.
    pub max_cards_per_sweep_batch: usize,
}

impl DecisionHygieneReport {
    /// Evaluate Mackworth vigilance decrement and Danziger-Levav sequential decision depletion.
    #[must_use]
    pub fn evaluate(
        approved_count: u64,
        refused_count: u64,
        consecutive_decisions_k: usize,
        filtered_signal_purity: f64,
    ) -> Self {
        let total = (approved_count + refused_count).max(1) as f64;
        let raw_purity = (approved_count as f64 / total).clamp(0.001, 1.0);
        let filt_purity = filtered_signal_purity.clamp(raw_purity, 1.0);

        let depletion_factor = (-0.035 * (consecutive_decisions_k as f64)).exp();
        let raw_d_prime = 3.20 * depletion_factor * raw_purity.sqrt();
        let batched_depletion = (-0.035 * (consecutive_decisions_k.min(8) as f64)).exp();
        let filtered_d_prime = 3.20 * batched_depletion * filt_purity.sqrt();

        let status_quo_bias = 1.0 - 0.65 * depletion_factor;

        Self {
            raw_signal_purity: raw_purity,
            filtered_signal_purity: filt_purity,
            raw_vigilance_d_prime: raw_d_prime,
            filtered_vigilance_d_prime: filtered_d_prime,
            sequential_status_quo_bias_pct: (status_quo_bias * 100.0).clamp(0.0, 100.0),
            max_cards_per_sweep_batch: 8,
        }
    }
}

/// Loch, Terwiesch & Thomke (*Management Science*, 2001, Wharton & HBS) experimentation strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExperimentStrategy {
    /// $K^* = 1$: High inter-step learning ($\ell \ge 0.65$); run sequential Maker-Reviewer ratchet (`/autoproject`).
    SequentialRatchet,
    /// $2 \le K^* \le 3$: Balanced hybrid wave (parallel bounded builders + sequential synthesis).
    HybridWave,
    /// $4 \le K^* \le 5$: High uncertainty/latency, low inter-step learning ($\ell \le 0.25$); run parallel fan-out (`/deep-research`).
    ParallelSwarmFanout,
}

impl ExperimentStrategy {
    /// Compact label for terminal rendering.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SequentialRatchet => "SeqRatchet(K=1)",
            Self::HybridWave => "HybridWave(2..3)",
            Self::ParallelSwarmFanout => "ParFanout(4..5)",
        }
    }
}

/// Subject 5 diagnostic: Loch-Terwiesch-Thomke (2001) parallel vs. sequential swarm sizing and
/// March (1991) exploration/exploitation balance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RdPortfolioReport {
    /// Task name or R&D workstream profile.
    pub profile_name: String,
    /// Inter-iteration sequential learning rate $\ell \in [0, 1]$.
    pub sequential_learning_rate: f64,
    /// Ratio of delay cost to virtualized `DeltaDB` test cost ($c_{\text{wait}} \cdot \tau_{\text{exec}} / c_{\text{test}}$).
    pub delay_to_test_cost_ratio: f64,
    /// Optimal number of parallel subagent branches $K^* \in \{1, \dots, 5\}$.
    pub optimal_parallel_k: usize,
    /// Prescribed Loch-Terwiesch-Thomke experimentation strategy.
    pub strategy: ExperimentStrategy,
    /// March (1991) exploration fraction $\in [0, 1]$ protecting against premature convergence.
    pub march_exploration_share: f64,
}

impl RdPortfolioReport {
    /// Compute the optimal Loch-Terwiesch-Thomke (2001, Wharton/HBS) parallel wave size $K^*$
    /// and March (1991) exploration share.
    #[must_use]
    pub fn evaluate(
        profile_name: impl Into<String>,
        sequential_learning_rate: f64,
        delay_to_test_cost_ratio: f64,
    ) -> Self {
        let learn = sequential_learning_rate.clamp(0.0, 1.0);
        let cost_ratio = delay_to_test_cost_ratio.max(0.1);

        let raw_k = (cost_ratio * (1.0 - learn)).sqrt().round() as usize;
        let optimal_parallel_k = raw_k.clamp(1, 5);

        let strategy = match optimal_parallel_k {
            1 => ExperimentStrategy::SequentialRatchet,
            2 | 3 => ExperimentStrategy::HybridWave,
            _ => ExperimentStrategy::ParallelSwarmFanout,
        };

        let march_exploration_share = (0.15 + 0.55 * (1.0 - learn)).clamp(0.10, 0.70);

        Self {
            profile_name: profile_name.into(),
            sequential_learning_rate: learn,
            delay_to_test_cost_ratio: cost_ratio,
            optimal_parallel_k,
            strategy,
            march_exploration_share,
        }
    }
}

/// Wes Brown Engineering Leadership Canon: Top 3 Engineering Principles verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WesBrownPrincipleVerdict {
    /// Solves the highest-impact root problem at bounded cost and ships the 80% "good enough" point.
    ShipEightyTwenty,
    /// Over-engineered >92% completeness target with high complexity/maintenance burden ("perfection is the enemy of good").
    PerfectionismTrap,
    /// Patches a surface symptom rather than the highest-impact root problem.
    SymptomWorkaround,
    /// Time, complexity, or maintenance burden exceeds the problem's impact.
    ExcessiveMaintenanceBurden,
}

impl WesBrownPrincipleVerdict {
    /// Compact label for `80x24` terminal tables.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ShipEightyTwenty => "Ship80/20(Grn)",
            Self::PerfectionismTrap => "PerfTrap(>92%)",
            Self::SymptomWorkaround => "SymptomOnly",
            Self::ExcessiveMaintenanceBurden => "HighMaintTax",
        }
    }
}

/// Subject 6 diagnostic: Wes Brown's Engineering Leadership Canon (`xc-iopsych-corpus`:
/// `iopsych-wes-brown-leadership-canon`) — Top 3 Engineering Principles, Neurodivergent
/// Executive Scaffolding, Interoceptive State Debugging ("debug the state, not the argument"),
/// Public-by-Default Transactive Memory (`#ml-dev`), Self-Driven Deadlines, and the 5-6 Engineer Ceiling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WesBrownLeadershipReport {
    /// Active direct reports or concurrent subagent lanes (hard ceiling: `<= 6`).
    pub active_lanes: usize,
    /// Whether the team respects the 5-6 engineer/lane hard span-of-control ceiling.
    pub within_span_ceiling: bool,
    /// Principle 1: Root-problem impact score $\in [0, 1]$.
    pub root_problem_impact: f64,
    /// Principle 2: Time, complexity, and maintenance cost burden $\in [0, 1]$.
    pub cost_burden_ratio: f64,
    /// Principle 3: Target completeness $\in [0, 1]$ (80/20 sweet spot is $[0.75, 0.92]$).
    pub target_completeness: f64,
    /// Verdict from Wes Brown's Top 3 Engineering Principles.
    pub principle_verdict: WesBrownPrincipleVerdict,
    /// Continuous hyperfocus/debugging minutes without a break or `/checkpoint`.
    pub continuous_minutes: u32,
    /// Whether an immediate interoceptive/context state-reset timeout is required ($\ge 240\text{m}$ or $\rho_{\text{eff}} \ge 0.85$).
    pub interoceptive_timeout_required: bool,
    /// Fraction of work discussions in public searchable channels (`#ml-dev` / `XERJ`) vs. 1:1 DMs.
    pub public_channel_ratio: f64,
    /// Whether synchronous exploratory sessions obey the "Never Recorded" rule and status is artifact-derived ("Fuck Jira").
    pub never_recorded_and_artifact_status: bool,
}

impl WesBrownLeadershipReport {
    /// Evaluate Wes Brown's Engineering Leadership Canon practices and Top 3 Principles.
    #[must_use]
    pub fn evaluate(
        active_lanes: usize,
        root_problem_impact: f64,
        cost_burden_ratio: f64,
        target_completeness: f64,
        continuous_minutes: u32,
        rho_eff: f64,
        public_channel_ratio: f64,
        never_recorded_and_artifact_status: bool,
    ) -> Self {
        let impact = root_problem_impact.clamp(0.0, 1.0);
        let cost = cost_burden_ratio.clamp(0.0, 1.0);
        let completeness = target_completeness.clamp(0.0, 1.0);
        let pub_ratio = public_channel_ratio.clamp(0.0, 1.0);
        let leverage = impact / cost.max(0.05);

        let principle_verdict = if impact < 0.50 {
            WesBrownPrincipleVerdict::SymptomWorkaround
        } else if completeness > 0.92 && cost > 0.45 {
            WesBrownPrincipleVerdict::PerfectionismTrap
        } else if cost > 0.65 || leverage < 1.15 {
            WesBrownPrincipleVerdict::ExcessiveMaintenanceBurden
        } else {
            WesBrownPrincipleVerdict::ShipEightyTwenty
        };

        let interoceptive_timeout_required = continuous_minutes >= 240 || rho_eff >= 0.85;

        Self {
            active_lanes,
            within_span_ceiling: active_lanes <= 6,
            root_problem_impact: impact,
            cost_burden_ratio: cost,
            target_completeness: completeness,
            principle_verdict,
            continuous_minutes,
            interoceptive_timeout_required,
            public_channel_ratio: pub_ratio,
            never_recorded_and_artifact_status,
        }
    }
}

/// Principle 3 of the 7-Principle Sales & Problem-Solving Canon (`xc-iopsych-corpus`:
/// `iopsych-sales-problem-solving-canon`):
/// "People buy 4 things and 4 things only. Ever. Those 4 things are time, money, sex,
/// and approval/peace of mind. If you try selling something other than those 4 things you will fail."
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuyerDriver {
    /// Saves execution or engineering time (e.g., zero ingestion pipeline authoring, fewer agent turns).
    Time,
    /// Saves or generates money (e.g., lower compute/token spend, single binary replacing a cluster).
    Money,
    /// Elevates status, attraction, or prestige for the buyer.
    Sex,
    /// Delivers approval, certainty, compliance, and peace of mind (e.g., citation-backed ground truth).
    ApprovalPeaceOfMind,
}

impl BuyerDriver {
    /// Compact label for `80x24` terminal tables.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Time => "Time",
            Self::Money => "Money",
            Self::Sex => "Sex/Status",
            Self::ApprovalPeaceOfMind => "PeaceOfMind",
        }
    }
}

/// Principle 4 of the 7-Principle Sales & Problem-Solving Canon:
/// "People buy aspirin always. They buy vitamins only occasionally and at unpredictable times. Sell aspirin."
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PainClass {
    /// Acute, immediate pain relief bought predictably in every cycle.
    Aspirin,
    /// Optional nice-to-have bought only occasionally and at unpredictable times.
    Vitamin,
}

impl PainClass {
    /// Compact label for `80x24` terminal tables.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Aspirin => "Aspirin(Acute)",
            Self::Vitamin => "Vitamin(Opt)",
        }
    }
}

/// Verdict from evaluating a product positioning, demo flow, or commercial offer against
/// the 7-Principle Sales & Problem-Solving Canon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SalesCanonVerdict {
    /// Satisfies all 7 principles: walks up and hits the ball, focuses on people & problem solving,
    /// anchors in the 4 buyer drivers, sells Aspirin, establishes product parity + friendship,
    /// practices value-first generosity, and leaks zero internal metrics.
    HitTheBallAspirin,
    /// Violates Principle 7: leaks internal quota, payroll, opex, or burn rate to the buyer.
    InternalMetricLeakage,
    /// Violates Principle 2: pitches technology, lines of code, or jargon instead of the human problem.
    TechJargonOverProblem,
    /// Violates Principle 3: fails to anchor in Time, Money, Sex, or Approval/Peace of Mind.
    MissingBuyerDriver,
    /// Violates Principle 4: pitches an optional Vitamin instead of acute Aspirin pain relief.
    VitaminPitch,
    /// Violates Principle 1: overcomplicates execution instead of walking up and hitting the ball.
    OvercomplicatedFunnel,
    /// Violates Principle 5 or 6: lacks baseline product parity ("make everything else equal")
    /// or gates help transactionally instead of practicing unconditional value-first generosity.
    TransactionalOrLowParity,
}

impl SalesCanonVerdict {
    /// Compact label for `80x24` terminal tables.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HitTheBallAspirin => "HitBall+Aspirin",
            Self::InternalMetricLeakage => "MetricLeak(Fail)",
            Self::TechJargonOverProblem => "TechOverProblem",
            Self::MissingBuyerDriver => "No4Driver(Fail)",
            Self::VitaminPitch => "Vitamin(Skip)",
            Self::OvercomplicatedFunnel => "Overcomplicated",
            Self::TransactionalOrLowParity => "LowParity/Trans",
        }
    }
}

/// Subject 7 diagnostic: The 7-Principle Sales & Problem-Solving Canon (`xc-iopsych-corpus`:
/// `iopsych-sales-problem-solving-canon`) — Direct Execution ("Walk up and hit the ball"),
/// People & Problem Solving Over Tech/Lines of Code, the 4 Buyer Drivers (`Time`, `Money`,
/// `Sex`, `Approval/Peace of Mind`), Aspirin vs. Vitamins, Product Parity + Friendship,
/// Unconditional Value-First Generosity, and Zero Internal-Metric Leakage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SalesCanonReport {
    /// Principle 1 ("Walk up and hit the ball"): direct execution simplicity $\in [0, 1]$.
    pub direct_execution_score: f64,
    /// Principle 2 ("People and problem solving, not lines of code"): human problem focus $\in [0, 1]$.
    pub problem_over_tech_ratio: f64,
    /// Principle 3 ("People buy 4 things and 4 things only"): anchored buyer drivers.
    pub buyer_drivers: Vec<BuyerDriver>,
    /// Principle 4 ("Sell aspirin, not vitamins"): pain classification.
    pub pain_class: PainClass,
    /// Principle 5 ("Make everything else equal, then go make a lot of friends"):
    /// product parity/quality score $\in [0, 1]$.
    pub product_parity_score: f64,
    /// Principle 5 & 6 ("Go make a lot of friends" + "Being valuable and useful expecting nothing in return"):
    /// authentic value-first generosity and relationship warmth $\in [0, 1]$.
    pub value_first_generosity_score: f64,
    /// Principle 7 ("No one cares about your quota, payroll, opex, burn rate"):
    /// `true` if any internal company metric is leaked into the external pitch.
    pub leaks_internal_metrics: bool,
    /// Resulting 7-Principle Sales Canon verdict.
    pub verdict: SalesCanonVerdict,
}

impl SalesCanonReport {
    /// Evaluate a product pitch, demo, or commercial workflow against all 7 principles.
    #[must_use]
    pub fn evaluate(
        direct_execution_score: f64,
        problem_over_tech_ratio: f64,
        buyer_drivers: Vec<BuyerDriver>,
        pain_class: PainClass,
        product_parity_score: f64,
        value_first_generosity_score: f64,
        leaks_internal_metrics: bool,
    ) -> Self {
        let direct = direct_execution_score.clamp(0.0, 1.0);
        let problem = problem_over_tech_ratio.clamp(0.0, 1.0);
        let parity = product_parity_score.clamp(0.0, 1.0);
        let generosity = value_first_generosity_score.clamp(0.0, 1.0);

        let verdict = if leaks_internal_metrics {
            SalesCanonVerdict::InternalMetricLeakage
        } else if problem < 0.60 {
            SalesCanonVerdict::TechJargonOverProblem
        } else if buyer_drivers.is_empty() {
            SalesCanonVerdict::MissingBuyerDriver
        } else if pain_class == PainClass::Vitamin {
            SalesCanonVerdict::VitaminPitch
        } else if direct < 0.60 {
            SalesCanonVerdict::OvercomplicatedFunnel
        } else if parity < 0.75 || generosity < 0.70 {
            SalesCanonVerdict::TransactionalOrLowParity
        } else {
            SalesCanonVerdict::HitTheBallAspirin
        };

        Self {
            direct_execution_score: direct,
            problem_over_tech_ratio: problem,
            buyer_drivers,
            pain_class,
            product_parity_score: parity,
            value_first_generosity_score: generosity,
            leaks_internal_metrics,
            verdict,
        }
    }
}

/// Complete 5-Subject Organizational Science & Applied I/O Psychology Suite Report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FiveSubjectSuiteReport {
    /// Subject 1: Multi-Task Principal-Agent & Optimal Audit Sampling (`Holmström-Milgrom` / `Aghion-Tirole`).
    pub subject1_principal_agent: PrincipalAgentAuditReport,
    /// Subject 2: Transactive Memory Systems & Handoff Entropy (`Wegner` / `Gittell HBS` / `Puranam LSE`).
    pub subject2_transactive_memory: TransactiveMemoryReport,
    /// Subject 3: High-Reliability Orgs & Normal Accidents (`Perrow` / `Edmondson HBS` / `Reason`).
    pub subject3_hro_hub: HroSafetyReport,
    /// Subject 3 comparison: Modular Pod (`w38` / `w2A`) HRO safety.
    pub subject3_hro_modular_pod: HroSafetyReport,
    /// Subject 4: Sequential Decision Fatigue & Vigilance Decrement (`Danziger-Levav` / `Milkman Wharton` / `Mackworth`).
    pub subject4_decision_hygiene: DecisionHygieneReport,
    /// Subject 5a: Deep Research / Literature Synthesis R&D Swarm (`Loch-Terwiesch-Thomke`).
    pub subject5_deep_research: RdPortfolioReport,
    /// Subject 5b: Single-Crate Compiler/Test Ratchet (`Loch-Terwiesch-Thomke`).
    pub subject5_compiler_ratchet: RdPortfolioReport,
}

impl FiveSubjectSuiteReport {
    /// Evaluate all five Business School & Applied I/O Psychology models against live estate metrics.
    #[must_use]
    pub fn evaluate_live_estate(
        mesh_peers: usize,
        reverie_observations: u64,
        revenant_approved: u64,
        revenant_refused: u64,
        active_ws_rho_eff: f64,
    ) -> Self {
        let subject1_principal_agent =
            PrincipalAgentAuditReport::evaluate(0.88, 0.20, active_ws_rho_eff);

        let subject2_transactive_memory =
            TransactiveMemoryReport::evaluate(mesh_peers, reverie_observations, 0.86, 0.91, 0.22);

        let layers = [0.10, 0.10, 0.15, 0.08, 0.12];
        let subject3_hro_hub = HroSafetyReport::evaluate(0.85, 0.80, &layers, 0.65);
        let subject3_hro_modular_pod = HroSafetyReport::evaluate(0.65, 0.20, &layers, 0.94);

        let subject4_decision_hygiene =
            DecisionHygieneReport::evaluate(revenant_approved, revenant_refused, 25, 0.82);

        let subject5_deep_research =
            RdPortfolioReport::evaluate("deep-research-fanout", 0.15, 28.0);
        let subject5_compiler_ratchet =
            RdPortfolioReport::evaluate("compiler-test-ratchet", 0.88, 8.0);

        Self {
            subject1_principal_agent,
            subject2_transactive_memory,
            subject3_hro_hub,
            subject3_hro_modular_pod,
            subject4_decision_hygiene,
            subject5_deep_research,
            subject5_compiler_ratchet,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn subject1_process_accountability_lowers_required_audit_rate_vs_outcome_only() {
        let rep = PrincipalAgentAuditReport::evaluate(0.88, 0.20, 0.62);
        assert!(rep.optimal_audit_prob < rep.outcome_only_audit_prob);
        assert_eq!(rep.authority_regime, AuthorityRegime::CriticSampling);

        let overloaded = PrincipalAgentAuditReport::evaluate(0.88, 0.20, 3.85);
        assert_eq!(
            overloaded.authority_regime,
            AuthorityRegime::OverloadMoralHazard
        );
    }

    #[test]
    fn subject2_reverie_handoff_anchoring_cuts_3hop_entropy_drastically() {
        let tms = TransactiveMemoryReport::evaluate(93, 28_670, 0.86, 0.91, 0.22);
        assert!(tms.unanchored_3hop_loss_pct > 50.0);
        assert!(tms.reverie_anchored_3hop_loss_pct < 12.0);
        assert!(tms.composite_tms_index > 0.85);
    }

    #[test]
    fn subject3_perrow_and_swiss_cheese_distinguish_normal_accident_hub_from_modular_pod() {
        let layers = [0.10, 0.10, 0.15, 0.08, 0.12];
        let hub = HroSafetyReport::evaluate(0.85, 0.80, &layers, 0.65);
        let pod = HroSafetyReport::evaluate(0.65, 0.20, &layers, 0.94);

        assert_eq!(hub.quadrant, PerrowQuadrant::ComplexTightNormalAccident);
        assert_eq!(pod.quadrant, PerrowQuadrant::ComplexLooseModular);
        assert!(hub.swiss_cheese_breach_prob > pod.swiss_cheese_breach_prob * 1.8);
    }

    #[test]
    fn subject4_sweep_filtering_restores_mackworth_vigilance_sensitivity() {
        let hyg = DecisionHygieneReport::evaluate(32, 1938, 25, 0.82);
        assert!(hyg.raw_signal_purity < 0.02);
        assert!(hyg.filtered_vigilance_d_prime > hyg.raw_vigilance_d_prime * 6.0);
        assert!(hyg.sequential_status_quo_bias_pct > 70.0);
    }

    #[test]
    fn subject5_loch_terwiesch_thomke_selects_k5_for_research_and_k1_for_compiler_ratchet() {
        let research = RdPortfolioReport::evaluate("deep-research", 0.15, 28.0);
        let compiler = RdPortfolioReport::evaluate("compiler-ratchet", 0.88, 8.0);

        assert_eq!(research.optimal_parallel_k, 5);
        assert_eq!(research.strategy, ExperimentStrategy::ParallelSwarmFanout);
        assert_eq!(compiler.optimal_parallel_k, 1);
        assert_eq!(compiler.strategy, ExperimentStrategy::SequentialRatchet);
        assert!(research.march_exploration_share > compiler.march_exploration_share);
    }

    #[test]
    fn subject6_wes_brown_leadership_evaluates_top_three_principles_interoception_and_span_ceiling()
    {
        let healthy = WesBrownLeadershipReport::evaluate(5, 0.90, 0.25, 0.80, 90, 0.55, 0.98, true);
        assert!(healthy.within_span_ceiling);
        assert_eq!(
            healthy.principle_verdict,
            WesBrownPrincipleVerdict::ShipEightyTwenty
        );
        assert!(!healthy.interoceptive_timeout_required);

        let perfectionist_overloaded =
            WesBrownLeadershipReport::evaluate(8, 0.85, 0.60, 0.98, 360, 0.92, 0.50, false);
        assert!(!perfectionist_overloaded.within_span_ceiling);
        assert_eq!(
            perfectionist_overloaded.principle_verdict,
            WesBrownPrincipleVerdict::PerfectionismTrap
        );
        assert!(perfectionist_overloaded.interoceptive_timeout_required);
    }

    #[test]
    fn subject7_sales_canon_enforces_seven_principles_aspirin_four_drivers_and_zero_metric_leakage()
    {
        let xerj_flagship = SalesCanonReport::evaluate(
            0.92,
            0.90,
            vec![
                BuyerDriver::Time,
                BuyerDriver::Money,
                BuyerDriver::ApprovalPeaceOfMind,
            ],
            PainClass::Aspirin,
            0.95,
            0.92,
            false,
        );
        assert_eq!(xerj_flagship.verdict, SalesCanonVerdict::HitTheBallAspirin);

        let leaked_quota = SalesCanonReport::evaluate(
            0.90,
            0.90,
            vec![BuyerDriver::Time],
            PainClass::Aspirin,
            0.90,
            0.90,
            true,
        );
        assert_eq!(
            leaked_quota.verdict,
            SalesCanonVerdict::InternalMetricLeakage
        );

        let vitamin_pitch = SalesCanonReport::evaluate(
            0.85,
            0.85,
            vec![BuyerDriver::Time],
            PainClass::Vitamin,
            0.90,
            0.85,
            false,
        );
        assert_eq!(vitamin_pitch.verdict, SalesCanonVerdict::VitaminPitch);
    }
}
