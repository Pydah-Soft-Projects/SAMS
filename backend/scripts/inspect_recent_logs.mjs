import mongoose from 'mongoose';

const PROD_URI = 'mongodb+srv://teampydah:TeamPydah@teampydah.y4zj6wh.mongodb.net/SMAS';

async function run() {
  const conn = await mongoose.createConnection(PROD_URI, { readPreference: 'secondaryPreferred' }).asPromise();
  console.log('Connected read-only to PROD SMAS');

  const GateLog = conn.model('GateLog', new mongoose.Schema({}, { strict: false }), 'gatelogs');
  const Pass = conn.model('Pass', new mongoose.Schema({}, { strict: false }), 'passes');
  const Shift = conn.model('Shift', new mongoose.Schema({}, { strict: false }), 'shifts');
  const Registration = conn.model('Registration', new mongoose.Schema({}, { strict: false }), 'registrations');
  const Role = conn.model('Role', new mongoose.Schema({}, { strict: false }), 'roles');

  const shifts = await Shift.find({}).lean();
  console.log('\n--- SHIFTS ---');
  for (const s of shifts) {
    console.log(`Shift: ${s.name} (${s.slug}), totalHours: ${s.totalHours}, start: ${s.startTime}, end: ${s.endTime}`);
  }

  const roles = await Role.find({}).lean();
  console.log('\n--- ROLES ---');
  for (const r of roles) {
    console.log(`Role: ${r.name} (${r.slug}), isShiftBased: ${r.isShiftBased}`);
  }

  // Find the latest 20 gate logs to check the date range
  const latestLogs = await GateLog.find({}).sort({ createdAt: -1 }).limit(20).lean();
  console.log('\n--- LATEST 20 GATE LOGS ---');
  for (const l of latestLogs) {
    console.log(`[${l.createdAt}] scanType: ${l.scanType}, event: ${l.eventType}, reg: ${l.registrationId}, granted: ${l.accessGranted}`);
  }

  // Find min and max createdAt for logs in the last 3 days
  const latestDate = latestLogs[0]?.createdAt ? new Date(latestLogs[0].createdAt) : new Date();
  const threeDaysAgo = new Date(latestDate.getTime() - 3 * 24 * 60 * 60 * 1000);

  // Group logs by date (IST YYYY-MM-DD) and eventType
  const stats = await GateLog.aggregate([
    { $match: { createdAt: { $gte: threeDaysAgo }, accessGranted: true } },
    {
      $project: {
        scanType: 1,
        eventType: 1,
        istDate: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$createdAt',
            timezone: '+05:30'
          }
        },
        istHour: {
          $dateToString: {
            format: '%H',
            date: '$createdAt',
            timezone: '+05:30'
          }
        }
      }
    },
    {
      $group: {
        _id: { istDate: '$istDate', istHour: '$istHour', scanType: '$scanType', eventType: '$eventType' },
        count: { $sum: 1 }
      }
    },
    { $sort: { '_id.istDate': 1, '_id.istHour': 1, '_id.scanType': 1, '_id.eventType': 1 } }
  ]);

  console.log('\n--- HOURLY LOG STATS (IST) LAST 3 DAYS ---');
  for (const st of stats) {
    console.log(`${st._id.istDate} ${st._id.istHour}:00 IST | ${st._id.scanType} ${st._id.eventType} : ${st.count}`);
  }

  await conn.close();
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
