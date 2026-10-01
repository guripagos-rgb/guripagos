const express = require('express');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Conexión usando la variable de entorno que pondremos en Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Requerido para conexiones seguras en la nube como Supabase
});

// Ruta de prueba para saber que el servidor está vivo
app.get('/', (req, res) => {
    res.send('¡El servidor de micropagos está funcionando correctamente!');
});

// Ruta de cobro con PIN
app.post('/api/v1/transactions/charge', async (req, res) => {
    const { user_identifier, pin, amount } = req.body;
    const merchantId = req.headers['x-merchant-id'];

    if (!user_identifier || !pin || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Datos incompletos o monto inválido.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const userQuery = `
            SELECT u.id, u.pin_hash, u.status, u.failed_attempts, a.balance 
            FROM users u
            JOIN accounts a ON u.id = a.user_id
            WHERE u.identifier = $1 FOR UPDATE
        `;
        const userResult = await client.query(userQuery, [user_identifier]);

        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Usuario no encontrado.' });
        }

        const user = userResult.rows[0];

        if (user.status !== 'active' || user.failed_attempts >= 3) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Cuenta bloqueada, inactiva o con demasiados intentos fallidos.' });
        }

        const isPinValid = await bcrypt.compare(pin, user.pin_hash);

        if (!isPinValid) {
            await client.query('UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = $1', [user.id]);
            await client.query('COMMIT');
            return res.status(401).json({ error: 'PIN incorrecto.' });
        }

        if (user.failed_attempts > 0) {
            await client.query('UPDATE users SET failed_attempts = 0 WHERE id = $1', [user.id]);
        }

        if (parseFloat(user.balance) < parseFloat(amount)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Saldo insuficiente.' });
        }

        const newBalance = parseFloat(user.balance) - parseFloat(amount);

        await client.query('UPDATE accounts SET balance = $1, updated_at = NOW() WHERE user_id = $2', [newBalance, user.id]);

        const txInsertQuery = `
            INSERT INTO transactions (merchant_id, user_id, amount, status)
            VALUES ($1, $2, $3, 'success')
            RETURNING id, created_at
        `;
        const txResult = await client.query(txInsertQuery, [merchantId || null, user.id, amount]);

        await client.query('COMMIT');

        return res.status(200).json({
            status: 'success',
            message: 'Pago aprobado con éxito',
            transaction_id: txResult.rows[0].id,
            new_balance: newBalance,
            timestamp: txResult.rows[0].created_at
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error procesando el pago:', error);
        return res.status(500).json({ error: 'Error interno del servidor.' });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});