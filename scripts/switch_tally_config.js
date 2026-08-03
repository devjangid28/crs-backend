// Tally Config Switcher
// Usage: node scripts/switch_tally_config.js [local|main]
//   local - switch to localhost for testing on this PC
//   main  - switch back to main PC (192.168.2.2)
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '../.env');
const BACKUP_PATH = path.join(__dirname, '../.env.tally-backup');

const LOCAL_CONFIG = {
  TALLY_HOST: 'localhost',
  TALLY_PORT: '9000',
  TALLY_COMPANY: 'BLUECHIP COMPUTER SYSTEM',
  TALLY_SALES_VOUCHER_TYPE: 'Sales',
  TALLY_SALES_LEDGER: 'Sales',
  TALLY_CGST_LEDGER: 'Output CGST @9%',
  TALLY_SGST_LEDGER: 'Output SGST @9%',
};

const MAIN_CONFIG = {
  TALLY_HOST: '192.168.2.2',
  TALLY_PORT: '9000',
  TALLY_COMPANY: 'BLUECHIP COMPUTER SYSTEM - 2024-25',
  TALLY_SALES_VOUCHER_TYPE: 'Sales Asus',
  TALLY_SALES_LEDGER: 'SALES @ 18%',
  TALLY_CGST_LEDGER: 'OUTPUT CGST @ 9%',
  TALLY_SGST_LEDGER: 'OUTPUT SGST @ 9%',
};

function updateEnv(key, value, content) {
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    return content.replace(regex, `${key}=${value}`);
  }
  return content + `\n${key}=${value}`;
}

function switchConfig(mode) {
  if (!fs.existsSync(ENV_PATH)) {
    console.error('ERROR: .env file not found at', ENV_PATH);
    process.exit(1);
  }

  let envContent = fs.readFileSync(ENV_PATH, 'utf-8');
  const targetConfig = mode === 'local' ? LOCAL_CONFIG : MAIN_CONFIG;

  // Backup current config
  if (!fs.existsSync(BACKUP_PATH)) {
    fs.writeFileSync(BACKUP_PATH, envContent, 'utf-8');
    console.log('Backup saved to .env.tally-backup');
  }

  for (const [key, value] of Object.entries(targetConfig)) {
    envContent = updateEnv(key, value, envContent);
  }

  fs.writeFileSync(ENV_PATH, envContent, 'utf-8');
  console.log(`\nSwitched to ${mode === 'local' ? 'LOCAL' : 'MAIN PC'} Tally config:`);
  for (const [key, value] of Object.entries(targetConfig)) {
    console.log(`  ${key}=${value}`);
  }

  if (mode === 'local') {
    console.log('\nNOTE: Original config backed up to .env.tally-backup');
    console.log('To restore: node scripts/switch_tally_config.js main');
  }
}

const mode = process.argv[2];
if (!mode || !['local', 'main'].includes(mode)) {
  console.log('Usage: node scripts/switch_tally_config.js [local|main]');
  console.log('  local - Switch to localhost Tally (testing on this PC)');
  console.log('  main  - Switch back to main PC Tally (192.168.2.2)');
  process.exit(1);
}

switchConfig(mode);
