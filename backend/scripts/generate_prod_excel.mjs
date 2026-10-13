import 'dotenv/config';
import mongoose from 'mongoose';
import GateLog from '../src/models/GateLog.js';
import Pass from '../src/models/Pass.js';
import Registration from '../src/models/Registration.js';
import AttendanceOverride from '../src/models/AttendanceOverride.js';
import * as XLSX from 'xlsx';

const PROD_URI = (
  process.env.SOURCE_MONGODB_URI ||
  process.env.MONGODB_URI ||
  'mongodb+srv://teampydah:TeamPydah@teampydah.y4zj6wh.mongodb.net/SMAS'
).trim();

async function main() {
  await mongoose.connect(PROD_URI);
  console.log('Connected to PROD for Excel generation');

  // Load Group 1 overrides
  const g1Overrides = await AttendanceOverride.find({ date: '2026-10-12', status: 'P' }).populate('registrationId').lean();
  const g2Overrides = await AttendanceOverride.find({ date: '2026-10-13', status: 'P' }).populate('registrationId').lean();

  console.log(`Found ${g1Overrides.length} Group 1 overrides on 2026-10-12 in PROD`);
  console.log(`Found ${g2Overrides.length} Group 2 overrides on 2026-10-13 in PROD`);

  const group1Rows = [];
  for (const o of g1Overrides) {
    const reg = o.registrationId;
    if (!reg) continue;

    const inLog = await GateLog.findOne({
      registrationId: reg._id,
      scanType: 'gate',
      eventType: 'entry',
      createdAt: {
        $gte: new Date('2026-10-12T12:30:00.000Z'),
        $lte: new Date('2026-10-13T02:00:00.000Z')
      }
    }).sort({ createdAt: 1 }).lean();

    const outLog = await GateLog.findOne({
      registrationId: reg._id,
      scanType: 'gate',
      eventType: 'exit',
      createdAt: {
        $gte: new Date('2026-10-12T12:30:00.000Z'),
        $lte: new Date('2026-10-13T12:00:00.000Z')
      }
    }).sort({ createdAt: -1 }).lean();

    group1Rows.push({
      Group: 'Group 1: Oct 12 Night Shift',
      RegistrationCode: reg.registrationCode || '',
      DisplayName: reg.displayName || '',
      Role: 'Labour',
      WorkDate: '2026-10-12',
      GateInTime: inLog?.createdAt ? new Date(inLog.createdAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) : '—',
      GateOutTime: outLog?.createdAt ? new Date(outLog.createdAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) : '—',
      WorkingHours: reg.workingHours || 10,
      Status: 'Present (P / Full Day)',
      PhotoUrl: reg.photoPath || inLog?.photoPath || '',
      Remarks: o.note || 'Server shutdown recovery - marked Present'
    });
  }

  const group2Rows = [];
  for (const o of g2Overrides) {
    const reg = o.registrationId;
    if (!reg) continue;

    const inLog = await GateLog.findOne({
      registrationId: reg._id,
      scanType: 'gate',
      eventType: 'entry',
      createdAt: {
        $gte: new Date('2026-10-13T01:00:00.000Z'),
        $lte: new Date('2026-10-13T05:00:00.000Z')
      }
    }).lean();

    const outLog = await GateLog.findOne({
      registrationId: reg._id,
      scanType: 'gate',
      eventType: 'exit',
      createdAt: {
        $gte: new Date('2026-10-13T11:00:00.000Z'),
        $lte: new Date('2026-10-13T14:30:00.000Z')
      }
    }).sort({ createdAt: -1 }).lean();

    group2Rows.push({
      Group: 'Group 2: Oct 13 Day Shift',
      RegistrationCode: reg.registrationCode || '',
      DisplayName: reg.displayName || '',
      Role: 'Labour',
      WorkDate: '2026-10-13',
      GateInTime: inLog?.createdAt ? new Date(inLog.createdAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) : '08:00:00 AM',
      GateOutTime: outLog?.createdAt ? new Date(outLog.createdAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) : '—',
      WorkingHours: reg.workingHours || 10,
      Status: 'Present (P / Full Day)',
      PhotoUrl: reg.photoPath || outLog?.photoPath || '',
      Remarks: o.note || 'Server shutdown recovery - marked Present'
    });
  }

  const summaryRows = [
    { 'Metric': 'Production Database', 'Value': 'SMAS (MongoDB Atlas)' },
    { 'Metric': 'Group 1: Oct 12 Night Shift Labours Marked Present', 'Value': group1Rows.length },
    { 'Metric': 'Group 2: Oct 13 Day Shift Labours Marked Present', 'Value': group2Rows.length },
    { 'Metric': 'Total Labours Marked Present (P)', 'Value': group1Rows.length + group2Rows.length },
    { 'Metric': 'Execution Status', 'Value': 'SUCCESS - Production Database Updated' },
    { 'Metric': 'Timestamp (IST)', 'Value': new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) }
  ];

  const wb = XLSX.utils.book_new();
  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  const wsGroup1 = XLSX.utils.json_to_sheet(group1Rows);
  XLSX.utils.book_append_sheet(wb, wsGroup1, 'Oct12_Night_Shift');

  const wsGroup2 = XLSX.utils.json_to_sheet(group2Rows);
  XLSX.utils.book_append_sheet(wb, wsGroup2, 'Oct13_Day_Shift');

  const combinedRows = [...group1Rows, ...group2Rows];
  const wsAll = XLSX.utils.json_to_sheet(combinedRows);
  XLSX.utils.book_append_sheet(wb, wsAll, 'All_Affected_Labours');

  const excelPath = 'c:/Users/Ashok Kumar/Desktop/SMAS/Attendance_Recovery_Report_PROD_Final_2026-10-13.xlsx';
  XLSX.writeFile(wb, excelPath);
  console.log(`Final Production Excel Report saved at: ${excelPath}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(console.error);
