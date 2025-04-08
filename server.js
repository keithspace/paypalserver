const path = require('path');
const express = require('express');
const braintree = require('braintree');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Initialize Firebase Admin
const serviceAccount = {
  "project_id": process.env.FIREBASE_PROJECT_ID,
  "private_key": process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),  // Make sure to properly format the private key
  "client_email": process.env.FIREBASE_CLIENT_EMAIL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});
const db = admin.firestore();

// Initialize Express
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Braintree Gateway Configuration
const gateway = new braintree.BraintreeGateway({
  environment: braintree.Environment.Sandbox,
  merchantId: process.env.BT_MERCHANT_ID,
  publicKey: process.env.BT_PUBLIC_KEY,
  privateKey: process.env.BT_PRIVATE_KEY,
  paypal: {
    merchantAccountId: process.env.BT_MERCHANT_ACCOUNT_ID,
    currencyIsoCode: 'USD' // Must match your PayPal account currency
  }
});

// --- API Endpoints --- //

// 1. Generate Client Token
// Update your server endpoints to handle both GET and POST for flexibility
app.get('/generate-braintree-token', async (req, res) => {
  try {
    const response = await gateway.clientToken.generate({});
    res.json({ token: response.clientToken });
  } catch (err) {
    console.error('Client token error:', err);
    res.status(500).json({ error: 'Failed to generate client token' });
  }
});

// In server.js
app.post('/generate-braintree-token', async (req, res) => {
  try {
    const response = await gateway.clientToken.generate({
      merchantAccountId: process.env.BT_MERCHANT_ACCOUNT_ID // Ensure this is correctly set up in your Braintree settings
    });
    res.json({ token: response.clientToken });
  } catch (err) {
    console.error('Client token error:', err);
    res.status(500).json({ error: 'Failed to generate client token' });
  }
});

// 2. Process Payment
app.post('/process_payment', async (req, res) => {
  try {
    const { paymentMethodNonce, amount, userId, cartId, sessionId } = req.body;

    // Validate input
    if (!paymentMethodNonce || !amount || !userId || !cartId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Process payment with Braintree
    const saleResult = await gateway.transaction.sale({
      amount: amount,
      paymentMethodNonce: paymentMethodNonce,
      options: {
        submitForSettlement: true,
        storeInVaultOnSuccess: true // Optional for saving payment method
      }
    });

    if (!saleResult.success) {
      return res.status(400).json({
        success: false,
        message: saleResult.message || 'Payment processing failed'
      });
    }

    // Get cart data
    const cartRef = db.collection('customers').doc(userId).collection('cart').doc(cartId);
    const cartSnapshot = await cartRef.get();

    if (!cartSnapshot.exists) {
      return res.status(404).json({ error: 'Cart not found' });
    }

    // Create order document
    const orderData = {
      userId: userId,
      cartId: cartId,
      sessionId: sessionId || null,
      transactionId: saleResult.transaction.id,
      amount: parseFloat(amount),
      products: cartSnapshot.data().products,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: 'Completed',
      paymentMethod: 'PayPal',
      customerEmail: saleResult.transaction.paypal?.payerEmail || null,
      shippingAddress: saleResult.transaction.shippingDetails || null
    };

    // Firestore transaction for atomic updates
    await db.runTransaction(async (transaction) => {
      // Create order
      transaction.set(db.collection('orders').doc(saleResult.transaction.id), orderData);
      
      // Delete cart
      transaction.delete(cartRef);
    });

    res.json({
      success: true,
      transactionId: saleResult.transaction.id,
      amount: amount
    });

  } catch (error) {
    console.error('Payment processing error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// 3. Verify Payment (Optional)
app.get('/verify_payment', async (req, res) => {
  try {
    const transactionId = req.query.transactionId;
    if (!transactionId) {
      return res.status(400).json({ error: 'Transaction ID required' });
    }

    const transaction = await gateway.transaction.find(transactionId);
    res.json({
      isValid: ['settled', 'submitted_for_settlement'].includes(transaction.status),
      status: transaction.status,
      amount: transaction.amount
    });
  } catch (error) {
    res.status(404).json({ isValid: false, error: 'Transaction not found' });
  }
});

// Health Check
app.get('/', (req, res) => {
  res.json({
    status: 'active',
    service: 'Braintree-PayPal Gateway',
    environment: process.env.BT_ENVIRONMENT || 'sandbox'
  });
});

// Start Server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Braintree Environment: ${process.env.BT_ENVIRONMENT || 'sandbox'}`);
});

// Error Handling
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
