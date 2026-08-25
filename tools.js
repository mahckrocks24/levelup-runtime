'use strict';

/**
 * Tool Registry — all registered tools.
 * Sprint A: run_test_audit (validation only)
 * Sprint B: seo_audit, keyword_research, content_brief
 */

const testAudit        = require('./test-audit');
const seoAudit         = require('./tool-seo-audit');
const keywordResearch  = require('./tool-keyword-research');
const contentBrief     = require('./tool-content-brief');

module.exports = [
    testAudit,
    seoAudit,
    keywordResearch,
    contentBrief,
    // Sprint C+ tools added here
];
