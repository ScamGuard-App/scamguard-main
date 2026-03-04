require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// simple endpoint used by the client to delete the currently logged-in user.
// the request is POST /delete-account with JSON { user_id: '...' }.
// this handler uses the Supabase service-role key (read from .env) to call
// the admin Users API. Never expose the service key to the browser.
app.post('/delete-account', async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'missing user_id' });

    try {
        const url = `${process.env.SUPABASE_URL}/auth/v1/admin/users/${user_id}`;
        const resp = await fetch(url, {
            method: 'DELETE',
            headers: {
                apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            },
        });
        if (!resp.ok) {
            const text = await resp.text();
            return res.status(resp.status).send(text);
        }
        res.sendStatus(204);
    } catch (err) {
        console.error('delete-user error', err);
        res.status(500).json({ error: 'server error' });
    }
});

// fallback: serve index.html for any unmatched routes (SPA support)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Backend listening on port ${port}`));
