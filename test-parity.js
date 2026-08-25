#!/usr/bin/env node
'use strict';
const pro = require('./tool-proactive-intelligence');

let passes = 0, fails = 0;
function check(name, exp, act) {
    const eq = JSON.stringify(exp) === JSON.stringify(act);
    if (eq) { passes++; console.log(`  PASS  ${name}`); }
    else { fails++; console.log(`  FAIL  ${name}\n        expected: ${JSON.stringify(exp)}\n        actual:   ${JSON.stringify(act)}`); }
}

console.log('=== findOpportunities ===');

// 1: fresh workspace — both rules fire
const r1 = pro.findOpportunities(0, false);
check('fresh workspace -> 2 opportunities', 2, r1.length);
check('fresh workspace first opp is first_content', 'first_content', r1[0].type);
check('fresh workspace second opp is seo_audit', 'seo_audit', r1[1].type);

// 2: article published, no audit — only seo_audit fires
const r2 = pro.findOpportunities(5, false);
check('published + no audit -> 1 opportunity', 1, r2.length);
check('seo_audit only', 'seo_audit', r2[0].type);

// 3: no articles, audit done — only first_content
const r3 = pro.findOpportunities(0, true);
check('no articles + audit done -> 1 opportunity', 1, r3.length);
check('first_content only', 'first_content', r3[0].type);

// 4: mature workspace — no opportunities
const r4 = pro.findOpportunities(10, true);
check('mature workspace -> 0 opportunities', 0, r4.length);

// 5: schema integrity — every opportunity has the required keys
let allValid = true;
const r5 = pro.findOpportunities(0, false);
for (const opp of r5) {
    if (!opp.type || !opp.title || !opp.description || !Array.isArray(opp.cost_breakdown) || typeof opp.total_credits !== 'number') {
        allValid = false; break;
    }
}
check('opportunity schema integrity', true, allValid);

// 6: cost_breakdown structure
check('first_content cost_breakdown.action', 'write_article', r5[0].cost_breakdown[0].action);
check('first_content cost_breakdown.credits', 3, r5[0].cost_breakdown[0].credits);
check('seo_audit cost_breakdown.action', 'deep_audit', r5[1].cost_breakdown[0].action);

console.log(`\n${passes} pass, ${fails} fail`);
process.exit(fails === 0 ? 0 : 1);
