const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const axios = require('axios');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

const db = admin.firestore();
const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

// Middleware to verify Firebase ID token
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

// 1. Auth Signup
app.post('/auth/signup', async (req, res) => {
  try {
    const { uid, username, email, referralCode } = req.body;
    if (!uid || !username || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      return res.status(200).json({ message: 'User already exists', user: userDoc.data() });
    }

    const generatedReferralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    let referredBy = null;

    if (referralCode) {
      const referrerQuery = await db.collection('users').where('referralCode', '==', referralCode).limit(1).get();
      if (!referrerQuery.empty) {
        referredBy = referrerQuery.docs[0].id;
      }
    }

    const newUser = {
      username,
      email,
      wallet: 0,
      totalXP: 0,
      joinedMatches: [],
      referralCode: generatedReferralCode,
      referredBy,
      matchesPlayed: 0,
      totalKills: 0,
      dailyStreak: 0,
      isVIP: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await userRef.set(newUser);
    return res.status(201).json({ message: 'User created successfully', user: newUser });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Create Order (Cashfree)
app.post('/wallet/createOrder', verifyToken, async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.user.uid;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const orderId = `order_${userId}_${Date.now()}`;
    const transactionRef = db.collection('transactions').doc();

    await transactionRef.set({
      userId,
      type: 'deposit',
      amount,
      status: 'PENDING',
      orderId,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    const cashfreeAppId = process.env.CASHFREE_APP_ID;
    const cashfreeSecretKey = process.env.CASHFREE_SECRET_KEY;
    const cashfreeEnv = process.env.CASHFREE_ENV || 'sandbox';

    const baseURL = cashfreeEnv === 'production'
      ? 'https://api.cashfree.com/pg/orders'
      : 'https://sandbox.cashfree.com/pg/orders';

    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data() || {};

    const cashfreeResponse = await axios.post(
      baseURL,
      {
        order_id: orderId,
        order_amount: amount,
        order_currency: 'INR',
        customer_details: {
          customer_id: userId,
          customer_email: userData.email || 'user@example.com',
          customer_phone: '9999999999'
        }
      },
      {
        headers: {
          'x-client-id': cashfreeAppId,
          'x-client-secret': cashfreeSecretKey,
          'x-api-version': '2022-09-01',
          'Content-Type': 'application/json'
        }
      }
    );

    return res.status(200).json({
      orderId,
      paymentSessionId: cashfreeResponse.data.payment_session_id,
      cfOrderId: cashfreeResponse.data.cf_order_id
    });
  } catch (error) {
    console.error('Create order error:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// 3. Cashfree Webhook
app.post('/webhook/cashfree', async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const rawBody = JSON.stringify(req.body);

    const cashfreeSecretKey = process.env.CASHFREE_SECRET_KEY || '';

    if (signature && timestamp && cashfreeSecretKey) {
      const computedSignature = crypto
        .createHmac('sha256', cashfreeSecretKey)
        .update(timestamp + rawBody)
        .digest('base64');

      if (computedSignature !== signature) {
        return res.status(400).json({ error: 'Invalid webhook signature' });
      }
    }

    const event = req.body;
    if (!event || !event.data || !event.data.order) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    const orderData = event.data.order;
    const paymentData = event.data.payment;
    const orderId = orderData.order_id;
    const orderAmount = orderData.order_amount;
    const paymentStatus = paymentData ? paymentData.payment_status : '';

    const txQuery = await db.collection('transactions').where('orderId', '==', orderId).limit(1).get();
    if (txQuery.empty) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const txDoc = txQuery.docs[0];
    const txData = txDoc.data();

    if (txData.status === 'SUCCESS') {
      return res.status(200).json({ message: 'Idempotent success: already processed' });
    }

    await db.runTransaction(async (transaction) => {
      const txRef = txDoc.ref;
      const userRef = db.collection('users').doc(txData.userId);

      if (paymentStatus === 'SUCCESS') {
        transaction.update(txRef, { status: 'SUCCESS' });
        transaction.update(userRef, {
          wallet: admin.firestore.FieldValue.increment(orderAmount)
        });
      } else if (paymentStatus === 'FAILED' || paymentStatus === 'USER_DROPPED') {
        transaction.update(txRef, { status: 'FAILED' });
      }
    });

    return res.status(200).json({ status: 'OK' });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// 4. Match Join
app.post('/match/join', verifyToken, async (req, res) => {
  try {
    const { matchId, gameUids } = req.body;
    const userId = req.user.uid;

    if (!matchId || !gameUids || !Array.isArray(gameUids) || ![1, 2, 4].includes(gameUids.length)) {
      return res.status(400).json({ error: 'Invalid input parameters or team size' });
    }

    const matchRef = db.collection('matches').doc(matchId);
    const userRef = db.collection('users').doc(userId);
    const teamRef = db.collection('matches').doc(matchId).collection('teams').doc(userId);

    await db.runTransaction(async (transaction) => {
      const matchDoc = await transaction.get(matchRef);
      if (!matchDoc.exists) {
        throw new Error('Match not found');
      }

      const matchData = matchDoc.data();
      if (matchData.status !== 'upcoming') {
        throw new Error('Match is not upcoming');
      }

      if ((matchData.joinedCount || 0) >= matchData.maxPlayers) {
        throw new Error('Match is full');
      }

      const existingTeam = await transaction.get(teamRef);
      if (existingTeam.exists) {
        throw new Error('User already joined this match');
      }

      const teamsSnapshot = await transaction.get(matchRef.collection('teams'));
      const allExistingGameUids = new Set();
      teamsSnapshot.forEach(doc => {
        const team = doc.data();
        if (team.gameUids && Array.isArray(team.gameUids)) {
          team.gameUids.forEach(uid => allExistingGameUids.add(uid));
        }
      });

      for (const uid of gameUids) {
        if (allExistingGameUids.has(uid)) {
          throw new Error(`Game UID ${uid} is already registered in this match`);
        }
      }

      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error('User not found');
      }

      const userData = userDoc.data();
      const entryFee = matchData.entryFee || 0;

      if ((userData.wallet || 0) < entryFee) {
        throw new Error('Insufficient wallet balance');
      }

      transaction.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(-entryFee),
        joinedMatches: admin.firestore.FieldValue.arrayUnion(matchId)
      });

      transaction.update(matchRef, {
        joinedCount: admin.firestore.FieldValue.increment(1)
      });

      transaction.set(teamRef, {
        ownerUid: userId,
        ownerUsername: userData.username || 'Player',
        gameUids,
        joinedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const txRef = db.collection('transactions').doc();
      transaction.set(txRef, {
        userId,
        type: 'match_entry',
        amount: -entryFee,
        status: 'SUCCESS',
        matchId,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({ message: 'Successfully joined match' });
  } catch (error) {
    console.error('Match join error:', error);
    return res.status(400).json({ error: error.message || 'Failed to join match' });
  }
});

// 5. Daily Rewards
app.post('/rewards/daily', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const userRef = db.collection('users').doc(userId);

    let newStreak = 0;

    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error('User not found');
      }

      const userData = userDoc.data();
      const lastClaim = userData.lastDailyReward?.toDate();
      const now = new Date();

      if (lastClaim) {
        const diffHours = (now - lastClaim) / (1000 * 60 * 60);
        if (diffHours < 24) {
          throw new Error('Daily reward already claimed within the last 24 hours');
        }
      }

      const dailyRewardAmount = 10;
      const currentStreak = userData.dailyStreak || 0;
      newStreak = currentStreak + 1;

      transaction.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(dailyRewardAmount),
        dailyStreak: newStreak,
        lastDailyReward: admin.firestore.FieldValue.serverTimestamp()
      });

      const txRef = db.collection('transactions').doc();
      transaction.set(txRef, {
        userId,
        type: 'daily_reward',
        amount: dailyRewardAmount,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({ message: 'Daily reward claimed successfully', dailyStreak: newStreak });
  } catch (error) {
    console.error('Daily reward error:', error);
    return res.status(400).json({ error: error.message || 'Failed to claim daily reward' });
  }
});

// 6. Wallet Withdraw
app.post('/wallet/withdraw', verifyToken, async (req, res) => {
  try {
    const { amount, upiId } = req.body;
    const userId = req.user.uid;

    if (!amount || amount <= 0 || !upiId) {
      return res.status(400).json({ error: 'Invalid amount or UPI ID' });
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

// 7. Admin Match Distribute Prizes
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
module.exports = app;

  
