const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const mysql = require('mysql2/promise');
const qrcode = require('qrcode-terminal');
const express = require('express');

// ==========================================
// 1. KONFIGURASI DATABASE MYSQL
// ==========================================
const pool = mysql.createPool({
    host: '145.79.14.91', // Bukan localhost lagi
    user: 'u193532380_absensi',    // User DB di Hostinger
    password: 'Dhuyuand05@',   // Password DB di Hostinger
    database: 'u193532380_absensi',    // Nama DB di Hostinger
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ==========================================
// 2. SETUP EXPRESS API SERVER
// ==========================================
const app = express();
app.use(express.json());

// DEKLARASI SOCKET SECARA GLOBAL
let sock; 

// ==========================================
// 3. FUNGSI UTAMA BOT WA (BAILEYS)
// ==========================================
async function startBot() {
    console.log('[DEBUG] Memulai inisialisasi Baileys...');
    
    const { state, saveCreds } = await useMultiFileAuthState('sesi_bot_wa');

    // Assign ke variabel global 'sock'
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Bot Absensi Sekolah', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n[INFO] ⏳ Silakan Scan QR Code di bawah ini:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('[INFO] Koneksi terputus. Mencoba menyambung ulang...');
                startBot(); // Reconnect
            } else {
                console.log('[INFO] ❌ Sesi telah di-logout. Silakan hapus folder "sesi_bot_wa".');
            }
        } else if (connection === 'open') {
            console.log('\n====================================');
            console.log('✅ BOT WHATSAPP BERHASIL TERHUBUNG!');
            console.log('====================================\n');
        }
    });

    // -----------------------------------------------------
    // LOGIKA MEMBACA PESAN MASUK (VERIFIKASI AKUN)
    // -----------------------------------------------------
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid; 
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        const matchToken = textMessage.match(/LINK-AKUN-(\d+)/);

        if (matchToken) {
            const guru_id = matchToken[1]; 

            try {
                const [result] = await pool.query("UPDATE gurus SET no_hp = ? WHERE id = ?", [sender, guru_id]);

                if (result.affectedRows > 0) {
                    const [rows] = await pool.query("SELECT nama FROM gurus WHERE id = ?", [guru_id]);
                    const nama_guru = rows[0].nama;

                    await sock.sendMessage(sender, { 
                        text: `✅ *VERIFIKASI BERHASIL!*\n\nNomor ini telah resmi tertaut dengan akun Bapak/Ibu *${nama_guru}*.\n\nMulai sekarang, notifikasi kehadiran akan dikirim ke nomor ini.` 
                    });
                    console.log(`[SUKSES] Menautkan WA ke Guru ID ${guru_id}`);
                } else {
                    await sock.sendMessage(sender, { text: `❌ *GAGAL!* ID Akun tidak ditemukan.` });
                }
            } catch (error) {
                console.error("Database error:", error);
            }
        }
    });
}

// -----------------------------------------------------
// ENDPOINT API DITEMPATKAN DI LUAR AGAR SELALU MENGGUNAKAN SOCKET TERBARU
// -----------------------------------------------------
app.post('/kirim-wa', async (req, res) => {
    const { target, pesan } = req.body;

    if (!target || !pesan) {
        return res.status(400).json({ status: false, message: "Target dan pesan wajib diisi!" });
    }

    // Cek apakah socket sudah terinisialisasi dan tersambung
    if (!sock) {
        return res.status(500).json({ status: false, message: "Bot belum siap, sedang memuat..." });
    }

    try {
        await sock.sendMessage(target, { text: pesan });
        console.log(`[API] Notifikasi terkirim ke: ${target.split('@')[0]}`);
        res.json({ status: true, message: "Pesan berhasil dikirim" });
    } catch (error) {
        console.error("[API] Gagal mengirim pesan:", error.message);
        res.status(500).json({ status: false, message: "Gagal mengirim pesan" });
    }
});

// -----------------------------------------------------
// JALANKAN BOT DAN SERVER API
// -----------------------------------------------------
startBot();

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`[INFO] 🚀 API Server berjalan di http://localhost:${PORT}`);
});