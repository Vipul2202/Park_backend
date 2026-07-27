const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { WALLETS, TRANSACTIONS, USERS } = require('../db/inMemoryDb');
const { authenticate, requireRole } = require('../middleware/auth');

// ── GET /api/v1/wallet ────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  let wallet = WALLETS.find(w => w.user_id === req.user.id);
  if (!wallet) {
    // Auto-create wallet
    wallet = { id: `wallet-${uuidv4().slice(0,8)}`, user_id: req.user.id, balance: 0, bank_account_number: null, ifsc_code: null, upi_id: null, bank_name: null, updated_at: new Date().toISOString() };
    WALLETS.push(wallet);
  }
  res.json({ success: true, wallet });
});

// ── GET /api/v1/wallet/transactions ──────────────────────────────
router.get('/transactions', authenticate, (req, res) => {
  const wallet = WALLETS.find(w => w.user_id === req.user.id);
  if (!wallet) return res.json({ success: true, transactions: [] });
  const txns = TRANSACTIONS.filter(t => t.wallet_id === wallet.id).sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ success: true, count: txns.length, transactions: txns });
});

// ── POST /api/v1/wallet/withdraw ──────────────────────────────────
// Body: { amount }
router.post('/withdraw', authenticate, requireRole('OWNER'), (req, res) => {
  const { amount } = req.body;
  if (!amount || parseFloat(amount) < 100) {
    return res.status(400).json({ success: false, message: 'Minimum withdrawal amount is ₹100' });
  }

  const wallet = WALLETS.find(w => w.user_id === req.user.id);
  if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });
  if (!wallet.bank_account_number && !wallet.upi_id) {
    return res.status(400).json({ success: false, message: 'Please add bank account or UPI ID before withdrawing' });
  }

  const amt = parseFloat(amount);
  if (wallet.balance < amt) {
    return res.status(400).json({ success: false, message: `Insufficient balance. Available: ₹${wallet.balance}` });
  }

  wallet.balance = parseFloat((wallet.balance - amt).toFixed(2));
  wallet.updated_at = new Date().toISOString();

  const txn = {
    id: `tx-${uuidv4().slice(0,8)}`,
    wallet_id: wallet.id,
    type: 'WITHDRAWAL',
    amount: -amt,
    description: `Transfer to ${wallet.bank_name || 'bank'} (A/C ...${wallet.bank_account_number?.slice(-4) || 'UPI'})`,
    status: 'PROCESSING',
    created_at: new Date().toISOString(),
  };
  TRANSACTIONS.push(txn);

  // Simulate processing → completed after 2s
  setTimeout(() => { txn.status = 'COMPLETED'; }, 2000);

  res.json({ success: true, message: `₹${amt} withdrawal initiated. Arrives in 1–2 business days.`, transaction: txn, new_balance: wallet.balance });
});

// ── PUT /api/v1/wallet/bank-details ──────────────────────────────
// Body: { bank_account_number, ifsc_code, bank_name, upi_id }
router.put('/bank-details', authenticate, (req, res) => {
  const { bank_account_number, ifsc_code, bank_name, upi_id } = req.body;
  let wallet = WALLETS.find(w => w.user_id === req.user.id);
  if (!wallet) {
    wallet = { id: `wallet-${uuidv4().slice(0,8)}`, user_id: req.user.id, balance: 0 };
    WALLETS.push(wallet);
  }
  if (bank_account_number) wallet.bank_account_number = bank_account_number;
  if (ifsc_code) wallet.ifsc_code = ifsc_code;
  if (bank_name) wallet.bank_name = bank_name;
  if (upi_id) wallet.upi_id = upi_id;
  wallet.updated_at = new Date().toISOString();
  res.json({ success: true, message: 'Bank details updated', wallet });
});

// ── POST /api/v1/wallet/credit (admin/internal) ───────────────────
router.post('/credit', authenticate, requireRole('ADMIN'), (req, res) => {
  const { user_id, amount, description } = req.body;
  if (!user_id || !amount) return res.status(400).json({ success: false, message: 'user_id and amount required' });

  let wallet = WALLETS.find(w => w.user_id === user_id);
  if (!wallet) {
    wallet = { id: `wallet-${uuidv4().slice(0,8)}`, user_id, balance: 0, updated_at: new Date().toISOString() };
    WALLETS.push(wallet);
  }
  wallet.balance = parseFloat((wallet.balance + parseFloat(amount)).toFixed(2));
  const txn = { id: `tx-${uuidv4().slice(0,8)}`, wallet_id: wallet.id, type: 'EARNING', amount: parseFloat(amount), description: description || 'Admin credit', status: 'SETTLED', created_at: new Date().toISOString() };
  TRANSACTIONS.push(txn);
  res.json({ success: true, message: 'Wallet credited', new_balance: wallet.balance, transaction: txn });
});

module.exports = router;
