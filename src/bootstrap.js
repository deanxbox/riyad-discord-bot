const [major] = process.versions.node.split('.').map(Number);

if (major < 22) {
  console.error(`Node ${process.versions.node} is too old. Use Node 22 or newer.`);
  process.exit(1);
}

import 'dotenv/config';
import './index.js';
