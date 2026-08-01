/**
 * Shared field validators.
 * ─────────────────────────────────────────────────────
 * Every rule here is also enforced in the mobile app so the host gets an
 * instant inline error — but the app is not the security boundary, so the
 * same checks run again on the way in. Each helper returns an error string
 * or null, which keeps the route handlers to a flat list of checks.
 */

// Aadhaar: 12 digits. Spaces and dashes are how people actually type it.
const AADHAAR_RE = /^\d{12}$/;
// PAN: 5 letters, 4 digits, 1 letter — e.g. ABCDE1234F.
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
// IFSC: 4 letters, a literal 0, then 6 alphanumerics — e.g. HDFC0001234.
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
// UPI VPA: handle@bank.
const UPI_RE = /^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/;
const ACCOUNT_RE = /^\d{9,18}$/;

const digitsOnly = (v) => String(v || '').replace(/[\s-]/g, '');

function checkAadhaar(v) {
  const clean = digitsOnly(v);
  if (!clean) return 'Aadhaar number is required';
  if (!AADHAAR_RE.test(clean)) return 'Aadhaar must be exactly 12 digits';
  return null;
}

function checkPan(v) {
  const clean = String(v || '').trim().toUpperCase();
  if (!clean) return 'PAN number is required';
  if (!PAN_RE.test(clean)) return 'PAN must look like ABCDE1234F';
  return null;
}

function checkIfsc(v) {
  const clean = String(v || '').trim().toUpperCase();
  if (!clean) return 'IFSC code is required';
  if (!IFSC_RE.test(clean)) return 'IFSC must look like HDFC0001234';
  return null;
}

function checkAccount(v) {
  const clean = digitsOnly(v);
  if (!clean) return 'Account number is required';
  if (!ACCOUNT_RE.test(clean)) return 'Account number must be 9–18 digits';
  return null;
}

function checkUpi(v) {
  const clean = String(v || '').trim();
  if (!clean) return 'UPI ID is required';
  if (!UPI_RE.test(clean)) return 'UPI ID must look like name@bank';
  return null;
}

/**
 * A payout target is valid if EITHER a full bank triplet OR a UPI ID is
 * present. Half a bank account is the common failure and is rejected.
 */
function checkPayoutMethod({ bank_account_number, ifsc_code, bank_name, upi_id }) {
  const hasBankIntent = !!(bank_account_number || ifsc_code || bank_name);
  const hasUpiIntent = !!upi_id;

  if (!hasBankIntent && !hasUpiIntent) {
    return 'Add a bank account or a UPI ID';
  }

  if (hasBankIntent) {
    const err =
      checkAccount(bank_account_number) ||
      checkIfsc(ifsc_code) ||
      (String(bank_name || '').trim().length < 2 ? 'Bank name is required' : null);
    if (err) return err;
  }

  if (hasUpiIntent) {
    const err = checkUpi(upi_id);
    if (err) return err;
  }

  return null;
}

module.exports = {
  AADHAAR_RE, PAN_RE, IFSC_RE, UPI_RE, ACCOUNT_RE,
  digitsOnly,
  checkAadhaar, checkPan, checkIfsc, checkAccount, checkUpi, checkPayoutMethod,
};
