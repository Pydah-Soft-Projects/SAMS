import mongoose from 'mongoose';

const PROD_URI = 'mongodb+srv://teampydah:TeamPydah@teampydah.y4zj6wh.mongodb.net/SMAS';

async function run() {
  const conn = await mongoose.createConnection(PROD_URI, { readPreference: 'secondaryPreferred' }).asPromise();
  console.log('Connected to PROD');

  const GateLog = conn.model('GateLog', new mongoose.Schema({}, { strict: false }), 'gatelogs');
  const Pass = conn.model('Pass', new mongoose.Schema({}, { strict: false }), 'passes');
  const Registration = conn.model('Registration', new mongoose.Schema({}, { strict: false }), 'registrations');
  const Role = conn.model('Role', new mongoose.Schema({}, { strict: false }), 'roles');

  // 1. Inspect Oct 13 logs between 17:00 and 20:00 IST
  // In UTC: 17:00 IST = 11:30 UTC, 19:45 IST = 14:15 UTC, 20:00 IST = 14:30 UTC
  const startTodayEve = new Date('2026-10-13T11:00:00.000Z'); // 16:30 IST
  const cutoff745 = new Date('2026-10-13T14:15:00.000Z'); // 19:45 IST
  const endTodayEve = new Date('2026-10-13T16:00:00.000Z'); // 21:30 IST

  const eveLogs = await GateLog.find({
    createdAt: { $gte: startTodayEve, $lte: endTodayEve },
    accessGranted: true
  }).sort({ createdAt: 1 }).lean();

  console.log(`\nFound ${eveLogs.length} granted logs between 16:30 IST and 21:30 IST today (Oct 13).`);

  const before745Logs = eveLogs.filter(l => new Date(l.createdAt) <= cutoff745);
  const after745Logs = eveLogs.filter(l => new Date(l.createdAt) > cutoff745);

  console.log(`Logs <= 19:45 IST (7:45 PM): ${before745Logs.length}`);
  console.log(`Logs > 19:45 IST (7:45 PM): ${after745Logs.length}`);

  const countsBefore745 = {};
  for (const l of before745Logs) {
    const k = `${l.scanType}_${l.eventType}`;
    countsBefore745[k] = (countsBefore745[k] || 0) + 1;
  }
  console.log('Breakdown <= 19:45 IST:', countsBefore745);

  const countsAfter745 = {};
  for (const l of after745Logs) {
    const k = `${l.scanType}_${l.eventType}`;
    countsAfter745[k] = (countsAfter745[k] || 0) + 1;
  }
  console.log('Breakdown > 19:45 IST:', countsAfter745);

  // Sample of before 7:45 PM logs:
  console.log('\nSample of 10 gate logs before 19:45 IST:');
  for (const l of before745Logs.slice(0, 10)) {
    const dIst = new Date(l.createdAt).toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata' });
    console.log(`  [${dIst}] scanType=${l.scanType}, event=${l.eventType}, reg=${l.registrationId}, gateId=${l.gateId}`);
  }

  // 2. Inspect yesterday night logs (Oct 12 night):
  // Let's say Oct 12 18:00 IST (12:30 UTC) to Oct 13 08:00 IST (02:30 UTC)
  const oct12NightStart = new Date('2026-10-12T12:30:00.000Z');
  const oct13MrngEnd = new Date('2026-10-13T04:30:00.000Z'); // 10:00 IST

  const nightLogs = await GateLog.find({
    createdAt: { $gte: oct12NightStart, $lte: oct13MrngEnd },
    accessGranted: true
  }).sort({ createdAt: 1 }).lean();

  console.log(`\nFound ${nightLogs.length} logs between Oct 12 18:00 IST and Oct 13 10:00 IST.`);
  const nightCounts = {};
  for (const l of nightLogs) {
    const k = `${l.scanType}_${l.eventType}`;
    nightCounts[k] = (nightCounts[k] || 0) + 1;
  }
  console.log('Breakdown Oct 12 night / Oct 13 mrng:', nightCounts);

  // How many unique registrations checked in during Oct 12 night?
  const nightEntries = nightLogs.filter(l => l.scanType === 'gate' && l.eventType === 'entry');
  const nightRegs = [...new Set(nightEntries.map(l => String(l.registrationId)))];
  console.log(`Unique registrations with gate entry on Oct 12 night: ${nightRegs.length}`);

  // How many of them have a gate exit on Oct 12 night or Oct 13 morning?
  const nightExits = nightLogs.filter(l => l.scanType === 'gate' && l.eventType === 'exit');
  const exitedRegs = new Set(nightExits.map(l => String(l.registrationId)));

  const notExitedRegs = nightRegs.filter(r => !exitedRegs.has(r));
  console.log(`Of those ${nightRegs.length}, exited: ${nightRegs.length - notExitedRegs.length}, NOT exited (no gate out): ${notExitedRegs.length}`);

  // What about passes created on Oct 12?
  const passesOct12 = await Pass.find({
    validDate: '2026-10-12',
    passType: 'day_pass'
  }).lean();
  console.log(`Total day_pass on 2026-10-12: ${passesOct12.length}`);
  const openPassesOct12 = passesOct12.filter(p => p.qrPayload?.divisionInside);
  console.log(`Of those on 2026-10-12, still marked divisionInside: true: ${openPassesOct12.length}`);

  // What about passes created on Oct 13?
  const passesOct13 = await Pass.find({
    validDate: '2026-10-13',
    passType: 'day_pass'
  }).lean();
  console.log(`Total day_pass on 2026-10-13: ${passesOct13.length}`);

  await conn.close();
  process.exit(0);
}

run().catch(console.error);
