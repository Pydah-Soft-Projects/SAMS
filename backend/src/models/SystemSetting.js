import mongoose from 'mongoose';

const systemSettingSchema = new mongoose.Schema(
  {
    singleton: {
      type: String,
      default: 'singleton',
      required: true,
      unique: true,
    },
    idleAlerts: {
      enabled: { type: Boolean, default: true },
      dashboardNotifications: { type: Boolean, default: true },
      thresholds: [
        {
          key: { type: String, required: true },
          label: { type: String, required: true },
          minutes: { type: Number, required: true },
          enabled: { type: Boolean, default: true },
        },
      ],
    },
    vehicleSettings: {
      ocrEnabled: { type: Boolean, default: true },
      qrEnabled: { type: Boolean, default: false },
    },
    gateSettings: {
      eyeBlinkVerificationEnabled: { type: Boolean, default: true },
      labourPayCategoryGateEntryOptional: { type: Boolean, default: false },
      hrmsEmployeeCreationEnabled: { type: Boolean, default: true },
      optionalGatePayCategories: {
        type: [String],
        default: ['contract', 'contractor', 'contractors', 'contracters', 'contracter'],
      },
    },
  },
  { timestamps: true }
);

export default mongoose.model('SystemSetting', systemSettingSchema);
