const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');

// ==========================================
// 1. SETUP EXPRESS API SERVER
// ==========================================
const app = express();
app.use(express.json());

// DEKLARASI SOCKET SECARA GLOBAL
let sock; 

// ==========================================
// 2. FUNGSI UTAMA BOT WA (BAILEYS)
// ==========================================
async function startBot() {
    console.log('[DEBUG] Memulai inisialisasi Baileys...');
    
    const { state, saveCreds } = await useMultiFileAuthState('sesi_bot_wa');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Bot Absensi', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n[INFO] ⏳ Silakan Scan QR Code di bawah ini:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('[INFO] Koneksi terputus. Mematikan proses agar PM2 bisa merestart ulang dengan bersih...');
                process.exit(1); 
            } else {
                console.log('[INFO] ❌ Sesi telah di-logout. Silakan hapus folder "sesi_bot_wa" lalu scan ulang.');
                process.exit(0);
            }
        } else if (connection === 'open') {
            console.log('\n====================================');
            console.log('✅ BOT WHATSAPP BERHASIL TERHUBUNG!');
            console.log('====================================\n');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

        // ==========================================
        // 🔍 SIMPAN JID SECARA UTUH
        // ==========================================
        // WhatsApp update terbaru sering menggunakan LID (173766...@lid) 
        // Biarkan formatnya utuh beserta @lid atau @s.whatsapp.net nya
        let senderJid = msg.key.participant || msg.key.remoteJid;
        
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
        const lowerText = textMessage.toLowerCase();

        // Deteksi jika pesan mengandung kode verifikasi
        if (lowerText.includes('link-akun-')) {
            console.log(`[INFO] Permintaan menautkan akun dari ${senderJid} -> Mengirim ke PHP...`);
            await sock.sendPresenceUpdate('composing', msg.key.remoteJid);

            try {
                // ==============================================================
                // PENTING: GANTI DOMAIN DI BAWAH INI DENGAN WEB HOSTINGER ANDA
                // ==============================================================
                const response = await fetch('https://NAMA-DOMAIN-ANDA.com/webhook.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        phone: senderJid, // Kirim format utuh
                        pesan_lengkap: textMessage
                    })
                });

                const jsonResponse = await response.json();
                
                if (jsonResponse.reply) {
                    await sock.sendMessage(msg.key.remoteJid, { text: jsonResponse.reply });
                }

            } catch (error) {
                console.error("[ERROR Webhook] Gagal menghubungi PHP Hostinger:", error.message);
                await sock.sendMessage(msg.key.remoteJid, { text: "❌ Maaf, sistem gagal menautkan akun. Pastikan web sedang online." });
            }
        }
    });
}

// ==========================================
// 3. ENDPOINT UNTUK MENERIMA PERINTAH DARI PHP
// ==========================================
app.post('/kirim-wa', async (req, res) => {
    const { target, pesan } = req.body;

    if (!target || !pesan) {
        return res.status(400).json({ status: false, message: "Target dan pesan wajib diisi!" });
    }

    if (!sock) {
        return res.status(500).json({ status: false, message: "Bot belum siap, sedang memuat..." });
    }

    try {
        // JIKA TARGET BELUM PUNYA @lid ATAU @s.whatsapp.net, TAMBAHKAN MANUAL
        let jid = target;
        if (!jid.includes('@')) {
            jid = jid + '@s.whatsapp.net';
        }

        // LANGSUNG KIRIM PESAN TANPA onWhatsApp() AGAR UID/LID BISA LOLOS
        await sock.sendMessage(jid, { text: pesan });
        console.log(`[API] ✅ Notifikasi terkirim ke: ${jid}`);
        
        res.json({ status: true, message: "Pesan berhasil dikirim" });

    } catch (error) {
        console.error("[API] Gagal mengirim pesan:", error.message);
        res.status(500).json({ status: false, message: "Gagal mengirim pesan" });
    }
});

// ==========================================
// JALANKAN BOT DAN SERVER API
// ==========================================
startBot();

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`[INFO] 🚀 API Server berjalan di http://localhost:${PORT}`);
});