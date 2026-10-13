import mongoose from 'mongoose';

const PROD_URI = 'mongodb+srv://teampydah:TeamPydah@teampydah.y4zj6wh.mongodb.net/SMAS';

async function run() {
  const conn = await mongoose.createConnection(PROD_URI, { readPreference: 'secondaryPreferred' }).asPromise();

  const GateLog = conn.model('GateLog', new mongoose.Schema({}, { strict: false }), 'gatelogs');
  const Pass = conn.model('Pass', new mongoose.Schema({}, { strict: false }), 'passes');
  const Registration = conn.model('Registration', new mongoose.Schema({}, { strict: false }), 'registrations');
  const Role = conn.model('Role', new mongoose.Schema({}, { strict: false }), 'roles');
  const Shift = conn.model('Shift', new mongoose.Schema({}, { strict: false }), 'shifts');
  const AttendanceOverride = conn.model('AttendanceOverride', new mongoose.Schema({}, { strict: false }), 'attendanceoverrides');

  const labourRole = await Role.findOne({ name: /labour/i }).lean();
  console.log('Labour role ID:', labourRole?._id);

  // Group 1: Yesterday night checkins (Oct 12)
  // Let's find all registrations who had a gate entry on Oct 12 between 18:00 IST and Oct 13 06:00 IST
  // In UTC: 2026-10-12T12:30:00Z to 2026-10-13T00:30:00Z
  const nightEntries = await GateLog.find({
    createdAt: {
      $gte: new Date('2026-10-12T12:30:00.000Z'),
      $lte: new Date('2026-10-13T02:00:00.000Z') // up to 7:30 AM IST
    },
    scanType: 'gate',
    eventType: 'entry',
    accessGranted: true
  }).sort({ createdAt: 1 }).lean();

  console.log(`\n=== GROUP 1: OCT 12 NIGHT GATE ENTRIES ===`);
  console.log(`Total gate entry logs: ${nightEntries.length}`);

  const nightRegIds = [...new Set(nightEntries.map(l => String(l.registrationId)))];
  console.log(`Unique registrations: ${nightRegIds.length}`);

  // Check how many have a gate exit on Oct 12 or Oct 13
  const nightExits = await GateLog.find({
    registrationId: { $in: nightRegIds },
    scanType: 'gate',
    eventType: 'exit',
    accessGranted: true,
    createdAt: { $gte: new Date('2026-10-12T12:30:00.000Z') }
  }).lean();

  const exitedNightRegIds = new Set(nightExits.map(l => String(l.registrationId)));
  const noGateOutNightRegIds = nightRegIds.filter(id => !exitedNightRegIds.has(id));
  console.log(`Night entries WITH gate out: ${exitedNightRegIds.size}`);
  console.log(`Night entries WITHOUT gate out: ${noGateOutNightRegIds.length}`);

  // Group 2: Today before 7:45 PM (Oct 13)
  // Cutoff is 19:45 IST = 2026-10-13T14:15:00.000Z
  const todayBefore745Entries = await GateLog.find({
    createdAt: {
      $gte: new Date('2026-10-13T04:30:00.000Z'), // from 10:00 AM IST
      $lte: new Date('2026-10-13T14:15:00.000Z')  // to 19:45 IST
    },
    scanType: 'gate',
    eventType: 'entry',
    accessGranted: true
  }).sort({ createdAt: 1 }).lean();

  console.log(`\n=== GROUP 2: OCT 13 BEFORE 7:45 PM GATE ENTRIES ===`);
  console.log(`Total gate entry logs: ${todayBefore745Entries.length}`);
  const todayRegIds = [...new Set(todayBefore745Entries.map(l => String(l.registrationId)))];
  console.log(`Unique registrations: ${todayRegIds.length}`);

  // Let's check overlap between Group 1 (no gate out from night) and Group 2 (today before 7:45 PM entries)
  const overlap = todayRegIds.filter(id => noGateOutNightRegIds.includes(id));
  console.log(`Overlap between Oct 12 night no-gate-out and Oct 13 before 7:45 PM: ${overlap.length}`);

  // Inspect the registrations of Group 2
  const sampleRegs = await Registration.find({ _id: { $in: todayRegIds.slice(0, 10) } }).populate('roleId shiftId').lean();
  console.log('\nSample 5 registrations from Group 2:');
  for (const r of sampleRegs.slice(0, 5)) {
    console.log(`  Reg ${r.registrationCode} (${r.displayName}): role=${r.roleId?.name}, shift=${r.shiftId?.name}, workingHours=${r.workingHours}, photo=${r.photoPath ? 'YES' : 'NO'}`);
  }

  // Check what photos exist in Group 2 gate logs vs registrations
  let logsWithPhoto = 0;
  for (const l of todayBefore745Entries) {
    if (l.photoPath) logsWithPhoto++;
  }
  console.log(`Group 2 gate logs that already have photoPath: ${logsWithPhoto} / ${todayBefore745Entries.length}`);

  // Check existing AttendanceOverrides for Oct 12 and Oct 13
  const overrides12 = await AttendanceOverride.find({ date: '2026-10-12' }).lean();
  const overrides13 = await AttendanceOverride.find({ date: '2026-10-13' }).lean();
  console.log(`\nExisting AttendanceOverrides: Oct 12: ${overrides12.length}, Oct 13: ${overrides13.length}`);

  await conn.close();
  process.exit(0);
}

run().catch(console.error);
