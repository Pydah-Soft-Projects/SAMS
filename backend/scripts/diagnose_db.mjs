import 'dotenv/config';
import mongoose from 'mongoose';

async function check(name, uri) {
  console.log(`\nChecking ${name}... (${uri ? uri.replace(/:([^:@]+)@/, ':***@') : 'empty'})`);
  if (!uri) {
    console.log(`  ${name}: No URI provided.`);
    return;
  }
  try {
    const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
    console.log(`  ${name}: Connected!`);
    const cols = await conn.db.listCollections().toArray();
    console.log(`  ${name} collections (${cols.length}):`, cols.map(c => c.name).join(', '));
    for (const c of ['gatelogs', 'passes', 'registrations', 'roles', 'shifts']) {
      if (cols.some(col => col.name === c)) {
        const count = await conn.db.collection(c).countDocuments();
        console.log(`    - ${c}: ${count}`);
      }
    }
    await conn.close();
  } catch (err) {
    console.log(`  ${name} failed:`, err.message);
  }
}

async function run() {
  await check('LOCAL (127.0.0.1)', 'mongodb://127.0.0.1:27017/smas');
  await check('DEST_URI (.env)', process.env.DEST_MONGODB_URI);
  await check('SOURCE_URI (.env / PROD)', process.env.SOURCE_MONGODB_URI || process.env.MONGODB_URI);
  process.exit(0);
}

run();
