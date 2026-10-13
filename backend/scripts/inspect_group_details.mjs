import mongoose from 'mongoose';
import GateLog from '../src/models/GateLog.js';
import Pass from '../src/models/Pass.js';
import Registration from '../src/models/Registration.js';

const DB_URI = 'mongodb+srv://teampydah:TeamPydah@teampydah.y4zj6wh.mongodb.net/samslalitha';

async function run() {
  await mongoose.connect(DB_URI);

  // Group 1: Oct 12 night checkins without gate exit
  const g1Entries = await GateLog.find({
    createdAt: {
      $gte: new Date('2026-10-12T12:30:00.000Z'),
      $lte: new Date('2026-10-13T02:00:00.000Z')
    },
    scanType: 'gate',
    eventType: 'entry',
    accessGranted: true
  }).sort({ createdAt: 1 }).lean();

  const g1ByReg = new Map();
  for (const l of g1Entries) {
    const regId = String(l.registrationId);
    if (!g1ByReg.has(regId)) g1ByReg.set(regId, l);
  }

  const g1RegIds = [...g1ByReg.keys()].map(id => new mongoose.Types.ObjectId(id));
  const g1Exits = await GateLog.find({
    registrationId: { $in: g1RegIds },
    scanType: 'gate',
    eventType: 'exit',
    accessGranted: true,
    createdAt: { $gte: new Date('2026-10-12T12:30:00.000Z') }
  }).lean();
  const g1ExitRegIds = new Set(g1Exits.map(l => String(l.registrationId)));

  const g1Pending = [];
  for (const [regId, entryLog] of g1ByReg.entries()) {
    if (!g1ExitRegIds.has(regId)) {
      g1Pending.push({ regId, entryLog });
    }
  }

  const g1RegDocs = await Registration.find({ _id: { $in: g1Pending.map(p => p.regId) } }).lean();
  const regMap1 = new Map(g1RegDocs.map(r => [String(r._id), r]));

  console.log('Group 1 Pending sample 5:');
  for (const p of g1Pending.slice(0, 5)) {
    const r = regMap1.get(p.regId);
    const inTime = new Date(p.entryLog.createdAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    console.log(`  ${r?.registrationCode} - ${r?.displayName} | In: ${inTime} | Div: ${p.entryLog.divisionId}`);
  }

  // Check entry time ranges of Group 1 pending
  const inHours1 = {};
  for (const p of g1Pending) {
    const hr = new Date(p.entryLog.createdAt).toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit' });
    inHours1[hr] = (inHours1[hr] || 0) + 1;
  }
  console.log('Group 1 check-in hours breakdown:', inHours1);

  // Group 2: Oct 13 before 7:45 PM
  const g2Entries = await GateLog.find({
    createdAt: {
      $gte: new Date('2026-10-13T04:30:00.000Z'),
      $lte: new Date('2026-10-13T14:15:00.000Z')
    },
    scanType: 'gate',
    eventType: 'entry',
    accessGranted: true
  }).sort({ createdAt: 1 }).lean();

  const g2ByReg = new Map();
  for (const l of g2Entries) {
    const regId = String(l.registrationId);
    if (!g2ByReg.has(regId)) g2ByReg.set(regId, l);
  }

  const g2RegDocs = await Registration.find({ _id: { $in: [...g2ByReg.keys()] } }).lean();
  const regMap2 = new Map(g2RegDocs.map(r => [String(r._id), r]));

  console.log('\nGroup 2 sample 5:');
  for (const [regId, entryLog] of [...g2ByReg.entries()].slice(0, 5)) {
    const r = regMap2.get(regId);
    const inTime = new Date(entryLog.createdAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    console.log(`  ${r?.registrationCode} - ${r?.displayName} | Scanned: ${inTime} | Div: ${entryLog.divisionId}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(console.error);
