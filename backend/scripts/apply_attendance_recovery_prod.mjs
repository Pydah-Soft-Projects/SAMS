/**
 * Production Attendance Recovery Script
 *
 * Repairs attendance for:
 * 1. Group 1: Oct 12 Night Shift check-ins who continued without gate outs
 *    - Generates gate out GateLog with registration photo
 *    - Closes active/open Day Pass for Oct 12
 *    - Sets AttendanceOverride to Present ('P')
 * 2. Group 2: Oct 13 Day Shift workers scanned before 7:45 PM (19:45 IST)
 *    - Converts evening scan direction from gate in to gate out
 *    - Generates morning 08:00 AM gate in GateLog with registration photo
 *    - Closes Day Pass for Oct 13
 *    - Sets AttendanceOverride to Present ('P')
 * 3. Generates/Updates comprehensive Excel audit report.
 *
 * Usage:
 *   node scripts/apply_attendance_recovery_prod.mjs --confirm
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import GateLog from '../src/models/GateLog.js';
import Pass from '../src/models/Pass.js';
import Registration from '../src/models/Registration.js';
import AttendanceOverride from '../src/models/AttendanceOverride.js';
import { getAttendanceHistoryGrid } from '../src/services/registrationReportService.js';
import * as XLSX from 'xlsx';

const CONFIRM = process.argv.includes('--confirm');

const PROD_URI = (
  process.env.SOURCE_MONGODB_URI ||
  process.env.MONGODB_URI ||
  'mongodb+srv://teampydah:TeamPydah@teampydah.y4zj6wh.mongodb.net/SMAS'
).trim();

async function main() {
  console.log('Target Database URI:', PROD_URI.replace(/:([^:@]+)@/, ':***@'));
  if (!CONFIRM) {
    console.error('ERROR: You must pass --confirm to apply changes to Production.');
    console.log('Example: node scripts/apply_attendance_recovery_prod.mjs --confirm');
    process.exit(1);
  }

  console.log('Connecting to Production SMAS...');
  await mongoose.connect(PROD_URI);
  console.log('Connected to Production SMAS!\n');

  // ==========================================
  // 1. IDENTIFY GROUP 1 (Oct 12 Night Check-ins)
  // ==========================================
  const g1Entries = await GateLog.find({
    createdAt: {
      $gte: new Date('2026-10-12T12:30:00.000Z'), // Oct 12 18:00 IST
      $lte: new Date('2026-10-13T02:00:00.000Z')  // Oct 13 07:30 IST
    },
    scanType: 'gate',
    eventType: 'entry',
    accessGranted: true,
    'metadata.autoRecovered': { $ne: true }
  }).sort({ createdAt: 1 }).lean();

  const g1ByReg = new Map();
  for (const l of g1Entries) {
    const regId = String(l.registrationId);
    if (!g1ByReg.has(regId)) g1ByReg.set(regId, l);
  }

  const g1RegIds = [...g1ByReg.keys()].map(id => new mongoose.Types.ObjectId(id));
  const g1RegDocs = await Registration.find({ _id: { $in: g1RegIds } }).populate('roleId shiftId').lean();
  const regMap1 = new Map(g1RegDocs.map(r => [String(r._id), r]));

  console.log(`[PROD] Group 1 Identified: ${g1ByReg.size} night workers`);

  // ==========================================
  // 2. IDENTIFY GROUP 2 (Oct 13 Before 7:45 PM Scans)
  // ==========================================
  const g2Scans = await GateLog.find({
    createdAt: {
      $gte: new Date('2026-10-13T04:30:00.000Z'), // Oct 13 10:00 IST
      $lte: new Date('2026-10-13T14:15:00.000Z')  // Oct 13 19:45 IST
    },
    scanType: 'gate',
    accessGranted: true,
    'metadata.autoRecovered': { $ne: true }
  }).sort({ createdAt: 1 }).lean();

  const g2ByReg = new Map();
  for (const l of g2Scans) {
    const regId = String(l.registrationId);
    if (!g2ByReg.has(regId)) g2ByReg.set(regId, l);
  }

  const g2RegIds = [...g2ByReg.keys()].map(id => new mongoose.Types.ObjectId(id));
  const g2RegDocs = await Registration.find({ _id: { $in: g2RegIds } }).populate('roleId shiftId').lean();
  const regMap2 = new Map(g2RegDocs.map(r => [String(r._id), r]));

  console.log(`[PROD] Group 2 Identified: ${g2ByReg.size} evening workers scanned before 7:45 PM`);

  // ==========================================
  // 3. APPLY REPAIR ON PRODUCTION
  // ==========================================
  console.log('\n--- APPLYING RECOVERY LOGIC ON PRODUCTION ---');

  // Group 1 Recovery:
  let g1OutsCreated = 0;
  let g1PassesUpdated = 0;
  let g1OverridesCreated = 0;
  const group1ReportRows = [];

  for (const [regId, entryLog] of g1ByReg.entries()) {
    const reg = regMap1.get(regId);
    const entryTime = new Date(entryLog.createdAt);
    const hours = Number(reg?.workingHours) || 10;

    let exitLog = await GateLog.findOne({
      registrationId: reg._id,
      scanType: 'gate',
      eventType: 'exit',
      accessGranted: true,
      createdAt: { $gt: entryTime, $lte: new Date('2026-10-13T12:00:00.000Z') }
    });

    let exitTime;
    const isNightEntry = entryTime < new Date('2026-10-12T18:30:00.000Z');
    if (isNightEntry) {
      const targetExit = new Date(entryTime.getTime() + hours * 3600 * 1000);
      const maxExit = new Date('2026-10-13T02:00:00.000Z'); // 07:30 IST
      exitTime = targetExit > maxExit ? maxExit : targetExit;
    } else {
      exitTime = new Date(entryTime.getTime() + hours * 3600 * 1000);
    }

    const photo = reg?.photoPath || entryLog.photoPath || '';

    if (!exitLog) {
      exitLog = await GateLog.create({
        registrationId: reg._id,
        roleId: reg.roleId?._id || reg.roleId || entryLog.roleId,
        divisionId: entryLog.divisionId,
        departmentId: entryLog.departmentId || null,
        gateRefId: entryLog.gateRefId,
        scanType: 'gate',
        eventType: 'exit',
        matchScore: 1.0,
        matched: true,
        accessGranted: true,
        photoPath: photo,
        gateId: entryLog.gateId || 'main',
        remark: 'Gate out generated - server stopped before checkout',
        scannedByName: 'System Auto-Recovery',
        scannedByUsername: 'system',
        metadata: {
          autoRecovered: true,
          recoveryType: 'yesterday_night_no_gate_out',
          sourceEntryLogId: String(entryLog._id),
        },
        createdAt: exitTime,
        updatedAt: exitTime,
      });
      await GateLog.updateOne({ _id: exitLog._id }, { $set: { createdAt: exitTime, updatedAt: exitTime } });
      g1OutsCreated++;
    } else {
      exitTime = new Date(exitLog.createdAt);
    }

    const pass = await Pass.findOne({ registrationId: reg._id, validDate: '2026-10-12' });
    if (pass) {
      pass.isActive = false;
      if (pass.qrPayload) {
        pass.qrPayload.gateExitAt = exitTime.toISOString();
        pass.qrPayload.divisionInside = false;
        pass.qrPayload.updatedAt = exitTime.toISOString();
        pass.markModified('qrPayload');
      }
      await pass.save();
      g1PassesUpdated++;
    }

    await AttendanceOverride.findOneAndUpdate(
      { registrationId: reg._id, date: '2026-10-12' },
      {
        registrationId: reg._id,
        date: '2026-10-12',
        status: 'P',
        note: 'Server down recovery: night shift completed (continued no gate out marked Present)',
        updatedByName: 'System Recovery'
      },
      { upsert: true, new: true }
    );
    g1OverridesCreated++;

    group1ReportRows.push({
      Group: 'Group 1: Oct 12 Night Shift',
      RegistrationCode: reg.registrationCode || '',
      DisplayName: reg.displayName || '',
      Role: reg.roleId?.name || 'Labour',
      WorkDate: '2026-10-12',
      GateInTime: entryTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
      GateOutTime: exitTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
      WorkingHours: hours,
      StatusBefore: 'Absent (No Gate Out)',
      StatusAfter: 'Present (P / Full Day)',
      PhotoUrl: photo,
      ActionTaken: 'Created Gate Out log with Registration Photo, Updated Pass, Set AttendanceOverride to Present'
    });
  }

  console.log(`[PROD] Group 1 Complete: ${g1OutsCreated} Gate Outs created, ${g1PassesUpdated} Passes updated, ${g1OverridesCreated} Overrides set.`);

  // Group 2 Recovery:
  let g2EntriesConvertedToExit = 0;
  let g2MorningInsCreated = 0;
  let g2PassesUpdated = 0;
  let g2OverridesCreated = 0;
  const group2ReportRows = [];

  for (const [regId, scanLog] of g2ByReg.entries()) {
    const reg = regMap2.get(regId);
    const eveningScanTime = new Date(scanLog.createdAt);
    const hours = Number(reg?.workingHours) || 10;
    const morningInTime = new Date('2026-10-13T02:30:00.000Z'); // 08:00 AM IST

    if (scanLog.eventType !== 'exit') {
      await GateLog.updateOne(
        { _id: scanLog._id },
        {
          $set: {
            eventType: 'exit',
            remark: 'Corrected from gate in to actual gate out timing (scanner direction correction)',
            'metadata.correctedFromEntry': true,
            'metadata.originalEventType': scanLog.eventType
          }
        }
      );
      g2EntriesConvertedToExit++;
    }

    const existingMorningIn = await GateLog.findOne({
      registrationId: reg._id,
      scanType: 'gate',
      eventType: 'entry',
      accessGranted: true,
      createdAt: {
        $gte: new Date('2026-10-13T01:00:00.000Z'),
        $lte: new Date('2026-10-13T05:00:00.000Z')
      }
    });

    const photo = reg?.photoPath || scanLog.photoPath || '';

    if (!existingMorningIn) {
      const morningLog = await GateLog.create({
        registrationId: reg._id,
        roleId: reg.roleId?._id || reg.roleId || scanLog.roleId,
        divisionId: scanLog.divisionId,
        gateRefId: scanLog.gateRefId,
        scanType: 'gate',
        eventType: 'entry',
        matchScore: 1.0,
        matched: true,
        accessGranted: true,
        photoPath: photo,
        gateId: scanLog.gateId || 'main',
        remark: 'Morning gate in generated - server down during morning arrival',
        scannedByName: 'System Auto-Recovery',
        scannedByUsername: 'system',
        metadata: {
          autoRecovered: true,
          recoveryType: 'oct13_morning_checkin_recovery',
          associatedExitLogId: String(scanLog._id),
        },
        createdAt: morningInTime,
        updatedAt: morningInTime,
      });
      await GateLog.updateOne({ _id: morningLog._id }, { $set: { createdAt: morningInTime, updatedAt: morningInTime } });
      g2MorningInsCreated++;
    }

    const pass = await Pass.findOne({ registrationId: reg._id, validDate: '2026-10-13' });
    if (pass) {
      pass.isActive = false;
      if (pass.qrPayload) {
        pass.qrPayload.gateEntryAt = morningInTime.toISOString();
        pass.qrPayload.gateExitAt = eveningScanTime.toISOString();
        pass.qrPayload.divisionInside = false;
        pass.qrPayload.updatedAt = eveningScanTime.toISOString();
        pass.markModified('qrPayload');
      }
      await pass.save();
      g2PassesUpdated++;
    }

    await AttendanceOverride.findOneAndUpdate(
      { registrationId: reg._id, date: '2026-10-13' },
      {
        registrationId: reg._id,
        date: '2026-10-13',
        status: 'P',
        note: 'Server down recovery: day shift completed before 7:45 PM (marked Present)',
        updatedByName: 'System Recovery'
      },
      { upsert: true, new: true }
    );
    g2OverridesCreated++;

    group2ReportRows.push({
      Group: 'Group 2: Oct 13 Day Shift',
      RegistrationCode: reg.registrationCode || '',
      DisplayName: reg.displayName || '',
      Role: reg.roleId?.name || 'Labour',
      WorkDate: '2026-10-13',
      GateInTime: morningInTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
      GateOutTime: eveningScanTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
      WorkingHours: hours,
      StatusBefore: 'Absent / Incomplete Scan',
      StatusAfter: 'Present (P / Full Day)',
      PhotoUrl: photo,
      ActionTaken: 'Converted evening scan to Gate Out, Created 08:00 AM Gate In with Registration Photo, Set AttendanceOverride to Present'
    });
  }

  console.log(`[PROD] Group 2 Complete: ${g2EntriesConvertedToExit} converted to Exit, ${g2MorningInsCreated} Morning Ins created, ${g2PassesUpdated} Passes updated, ${g2OverridesCreated} Overrides set.`);

  // ==========================================
  // 4. VERIFY ON PRODUCTION ATTENDANCE GRID
  // ==========================================
  console.log('\n--- VERIFYING ATTENDANCE GRID ON PROD ---');
  const checkSample1 = await getAttendanceHistoryGrid({
    dateFrom: '2026-10-12',
    dateTo: '2026-10-13',
    search: 'WM0075'
  });
  if (checkSample1.employees?.[0]) {
    const e = checkSample1.employees[0];
    console.log(`Verification WM0075 (${e.displayName}):`);
    for (const d of e.days) {
      console.log(`  ${d.date}: status=${d.status}, code=${d.code}, label=${d.label}, in=${d.checkInTime}, out=${d.checkOutTime}`);
    }
  }

  const checkSample2 = await getAttendanceHistoryGrid({
    dateFrom: '2026-10-12',
    dateTo: '2026-10-13',
    search: 'MM0141'
  });
  if (checkSample2.employees?.[0]) {
    const e = checkSample2.employees[0];
    console.log(`Verification MM0141 (${e.displayName}):`);
    for (const d of e.days) {
      console.log(`  ${d.date}: status=${d.status}, code=${d.code}, label=${d.label}, in=${d.checkInTime}, out=${d.checkOutTime}`);
    }
  }

  // ==========================================
  // 5. GENERATE FINAL PRODUCTION EXCEL REPORT
  // ==========================================
  const summaryRows = [
    { 'Category': 'Total Affected Workers (Group 1: Oct 12 Night Shift)', 'Count': group1ReportRows.length },
    { 'Category': 'Total Affected Workers (Group 2: Oct 13 Day Shift)', 'Count': group2ReportRows.length },
    { 'Category': 'Total Combined Labours Marked Present', 'Count': group1ReportRows.length + group2ReportRows.length },
    { 'Category': 'Gate Outs Created with Registration Photos (Group 1)', 'Count': g1OutsCreated },
    { 'Category': 'Morning Gate Ins Created with Registration Photos (Group 2)', 'Count': g2MorningInsCreated },
    { 'Category': 'Evening Scans Converted to Gate Out (Group 2)', 'Count': g2EntriesConvertedToExit },
    { 'Category': 'Attendance Overrides Set to Present (P)', 'Count': g1OverridesCreated + g2OverridesCreated },
    { 'Category': 'Execution Timestamp (IST)', 'Count': new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) },
    { 'Category': 'Database Applied', 'Count': 'SMAS (Production Atlas)' }
  ];

  const wb = XLSX.utils.book_new();
  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  const wsGroup1 = XLSX.utils.json_to_sheet(group1ReportRows);
  XLSX.utils.book_append_sheet(wb, wsGroup1, 'Oct12_Night_Shift');

  const wsGroup2 = XLSX.utils.json_to_sheet(group2ReportRows);
  XLSX.utils.book_append_sheet(wb, wsGroup2, 'Oct13_Day_Shift');

  const combinedRows = [...group1ReportRows, ...group2ReportRows];
  const wsAll = XLSX.utils.json_to_sheet(combinedRows);
  XLSX.utils.book_append_sheet(wb, wsAll, 'All_Affected_Labours');

  const excelPath = 'c:/Users/Ashok Kumar/Desktop/SMAS/Attendance_Recovery_Report_2026-10-13.xlsx';
  XLSX.writeFile(wb, excelPath);
  console.log(`\nExcel report successfully updated at: ${excelPath}`);

  await mongoose.disconnect();
  console.log('Production Recovery Complete!');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
