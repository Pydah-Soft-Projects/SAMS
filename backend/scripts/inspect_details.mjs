import mongoose from 'mongoose';

const PROD_URI = 'mongodb+srv://teampydah:TeamPydah@teampydah.y4zj6wh.mongodb.net/SMAS';

async function run() {
  const conn = await mongoose.createConnection(PROD_URI, { readPreference: 'secondaryPreferred' }).asPromise();

  const GateLog = conn.model('GateLog', new mongoose.Schema({}, { strict: false }), 'gatelogs');
  const Pass = conn.model('Pass', new mongoose.Schema({}, { strict: false }), 'passes');
  const Registration = conn.model('Registration', new mongoose.Schema({}, { strict: false }), 'registrations');
  const Role = conn.model('Role', new mongoose.Schema({}, { strict: false }), 'roles');
  const Shift = conn.model('Shift', new mongoose.Schema({}, { strict: false }), 'shifts');
  const Gate = conn.model('Gate', new mongoose.Schema({}, { strict: false }), 'gates');
  const Division = conn.model('Division', new mongoose.Schema({}, { strict: false }), 'divisions');

  console.log('\n--- 1. GROUP 1: OCT 12 NIGHT (105 workers) ---');
  const nightEntries = await GateLog.find({
    createdAt: {
      $gte: new Date('2026-10-12T12:30:00.000Z'), // Oct 12 18:00 IST
      $lte: new Date('2026-10-13T02:00:00.000Z')  // Oct 13 07:30 IST
    },
    scanType: 'gate',
    eventType: 'entry',
    accessGranted: true
  }).sort({ createdAt: 1 }).lean();

  const nightRegIds = [...new Set(nightEntries.map(l => String(l.registrationId)))];
  
  // Find their registrations
  const nightRegDocs = await Registration.find({ _id: { $in: nightRegIds } }).lean();
  const regMap1 = new Map(nightRegDocs.map(r => [String(r._id), r]));

  // Inspect shifts of Group 1
  const shiftCounts1 = {};
  for (const r of nightRegDocs) {
    const sId = String(r.shiftId || 'none');
    shiftCounts1[sId] = (shiftCounts1[sId] || 0) + 1;
  }
  console.log('Group 1 shift distribution:', shiftCounts1);

  // Group 1 gate entry time distribution (IST)
  const entryHours1 = {};
  for (const l of nightEntries) {
    const dIst = new Date(l.createdAt).toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit' });
    entryHours1[dIst] = (entryHours1[dIst] || 0) + 1;
  }
  console.log('Group 1 check-in hours:', entryHours1);

  // Inspect 5 sample Group 1 logs
  console.log('Sample 3 Group 1 workers:');
  for (const l of nightEntries.slice(0, 3)) {
    const r = regMap1.get(String(l.registrationId));
    const dIst = new Date(l.createdAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    console.log(`  Reg ${r?.registrationCode} (${r?.displayName}): Entry at ${dIst}, division=${l.divisionId}, gateRefId=${l.gateRefId}, photoPath=${r?.photoPath}`);
  }

  console.log('\n--- 2. GROUP 2: OCT 13 BEFORE 7:45 PM (247 workers) ---');
  const todayEntries = await GateLog.find({
    createdAt: {
      $gte: new Date('2026-10-13T04:30:00.000Z'), // Oct 13 10:00 IST
      $lte: new Date('2026-10-13T14:15:00.000Z')  // Oct 13 19:45 IST
    },
    scanType: 'gate',
    eventType: 'entry',
    accessGranted: true
  }).sort({ createdAt: 1 }).lean();

  const todayRegIds = [...new Set(todayEntries.map(l => String(l.registrationId)))];
  const todayRegDocs = await Registration.find({ _id: { $in: todayRegIds } }).lean();
  const regMap2 = new Map(todayRegDocs.map(r => [String(r._id), r]));

  const shiftCounts2 = {};
  for (const r of todayRegDocs) {
    const sId = String(r.shiftId || 'none');
    shiftCounts2[sId] = (shiftCounts2[sId] || 0) + 1;
  }
  console.log('Group 2 shift distribution:', shiftCounts2);

  const entryHours2 = {};
  for (const l of todayEntries) {
    const dIst = new Date(l.createdAt).toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit' });
    entryHours2[dIst] = (entryHours2[dIst] || 0) + 1;
  }
  console.log('Group 2 entry hours:', entryHours2);

  console.log('Sample 3 Group 2 workers:');
  for (const l of todayEntries.slice(0, 3)) {
    const r = regMap2.get(String(l.registrationId));
    const dIst = new Date(l.createdAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    console.log(`  Reg ${r?.registrationCode} (${r?.displayName}): Scanned at ${dIst}, division=${l.divisionId}, gateRefId=${l.gateRefId}, logPhoto=${l.photoPath}, regPhoto=${r?.photoPath}`);
  }

  // Check what shifts exist
  const allShifts = await Shift.find({}).lean();
  console.log('\nAll shifts in system:');
  for (const s of allShifts) {
    console.log(`  ${s._id}: ${s.name} (${s.slug}), totalHours: ${s.totalHours}`);
  }

  // Check how passes look for Group 1 and Group 2
  const passesG1 = await Pass.find({ registrationId: { $in: nightRegIds }, validDate: '2026-10-12' }).lean();
  console.log(`\nGroup 1 passes on 2026-10-12: ${passesG1.length}`);
  const samplePass1 = passesG1[0];
  if (samplePass1) {
    console.log('Sample Pass 1 qrPayload:', JSON.stringify(samplePass1.qrPayload, null, 2));
  }

  const passesG2 = await Pass.find({ registrationId: { $in: todayRegIds }, validDate: '2026-10-13' }).lean();
  console.log(`\nGroup 2 passes on 2026-10-13: ${passesG2.length}`);
  const samplePass2 = passesG2[0];
  if (samplePass2) {
    console.log('Sample Pass 2 qrPayload:', JSON.stringify(samplePass2.qrPayload, null, 2));
  }

  await conn.close();
  process.exit(0);
}

run().catch(console.error);
