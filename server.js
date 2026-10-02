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

// Ruta de cobro con seguridad bcrypt integrada
app.post('/api/v1/transactions/charge', async (req, res) => {
    const { user_identifier, pin, amount } = req.body;
    const merchantId = req.headers['x-merchant-id'];

    if (!user_identifier || !pin || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Datos incompletos o monto inválido.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Buscamos al usuario, su pin_hash y su saldo
        const userQuery = `
            SELECT u.id, u.pin_hash, u.status, a.id as account_id, a.balance 
            FROM users u
            JOIN accounts a ON u.id = a.user_id
            WHERE u.identifier = $1
        `;
        const userResult = await client.query(userQuery, [user_identifier]);

        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Usuario no encontrado.' });
        }

        const userData = userResult.rows[0];

        // 2. Verificamos el PIN usando bcrypt
        const isPinValid = await bcrypt.compare(pin, userData.pin_hash);
        if (!isPinValid) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'PIN incorrecto.' });
        }

        // 3. Verificamos que tenga saldo suficiente
        const currentBalance = parseFloat(userData.balance);
        const chargeAmount = parseFloat(amount);

        if (currentBalance < chargeAmount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Saldo insuficiente.' });
        }

        const newBalance = currentBalance - chargeAmount;

        // 4. Actualizamos el saldo en la cuenta
        const updateAccountQuery = `
            UPDATE accounts 
            SET balance = $1, updated_at = NOW() 
            WHERE id = $2
        `;
        await client.query(updateAccountQuery, [newBalance, userData.account_id]);

        // 5. Registramos la transacción
        const insertTxQuery = `
            INSERT INTO transactions (account_id, amount, status, description) 
            VALUES ($1, $2, 'success', $3) 
            RETURNING id, created_at
        `;
        const txResult = await client.query(insertTxQuery, [
            userData.account_id, 
            chargeAmount, 
            `Cobro realizado por comercio ${merchantId || 'General'}`
        ]);

        await client.query('COMMIT');

        return res.status(200).json({
            status: "success",
            message: "Pago aprobado con éxito",
            transaction_id: txResult.rows[0].id,
            new_balance: newBalance,
            timestamp: txResult.rows[0].created_at
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error en la transacción de cobro:", error);
        return res.status(500).json({ error: "Error interno del servidor", details: error.message });
    } finally {
        client.release();
    }
});
// Endpoint para consultar el historial de transacciones de un usuario
app.get('/api/v1/transactions/history/:identifier', async (req, res) => {
    const { identifier } = req.params;

    try {
        const userQuery = `SELECT id, full_name, identifier FROM users WHERE identifier = $1`;
        const userResult = await pool.query(userQuery, [identifier]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        const user = userResult.rows[0];

        const txQuery = `
            SELECT t.* 
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            WHERE a.user_id = $1
        `;
        
        const txResult = await pool.query(txQuery, [user.id]);

        return res.status(200).json({
            status: "success",
            user: user.full_name,
            identifier: user.identifier,
            total_transactions: txResult.rows.length,
            transactions: txResult.rows
        });

    } catch (error) {
        console.error("Error al obtener el historial de transacciones:", error);
        // Devolvemos el mensaje real del error para diagnosticar rápido
        return res.status(500).json({ error: "Error interno", details: error.message });
    }
});
