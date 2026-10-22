import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { createInterface } from 'node:readline/promises';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { ensureSuperAdmin } from '../src/services/superAdminService.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(scriptDirectory, '../.env');
const applyChanges = process.argv.includes('--apply');
const showHelp = process.argv.includes('--help') || process.argv.includes('-h');
const unknownArguments = process.argv.slice(2).filter((arg) => !['--apply', '--help', '-h'].includes(arg));

function printUsage() {
  console.log('Usage: node scripts/seed-super-admin.js --apply');
  console.log('Requires MONGODB_URI. Missing super-admin credentials are prompted securely.');
  console.log('Without --apply, no database changes are made.');
}

async function readUsername() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question('Super Admin username: ')).trim();
  } finally {
    prompt.close();
  }
}

function readHiddenPassword() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'SUPER_ADMIN_PASSWORD is missing and no interactive terminal is available; set it in backend/.env.'
    );
  }

  return new Promise((resolve, reject) => {
    let password = '';
    let settled = false;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    function onKeypress(character, key = {}) {
      if (key.ctrl && key.name === 'c') {
        settled = true;
        cleanup();
        process.stdout.write('\n');
        reject(new Error('Password prompt cancelled'));
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        settled = true;
        cleanup();
        process.stdout.write('\n');
        resolve(password);
        return;
      }

      if (key.name === 'backspace') {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }

      if (!key.ctrl && !key.meta && character) {
        password += character;
        process.stdout.write('*');
      }
    }

    process.stdin.on('keypress', onKeypress);
    process.once('SIGINT', () => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdout.write('\n');
      reject(new Error('Password prompt cancelled'));
    });
    process.stdout.write('Super Admin password: ');
  });
}

function redactConnectionString(message) {
  return message.replace(/mongodb(?:\+srv)?:\/\/[^@\s]+@/gi, 'mongodb+srv://[redacted]@');
}

async function main() {
  const envResult = dotenv.config({ path: envPath });
  if (envResult.error && envResult.error.code !== 'ENOENT') {
    throw envResult.error;
  }

  if (showHelp) {
    printUsage();
    return;
  }
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument: ${unknownArguments[0]}`);
  }
  if (!applyChanges) {
    printUsage();
    return;
  }

  if (!process.env.MONGODB_URI?.trim()) {
    throw new Error('MONGODB_URI must be set in backend/.env before seeding.');
  }
  if (!process.env.SUPER_ADMIN_USERNAME?.trim()) {
    process.env.SUPER_ADMIN_USERNAME = await readUsername();
  }
  if (!process.env.SUPER_ADMIN_USERNAME.trim()) {
    throw new Error('Super Admin username cannot be empty.');
  }
  if (!process.env.SUPER_ADMIN_PASSWORD) {
    process.env.SUPER_ADMIN_PASSWORD = await readHiddenPassword();
  }
  if (!process.env.SUPER_ADMIN_PASSWORD) {
    throw new Error('Super Admin password cannot be empty.');
  }

  await connectDB();
  const result = await ensureSuperAdmin();

  if (result.created) {
    console.log(`Super Admin "${result.username}" created successfully.`);
  } else if (result.passwordReset) {
    console.log(`Super Admin "${result.username}" updated; password set from SUPER_ADMIN_PASSWORD.`);
  } else {
    console.log(`Super Admin "${result.username}" verified.`);
  }
}

try {
  await main();
} catch (error) {
  console.error('Super Admin seed failed:', redactConnectionString(error.message || 'Unknown error'));
  process.exitCode = 1;
} finally {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}
