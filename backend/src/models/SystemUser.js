import mongoose from 'mongoose';

const systemUserSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    displayName: { type: String, required: true, trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    hrmsEmployeeId: { type: String, default: undefined },
    systemRoleId: { type: mongoose.Schema.Types.ObjectId, ref: 'SystemRole', default: null },
    isSuperAdmin: { type: Boolean, default: false },
    divisionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Division' }],
    gateIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Gate' }],
    /**
     * Per-gate scan mode for assigned gates.
     * Keys are gate ObjectId strings; values are 'entry' | 'exit' | 'both'.
     * For entry/exit-only gates the mode matches the gate type.
     * For combined (both) gates, admins may restrict operators to entry-only,
     * exit-only, or full entry & exit (both / auto).
     * Missing keys default to full access for that gate's type.
     */
    gateAccessModes: { type: Map, of: String, default: () => new Map() },
    departmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Department' }],
    /**
     * Per-department scan mode for assigned department gates.
     * Keys are department ObjectId strings; values are 'entry' | 'exit' | 'both'.
     * Missing keys default to full check-in & check-out (both / auto).
     */
    departmentAccessModes: { type: Map, of: String, default: () => new Map() },
    /**
     * Permitted geographic zones for this user.
     * Empty array = no restriction (only relevant when geoLocationEnabled is ON).
     * Super Admins always bypass geo checks regardless of this field.
     */
    allowedLocationIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'GeoLocation' }],
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

systemUserSchema.index({ systemRoleId: 1, isActive: 1 });
systemUserSchema.index(
  { hrmsEmployeeId: 1 },
  { unique: true, partialFilterExpression: { hrmsEmployeeId: { $type: 'string' } } }
);

export default mongoose.model('SystemUser', systemUserSchema);
