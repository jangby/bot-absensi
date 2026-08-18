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

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        // Jangan respon status WA atau pesan dari diri sendiri
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

        // ==========================================
        // 🔍 DEBUGGING & PEMBERSIHAN NOMOR WA
        // ==========================================
        console.log("\n[🔍 DETEKTIF WA]");
        console.log("-> remoteJid Asli :", msg.key.remoteJid);
        if (msg.key.participant) console.log("-> Participant Asli :", msg.key.participant);

        // Ambil JID yang paling akurat (Kadang remoteJid berisi ID Grup, participant berisi pengirim)
        let rawJid = msg.key.participant || msg.key.remoteJid;
        
        // Hapus @s.whatsapp.net DAN hapus ID Perangkat (contoh :15)
        let senderNumber = rawJid.split('@')[0].split(':')[0]; 

        console.log("-> Nomor Bersih yang dikirim ke PHP :", senderNumber);
        // ==========================================
        
        // Ambil teks pesan (mendukung pesan biasa maupun pesan reply/extended)
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        
        // ==========================================
        // FITUR SMART WA ASSISTANT (NLP SEDERHANA)
        // ==========================================
        // Cek pola: "Keluar/Masuk [spasi] Angka [spasi] Catatan"
        const regex = /^(keluar|masuk)\s+(\d+)\s+(.*)$/i;
        const match = textMessage.match(regex);

        if (match) {
            const tipeStr = match[1].toLowerCase();
            const tipe = tipeStr === 'keluar' ? 'Pengeluaran' : 'Pemasukan';
            const nominal = match[2];
            const catatan = match[3];

            console.log(`[INFO] Menangkap Perintah: ${tipe} | Rp ${nominal} | ${catatan}`);

            // Kirim notifikasi sedang mengetik...
            await sock.sendPresenceUpdate('composing', msg.key.remoteJid);

            try {
                // KIRIM DATA KE OTAK PHP
                // PASTIKAN URL INI SUDAH BENAR KE HOSTINGER ANDA
                const response = await fetch('https://kas.jagokas.online/api_webhook.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        phone: senderNumber, // Sekarang mengirim nomor yang sudah BERSIH
                        tipe: tipe,
                        nominal: nominal,
                        catatan: catatan
                    })
                });

                const jsonResponse = await response.json();
                
                // Balas pesan ke WhatsApp pengguna
                if (jsonResponse.reply) {
                    await sock.sendMessage(msg.key.remoteJid, { text: jsonResponse.reply });
                }

            } catch (error) {
                console.error("[ERROR Webhook] ", error);
                await sock.sendMessage(msg.key.remoteJid, { text: "❌ Maaf, server KeuanganKu sedang gangguan. Tidak bisa mencatat saat ini." });
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

    if (!sock) {
        return res.status(500).json({ status: false, message: "Bot belum siap, sedang memuat..." });
    }

    try {
        // PENGECEKAN BARU: Pastikan nomor target benar-benar terdaftar di WA
        const [wa_exists] = await sock.onWhatsApp(target);
        
        if (!wa_exists || !wa_exists.exists) {
            console.log(`[API] ❌ Gagal: Nomor ${target} tidak terdaftar di WhatsApp.`);
            return res.status(404).json({ status: false, message: "Nomor tidak terdaftar di WA" });
        }

        // Jika terdaftar, kirim pesannya
        await sock.sendMessage(target, { text: pesan });
        console.log(`[API] ✅ Notifikasi terkirim ke: ${target.split('@')[0]}`);
        
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