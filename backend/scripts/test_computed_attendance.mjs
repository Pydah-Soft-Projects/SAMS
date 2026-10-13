import 'dotenv/config';
import mongoose from 'mongoose';
import { getAttendanceHistoryGrid } from '../src/services/registrationReportService.js';

const PROD_URI = 'mongodb+srv://teampydah:TeamPydah@teampydah.y4zj6wh.mongodb.net/SMAS';

async function run() {
  await mongoose.connect(PROD_URI, { readPreference: 'secondaryPreferred' });

  console.log('\n--- Grid for Group 1 worker: WM0075 ---');
  const grid1 = await getAttendanceHistoryGrid({
    dateFrom: '2026-10-12',
    dateTo: '2026-10-13',
    search: 'WM0075'
  });
  if (grid1.employees?.[0]) {
    const emp = grid1.employees[0];
    console.log(`Worker: ${emp.registrationCode} - ${emp.displayName}`);
    for (const d of emp.days || []) {
      console.log(`  Date ${d.date}: status=${d.status}, code=${d.code}, label=${d.label}, hours=${d.activityHours}, noGateOut=${d.noGateOut}, in=${d.checkInTime}, out=${d.checkOutTime}`);
    }
  }

  console.log('\n--- Grid for Group 2 worker: MM0141 ---');
  const grid2 = await getAttendanceHistoryGrid({
    dateFrom: '2026-10-12',
    dateTo: '2026-10-13',
    search: 'MM0141'
  });
  if (grid2.employees?.[0]) {
    const emp = grid2.employees[0];
    console.log(`Worker: ${emp.registrationCode} - ${emp.displayName}`);
    for (const d of emp.days || []) {
      console.log(`  Date ${d.date}: status=${d.status}, code=${d.code}, label=${d.label}, hours=${d.activityHours}, noGateOut=${d.noGateOut}, in=${d.checkInTime}, out=${d.checkOutTime}`);
    }
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(console.error);
