import mongoose from 'mongoose';

const PROD_URI = 'mongodb+srv://teampydah:TeamPydah@teampydah.y4zj6wh.mongodb.net/SMAS';

async function run() {
  const conn = await mongoose.createConnection(PROD_URI, { readPreference: 'secondaryPreferred' }).asPromise();

  const GateLog = conn.model('GateLog', new mongoose.Schema({}, { strict: false }), 'gatelogs');
  const Pass = conn.model('Pass', new mongoose.Schema({}, { strict: false }), 'passes');

  // Find a worker who worked night shift on Oct 10 or Oct 11
  // i.e. entry at night (~20:00) and exit next morning (~06:00 - 08:00)
  const sampleNightExit = await GateLog.findOne({
    createdAt: {
      $gte: new Date('2026-10-11T00:00:00.000Z'), // Oct 11 05:30 IST
      $lte: new Date('2026-10-11T03:00:00.000Z')  // Oct 11 08:30 IST
    },
    scanType: 'gate',
    eventType: 'exit',
    accessGranted: true
  }).lean();

  if (sampleNightExit) {
    console.log('Sample normal night exit found:', sampleNightExit);
    const workerLogs = await GateLog.find({
      registrationId: sampleNightExit.registrationId,
      createdAt: {
        $gte: new Date('2026-10-10T12:00:00.000Z'),
        $lte: new Date('2026-10-11T12:00:00.000Z')
      }
    }).sort({ createdAt: 1 }).lean();
    console.log('Worker logs for that night shift:');
    for (const l of workerLogs) {
      console.log(`  [${l.createdAt}] scanType=${l.scanType}, event=${l.eventType}`);
    }

    const workerPasses = await Pass.find({
      registrationId: sampleNightExit.registrationId,
      createdAt: {
        $gte: new Date('2026-10-10T12:00:00.000Z'),
        $lte: new Date('2026-10-11T12:00:00.000Z')
      }
    }).lean();
    console.log('Worker passes for that night shift:', workerPasses.length);
    for (const p of workerPasses) {
      console.log(`  Pass validDate=${p.validDate}, passCode=${p.passCode}, payload=`, p.qrPayload);
    }
  } else {
    console.log('No night exit found on Oct 11 morning');
  }

  // Also check why passesG1 returned 0 on Oct 12:
  // Were passes created on Oct 12 at all?
  const anyPass12 = await Pass.findOne({ validDate: '2026-10-12' }).lean();
  console.log('Any pass on 2026-10-12:', anyPass12 ? anyPass12.validDate : 'NONE');

  const countPasses12 = await Pass.countDocuments({ validDate: '2026-10-12' });
  console.log('Count of passes on 2026-10-12:', countPasses12);

  // Check passes for Oct 12 night workers across any validDate
  const sampleRegId1 = new mongoose.Types.ObjectId('6a5f147b71b4a50c2afd488f'); // SURATH DAKUA
  const passesForSurath = await Pass.find({ registrationId: sampleRegId1 }).sort({ createdAt: -1 }).limit(5).lean();
  console.log('Passes for SURATH DAKUA:');
  for (const p of passesForSurath) {
    console.log(`  validDate=${p.validDate}, validUntil=${p.validUntil}, createdAt=${p.createdAt}, qrPayload.gateEntryAt=${p.qrPayload?.gateEntryAt}`);
  }

  await conn.close();
  process.exit(0);
}

run().catch(console.error);
