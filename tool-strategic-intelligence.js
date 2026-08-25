'use strict';

/**
 * tool-strategic-intelligence.js — Wave 89
 *
 * Ports SarahStrategicLayer's 6 strategic-assessment algorithms.
 * Mount routes via mountRoutes(app, requireSecret).
 *
 *   POST /internal/strategy/assess-goal-clarity
 *   POST /internal/strategy/assess-risks
 *   POST /internal/strategy/estimate-roi
 *   POST /internal/strategy/generate-recommendation
 *   POST /internal/strategy/calculate-task-roi
 *   POST /internal/strategy/calculate-task-risk
 */

const ACTION_VERB_RE = /\b(create|build|launch|run|write|generate|improve|optimize|analyze|grow|increase)\b/i;
const TARGET_RE = /\b(website|campaign|article|post|lead|seo|traffic|content|brand|social)\b/i;

function assessGoalClarity(goal) {
    goal = String(goal || '');
    const words = goal.trim().split(/\s+/).filter(Boolean).length;
    const hasActionVerb = ACTION_VERB_RE.test(goal);
    const hasTarget = TARGET_RE.test(goal);

    let score = 0.3;
    if (words >= 5) score += 0.2;
    if (hasActionVerb) score += 0.25;
    if (hasTarget) score += 0.25;

    const issues = [];
    if (words < 3) issues.push('Goal is too vague — please provide more detail');
    if (!hasActionVerb) issues.push('No clear action — what should we DO?');
    if (!hasTarget) issues.push('No clear target — what are we working on?');

    return {
        score: Math.round(score * 100) / 100,
        issues,
        clear: score >= 0.7,
    };
}

function assessRisks(engines, creditEstimate) {
    engines = Array.isArray(engines) ? engines : [];
    creditEstimate = parseInt(creditEstimate || 0, 10);
    const risks = [];
    let riskLevel = 'low';

    if (engines.includes('social')) {
        risks.push({
            risk: 'Social posting is public-facing — errors are visible',
            mitigation: 'Require approval before publish',
            severity: 'medium',
        });
    }

    if (engines.includes('marketing')) {
        risks.push({
            risk: 'Email campaigns cannot be undone after sending',
            mitigation: 'Test send before full deployment',
            severity: 'high',
        });
        riskLevel = 'medium';
    }

    if (engines.length > 3) {
        risks.push({
            risk: 'Multi-engine plans have more failure points',
            mitigation: 'Execute in phases with checkpoints',
            severity: 'medium',
        });
        riskLevel = 'medium';
    }

    if (creditEstimate > 20) {
        risks.push({
            risk: 'High credit consumption',
            mitigation: 'Monitor credit usage during execution',
            severity: 'medium',
        });
    }

    return {
        level: riskLevel,
        risks,
        total_risks: risks.length,
    };
}

function estimateROI(pastDataConfidences) {
    pastDataConfidences = Array.isArray(pastDataConfidences) ? pastDataConfidences : [];
    let avgEffectiveness = 0.5;
    if (pastDataConfidences.length > 0) {
        const sum = pastDataConfidences.reduce((acc, v) => acc + (parseFloat(v) || 0), 0);
        avgEffectiveness = sum / pastDataConfidences.length;
    }
    const count = pastDataConfidences.length;
    return {
        estimated_effectiveness: Math.round(avgEffectiveness * 100) / 100,
        data_points: count,
        confidence: count >= 3 ? 'reliable' : 'speculative',
        note: count < 3
            ? 'Not enough historical data for reliable estimate'
            : `Based on ${count} similar campaigns`,
    };
}

function generateRecommendation(assessment) {
    assessment = assessment || {};
    let goScore = 0;
    const reasons = [];

    if (assessment.goal_clarity && assessment.goal_clarity.clear) goScore += 0.25;
    else reasons.push('Goal needs clarification');

    if (assessment.budget_feasibility && assessment.budget_feasibility.feasible) goScore += 0.25;
    else reasons.push('Insufficient credits');

    const riskLevel = (assessment.risk_assessment && assessment.risk_assessment.level) || 'low';
    if (riskLevel === 'low') goScore += 0.25;
    else if (riskLevel === 'medium') goScore += 0.15;
    else reasons.push('High risk — proceed with caution');

    const roi = (assessment.roi_estimate && assessment.roi_estimate.estimated_effectiveness) || 0.5;
    if (roi >= 0.5) goScore += 0.25;
    else reasons.push('Estimated ROI is below average');

    const decision = goScore >= 0.7 ? 'proceed'
        : goScore >= 0.4 ? 'proceed_with_caution'
        : 'reconsider';

    const messages = {
        proceed: "This looks good. I'll create the plan and we can start.",
        proceed_with_caution: "I have some concerns but we can proceed. I'll monitor closely.",
        reconsider: "I'd recommend reconsidering this approach. Here's why: " + reasons.join('. '),
    };

    return {
        decision,
        confidence: Math.round(goScore * 100) / 100,
        reasons,
        message: messages[decision],
    };
}

function calculateTaskROI(engine, action, hasIndustryData) {
    engine = String(engine || '');
    action = String(action || '');
    let baseROI;
    if (action.includes('audit') || action.includes('analysis')) baseROI = 0.7;
    else if (action.includes('write') || action.includes('article')) baseROI = 0.8;
    else if (action.includes('campaign')) baseROI = 0.6;
    else if (action.includes('social')) baseROI = 0.5;
    else if (action.includes('link')) baseROI = 0.6;
    else if (action.includes('goal')) baseROI = 0.7;
    else baseROI = 0.5;

    if (hasIndustryData) baseROI += 0.1;
    return { roi: Math.min(1.0, Math.round(baseROI * 100) / 100) };
}

function calculateTaskRisk(action) {
    action = String(action || '');
    let risk;
    if (action.includes('publish') || action.includes('send')) risk = 0.8;
    else if (action.includes('campaign')) risk = 0.6;
    else if (action.includes('social')) risk = 0.5;
    else if (action.includes('delete')) risk = 0.4;
    else if (action.includes('audit') || action.includes('analysis')) risk = 0.1;
    else risk = 0.2;
    return { risk };
}

function mountRoutes(app, requireSecret) {
    if (!app || !requireSecret) throw new Error('mountRoutes(app, requireSecret) required');

    app.post('/internal/strategy/assess-goal-clarity', requireSecret, (req, res) => {
        try { res.json(assessGoalClarity((req.body || {}).goal || '')); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/internal/strategy/assess-risks', requireSecret, (req, res) => {
        try {
            const b = req.body || {};
            res.json(assessRisks(b.engines || [], b.credit_estimate || 0));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/internal/strategy/estimate-roi', requireSecret, (req, res) => {
        try {
            res.json(estimateROI((req.body || {}).past_data_confidences || []));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/internal/strategy/generate-recommendation', requireSecret, (req, res) => {
        try {
            res.json(generateRecommendation((req.body || {}).assessment || {}));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/internal/strategy/calculate-task-roi', requireSecret, (req, res) => {
        try {
            const b = req.body || {};
            res.json(calculateTaskROI(b.engine || '', b.action || '', Boolean(b.has_industry_data)));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/internal/strategy/calculate-task-risk', requireSecret, (req, res) => {
        try {
            res.json(calculateTaskRisk((req.body || {}).action || ''));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    console.log('[strategic-intelligence] 6 /internal/strategy/* routes mounted');
}

module.exports = {
    assessGoalClarity, assessRisks, estimateROI,
    generateRecommendation, calculateTaskROI, calculateTaskRisk,
    mountRoutes,
};
