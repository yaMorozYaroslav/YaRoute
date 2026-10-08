import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync('config/heroku-public.json', 'utf8'));
if (config.NYX_HANDOFF_COORDINATION === 'single-dyno') {
  const formation = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const features = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const web = formation.filter(x => x.type === 'web');
  const preboot = features.find(x => x.name === 'preboot');
  if (web.length !== 1 || web[0].quantity !== 1 || !preboot || preboot.enabled !== false) {
    throw new Error('Single-dyno handoffs require exactly one web dyno and disabled preboot; use PostgreSQL coordination before scaling.');
  }
  console.log('Verified single web dyno and disabled preboot.');
}
