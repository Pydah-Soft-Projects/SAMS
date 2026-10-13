import mongoose from 'mongoose';
import GateLog from '../src/models/GateLog.js';
import Pass from '../src/models/Pass.js';
import Registration from '../src/models/Registration.js';
import Role from '../src/models/Role.js';
import Shift from '../src/models/Shift.js';

const DB_URI = 'mongodb+srv://teampydah:TeamPydah@teampydah.y4zj6wh.mongodb.net/samslalitha';

async function run() {
  await mongoose.connect(DB_URI);
  console.log('Connected to samslalitha (sandbox DB)');

  // Group 1: Oct 12 night check-ins
  const g1Entries = await GateLog.find({
    createdAt: {
      $gte: new Date('2026-10-12T12:30:00.000Z'),
      $lte: new Date('2026-10-13T02:00:00.000Z')
    },
    scanType: 'gate',
    eventType: 'entry',
    accessGranted: true
  }).sort({ createdAt: 1 }).lean();

  console.log(`\n--- GROUP 1: OCT 12 NIGHT (Found ${g1Entries.length} entries) ---`);
  
  const g1ByReg = new Map();
  for (const l of g1Entries) {
    const regId = String(l.registrationId);
    if (!g1ByReg.has(regId)) {
      g1ByReg.set(regId, l);
    }
  }
  console.log(`Unique registrations in Group 1: ${g1ByReg.size}`);

  const g1RegIds = [...g1ByReg.keys()].map(id => new mongoose.Types.ObjectId(id));
  const g1RegDocs = await Registration.find({ _id: { $in: g1RegIds } }).populate('roleId shiftId').lean();
  const g1RegMap = new Map(g1RegDocs.map(r => [String(r._id), r]));

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
      const reg = g1RegMap.get(regId);
      g1Pending.push({ regId, entryLog, reg });
    }
  }
  console.log(`Group 1 workers needing gate out: ${g1Pending.length}`);

  // Group 2: Oct 13 before 7:45 PM (19:45 IST)
  const g2Entries = await GateLog.find({
    createdAt: {
      $gte: new Date('2026-10-13T04:30:00.000Z'),
      $lte: new Date('2026-10-13T14:15:00.000Z')
    },
    scanType: 'gate',
    eventType: 'entry',
    accessGranted: true
  }).sort({ createdAt: 1 }).lean();

  console.log(`\n--- GROUP 2: OCT 13 BEFORE 7:45 PM (Found ${g2Entries.length} entries) ---`);
  const g2ByReg = new Map();
  for (const l of g2Entries) {
    const regId = String(l.registrationId);
    if (!g2ByReg.has(regId)) {
      g2ByReg.set(regId, l);
    }
  }
  console.log(`Unique registrations in Group 2: ${g2ByReg.size}`);

  const g2RegIds = [...g2ByReg.keys()].map(id => new mongoose.Types.ObjectId(id));
  const g2RegDocs = await Registration.find({ _id: { $in: g2RegIds } }).populate('roleId shiftId').lean();
  const g2RegMap = new Map(g2RegDocs.map(r => [String(r._id), r]));

  // Check roles
  const g1Roles = {};
  for (const p of g1Pending) {
    const rName = p.reg?.roleId?.name || 'unknown';
    g1Roles[rName] = (g1Roles[rName] || 0) + 1;
  }
  console.log('Group 1 Roles:', g1Roles);

  const g2Roles = {};
  for (const [regId] of g2ByReg.entries()) {
    const reg = g2RegMap.get(regId);
    const rName = reg?.roleId?.name || 'unknown';
    g2Roles[rName] = (g2Roles[rName] || 0) + 1;
  }
  console.log('Group 2 Roles:', g2Roles);

  // Group 1: check photos
  let g1WithPhoto = 0;
  for (const p of g1Pending) {
    if (p.reg?.photoPath) g1WithPhoto++;
  }
  console.log(`Group 1 workers with registration photo: ${g1WithPhoto} / ${g1Pending.length}`);

  // Group 2: check photos
  let g2WithPhoto = 0;
  for (const [regId] of g2ByReg.entries()) {
    const reg = g2RegMap.get(regId);
    if (reg?.photoPath) g2WithPhoto++;
  }
  console.log(`Group 2 workers with registration photo: ${g2WithPhoto} / ${g2ByReg.size}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(console.error);
