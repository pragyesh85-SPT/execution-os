// Test hub on port 4799 with a throwaway database (never touches the real one).
const os = require('node:os');
const path = require('node:path');
process.env.EOS_PORT = '4799';
process.env.EOS_DB = process.env.EOS_E2E_DB || path.join(os.tmpdir(), 'execution-os-e2e', 'e2e.db');
process.argv[1] = path.join(__dirname, '..', 'build', 'server.cjs');
require(process.argv[1]);
