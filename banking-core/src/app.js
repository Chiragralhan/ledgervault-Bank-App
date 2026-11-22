const express = require('express');
const cors = require('./middleware/cors');
const ledgerRoutes = require('./routes/ledgerRoutes');
const authRoutes = require('./routes/authRoutes');
const recurringRoutes = require('./routes/recurringRoutes');
const demoRoutes = require('./routes/demoRoutes');

const app = express();
app.use(cors);
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/recurring', recurringRoutes);
app.use('/api/demo', demoRoutes);

module.exports = app;