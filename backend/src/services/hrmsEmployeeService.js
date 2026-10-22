import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const EMPLOYEE_PROJECTION = {
  emp_no: 1,
  employee_name: 1,
  email: 1,
};
const HRMS_PASSWORD_HASH_PATTERN = /^\$2[aby]\$\d{2}\$.{53}$/;

let connectionPromise;

async function getEmployeeCollection() {
  const uri = process.env.MONGO_EMPLOYEE_URI;
  if (!uri) {
    const error = new Error('HRMS employee database is not configured');
    error.status = 503;
    throw error;
  }

  if (!connectionPromise) {
    const connection = mongoose.createConnection(uri);
    connectionPromise = connection.asPromise().then(
      () => connection,
      (cause) => {
        connectionPromise = null;
        const error = new Error('Unable to connect to the HRMS employee database');
        error.status = 503;
        error.cause = cause;
        throw error;
      }
    );
  }

  const connection = await connectionPromise;
  return connection.collection('employees');
}

function serializeEmployee(employee) {
  return {
    _id: String(employee._id),
    employeeId: employee.emp_no == null ? '' : String(employee.emp_no).trim(),
    displayName: String(employee.employee_name || '').trim(),
    email: String(employee.email || '').trim().toLowerCase(),
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function searchHrmsEmployees(search, linkedEmployeeIds = []) {
  const collection = await getEmployeeCollection();
  const filter = { is_active: true };
  const normalizedSearch = String(search || '').trim();

  if (normalizedSearch) {
    const pattern = escapeRegex(normalizedSearch);
    filter.$or = [
      { employee_name: new RegExp(pattern, 'i') },
      { email: new RegExp(pattern, 'i') },
      {
        $expr: {
          $regexMatch: {
            input: {
              $convert: {
                input: '$emp_no',
                to: 'string',
                onError: '',
                onNull: '',
              },
            },
            regex: pattern,
            options: 'i',
          },
        },
      },
    ];
  }

  if (linkedEmployeeIds.length > 0) {
    filter._id = { $nin: linkedEmployeeIds.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  const employees = await collection
    .find(filter, { projection: EMPLOYEE_PROJECTION })
    .sort({ employee_name: 1 })
    .limit(50)
    .toArray();

  return employees.map(serializeEmployee);
}

export async function getHrmsEmployeeById(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const collection = await getEmployeeCollection();
  const employee = await collection.findOne(
    { _id: new mongoose.Types.ObjectId(id), is_active: true },
    { projection: { ...EMPLOYEE_PROJECTION, password: 1 } }
  );
  if (!employee) return null;
  return {
    ...serializeEmployee(employee),
    hasHrmsPassword: HRMS_PASSWORD_HASH_PATTERN.test(String(employee.password || '')),
  };
}

export async function verifyHrmsEmployeePassword(id, password) {
  if (!mongoose.Types.ObjectId.isValid(id)) return false;
  const collection = await getEmployeeCollection();
  const employee = await collection.findOne(
    { _id: new mongoose.Types.ObjectId(id), is_active: true },
    { projection: { password: 1 } }
  );
  const passwordHash = employee?.password;
  if (typeof passwordHash !== 'string' || !HRMS_PASSWORD_HASH_PATTERN.test(passwordHash)) {
    return false;
  }
  return bcrypt.compare(password, passwordHash);
}
