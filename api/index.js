const express = require('express');
const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();

// Webhook ke liye raw body signature verification require hoti hai
app.use(express.json());

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ==========================================
// 1. RAZORPAY PAYMENT ENDPOINTS
// ==========================================

// Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, currency } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    const options = {
      amount: Math.round(amount * 100), // Amount in paise
      currency: currency || 'INR',
      receipt: `receipt_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);
    return res.status(200).json({ success: true, order });
  } catch (error) {
    console.error('Error creating Razorpay order:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to create order' });
  }
});

// Razorpay Webhook Endpoint
app.post('/api/webhook', async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'esports_secret_123';
    
    // Verify Webhook Signature
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== req.headers['x-razorpay-signature']) {
      console.error('Invalid Razorpay webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = req.body.event;

    if (event === 'payment.captured') {
      const payment = req.body.payload.payment.entity;
      console.log('Payment Captured Successfully:', payment.id, 'Amount:', payment.amount / 100);

      // Yahan par aap Firestore mein user ka wallet credit kar sakte hain:
      // const userId = payment.notes?.userId;
      // if (userId) {
      //   await db.collection('users').doc(userId).update({
      //     wallet: admin.firestore.FieldValue.increment(payment.amount / 100)
      //   });
      // }
    }

    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ==========================================
// 2. EXISTING WITHDRAWAL & MATCH ROUTES
// ==========================================

// Withdrawal Route (Snippet continuation from your code)
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, upiId } = req.body;
    
    if (!userId || !amount || !upiId) {
      return res.status(400).json({ error: 'Missing withdrawal details' });
    }

    const userRef = db.collection('users').doc(userId);
    const txRef = db.collection('transactions').doc();

    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error('User not found');
      }

      const userData = userDoc.data();
      if ((userData.wallet || 0) < amount) {
        throw new Error('Insufficient wallet balance');
      }

      transaction.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(-amount)
      });

      transaction.set(txRef, {
        userId,
        type: 'withdrawal',
        amount: -amount,
        status: 'PENDING',
        upiId,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({ message: 'Withdrawal request submitted successfully', transactionId: txRef.id });
  } catch (error) {
    console.error('Withdrawal error:', error);
    return res.status(400).json({ error: error.message || 'Failed to process withdrawal' });
  }
});

// Admin Match Distribute Prizes
app.post('/admin/match/distribute', verifyToken, async (req, res) => {
  try {
    const { matchId, gameUid, rank, kills } = req.body;

    if (!matchId || !gameUid || rank === undefined || kills === undefined) {
      return res.status(400).json({ error: 'Missing required distribution fields' });
    }

    const matchRef = db.collection('matches').doc(matchId);

    await db.runTransaction(async (transaction) => {
      const matchDoc = await transaction.get(matchRef);
      if (!matchDoc.exists) {
        throw new Error('Match not found');
      }

      const matchData = matchDoc.data();
      if (matchData.prizeDistributed) {
        throw new Error('Prizes already distributed for this match');
      }

      const teamsSnapshot = await transaction.get(matchRef.collection('teams'));
      let ownerUid = null;

      teamsSnapshot.forEach(doc => {
        const team = doc.data();
        if (team.gameUids && team.gameUids.includes(gameUid)) {
          ownerUid = team.ownerUid;
        }
      });

      if (!ownerUid) {
        throw new Error('Team or Game UID not found in this match');
      }

      const perKillRate = matchData.perKillRate || 0;
      const rankPrizes = matchData.rankPrizes || {};
      const rankPrize = rankPrizes[rank] || rankPrizes[String(rank)] || 0;

      const totalPrize = (kills * perKillRate) + rankPrize;
      const xpEarned = (kills * 50) + (rank === 1 ? 500 : rank <= 3 ? 200 : 50);

      const userRef = db.collection('users').doc(ownerUid);
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        throw new Error('Winner user not found');
      }

      transaction.update(matchRef, { prizeDistributed: true });

      transaction.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(totalPrize),
        totalXP: admin.firestore.FieldValue.increment(xpEarned),
        matchesPlayed: admin.firestore.FieldValue.increment(1),
        totalKills: admin.firestore.FieldValue.increment(kills)
      });

      const txRef = db.collection('transactions').doc();
      transaction.set(txRef, {
        userId: ownerUid,
        type: 'prize_distribution',
        amount: totalPrize,
        status: 'SUCCESS',
        matchId,
        gameUid,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({ message: 'Prize distributed successfully' });
  } catch (error) {
    console.error('Prize distribution error:', error);
    return res.status(400).json({ error: error.message || 'Failed to distribute prize' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
  
