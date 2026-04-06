const [major] = process.versions.node.split('.').map(Number);

if (major < 18) {
  console.error(`Node ${process.versions.node} is too old. Use Node 18 or newer.`);
  process.exit(1);
}

import 'dotenv/config';
import './index.js';
