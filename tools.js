'use strict';

/**
 * Tool exports — all tools registered in the runtime.
 *
 * Sprint A: one hardcoded test tool.
 * Sprint B+: SEO audit, keyword analysis, CRM contact creation.
 * Each sprint adds more tools here without changing any agent code.
 */

const testAudit = require('./tools/test-audit');

module.exports = [
    testAudit,
    // Sprint B tools will be added here:
    // require('./tools/seo-audit'),
    // require('./tools/keyword-analysis'),
    // require('./tools/crm-contact-create'),
];
