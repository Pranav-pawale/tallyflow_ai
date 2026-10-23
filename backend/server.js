require('dotenv').config({ override: true });
const express = require('express');
const cors = require('cors');
const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('❌ SQLite Connection Error:', err.message);
    } else {
        console.log('✅ SQLite Database Connected');
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        orgId TEXT,
        userId TEXT,
        fileName TEXT,
        vendorName TEXT,
        invoiceNumber TEXT,
        totalAmount REAL,
        verificationState TEXT,
        fullData TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => { if (err) console.error('Table init error (invoices):', err.message); });

    db.run(`CREATE TABLE IF NOT EXISTS vendors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orgId TEXT,
        rawVendorName TEXT,
        tallyLedgerName TEXT,
        gstin TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(orgId, rawVendorName)
    )`, (err) => { if (err) console.error('Table init error (vendors):', err.message); });
});

// Safe vendor save helper
function saveVendorMapping(orgId, rawVendorName, tallyLedgerName, gstin) {
    const sql = `INSERT INTO vendors (orgId, rawVendorName, tallyLedgerName, gstin) 
                 VALUES (?, ?, ?, ?) 
                 ON CONFLICT(orgId, rawVendorName) 
                 DO UPDATE SET tallyLedgerName = excluded.tallyLedgerName, gstin = excluded.gstin`;
    db.run(sql, [orgId || 'default_org', rawVendorName, tallyLedgerName, gstin || ''], (err) => {
        if (err) console.error('Error saving vendor mapping:', err.message);
    });
}

function getMappedVendorLedger(orgId, rawVendorName) {
    return new Promise((resolve) => {
        if (!rawVendorName) return resolve(null);
        const sql = `SELECT tallyLedgerName FROM vendors 
                     WHERE (orgId = ? OR orgId IS NULL OR orgId = 'default_org') 
                     AND LOWER(TRIM(rawVendorName)) = LOWER(TRIM(?)) 
                     LIMIT 1`;
        db.get(sql, [orgId || 'default_org', rawVendorName.trim()], (err, row) => {
            if (err || !row) resolve(null);
            else resolve(row.tallyLedgerName);
        });
    });
}

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });

const app = express();
const PORT = process.env.PORT || 5000;

// Rate limiting
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { success: false, error: 'Too many requests from this IP, please try again after 15 minutes' }
});

const extractLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, error: 'Upload limit exceeded, please try again later' }
});

app.use(globalLimiter);

// CORS — must sit above all routes
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

// Explicitly answer OPTIONS preflight for every route (Express 5 compatible)
app.options('/{*path}', cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer storage & file validation configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `invoice-${uniqueSuffix}${ext}`);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Invalid file format for ${file.originalname}. Only PNG, JPG, JPEG, WEBP, and PDF files are allowed.`), false);
    }
};

const upload = multer({
    storage: storage,
    limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB limit per file
    fileFilter: fileFilter
});

// Helper: Format bytes to human readable string
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Utility: Escape XML special characters
function escapeXml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe ? String(unsafe) : '';
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Utility: Validate GSTIN format (Indian 15-char standard)
function validateGstin(gstin) {
    if (!gstin) return false;
    const regex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    return regex.test(gstin.trim().toUpperCase());
}

// Utility: Round to 2 decimal places with epsilon to prevent floating-point inaccuracies
function round2(val) {
    return Math.round((Number(val || 0) + Number.EPSILON) * 100) / 100;
}

// Utility: Comprehensive Date Parser that parses ISO, Indian (DD-MM-YYYY), slash, and 8-digit formats
function parseDateParts(rawDate) {
    if (!rawDate) {
        const now = new Date();
        return {
            year: now.getFullYear(),
            month: now.getMonth() + 1,
            day: now.getDate()
        };
    }
    if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
        return {
            year: rawDate.getFullYear(),
            month: rawDate.getMonth() + 1,
            day: rawDate.getDate()
        };
    }
    const s = String(rawDate).trim();
    if (!s) {
        const now = new Date();
        return {
            year: now.getFullYear(),
            month: now.getMonth() + 1,
            day: now.getDate()
        };
    }

    // 1. Strict 8-digit YYYYMMDD
    const ymd8 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (ymd8) {
        const y = parseInt(ymd8[1], 10);
        const m = parseInt(ymd8[2], 10);
        const d = parseInt(ymd8[3], 10);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return { year: y, month: m, day: d };
        }
    }

    // 2. ISO or slashed YYYY-MM-DD or YYYY/MM/DD
    const ymdSep = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
    if (ymdSep) {
        const y = parseInt(ymdSep[1], 10);
        const m = parseInt(ymdSep[2], 10);
        const d = parseInt(ymdSep[3], 10);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return { year: y, month: m, day: d };
        }
    }

    // 3. Indian format DD-MM-YYYY or DD/MM/YYYY or DD-MM-YY or DD/MM/YY
    const dmySep = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
    if (dmySep) {
        const d = parseInt(dmySep[1], 10);
        const m = parseInt(dmySep[2], 10);
        let y = parseInt(dmySep[3], 10);
        if (y < 100) y += 2000;
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return { year: y, month: m, day: d };
        }
    }

    // 4. Named month: e.g. 10-Jan-2025, 10 Jan 2025, 10/Jan/2025
    const monthNames = {
        jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
        jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
    };
    const namedMatch = s.match(/^(\d{1,2})[\s\-\/]([a-zA-Z]{3,9})[\s\-\/](\d{2,4})$/);
    if (namedMatch) {
        const d = parseInt(namedMatch[1], 10);
        const monKey = namedMatch[2].toLowerCase().substring(0, 3);
        const m = monthNames[monKey];
        let y = parseInt(namedMatch[3], 10);
        if (y < 100) y += 2000;
        if (m && d >= 1 && d <= 31) {
            return { year: y, month: m, day: d };
        }
    }

    // 5. Native Date parse
    const dt = new Date(s);
    if (!isNaN(dt.getTime())) {
        return {
            year: dt.getFullYear(),
            month: dt.getMonth() + 1,
            day: dt.getDate()
        };
    }

    // Safe fallback: current date so voucher date is never missing
    const fallbackNow = new Date();
    return {
        year: fallbackNow.getFullYear(),
        month: fallbackNow.getMonth() + 1,
        day: fallbackNow.getDate()
    };
}

// Utility: Indian Date Parsing Helper (formats to ISO YYYY-MM-DD)
function parseIndianDateToISO(rawDate) {
    if (!rawDate) return '';
    const { year, month, day } = parseDateParts(rawDate);
    const yStr = String(year).padStart(4, '0');
    const mStr = String(month).padStart(2, '0');
    const dStr = String(day).padStart(2, '0');
    return `${yStr}-${mStr}-${dStr}`;
}

// Utility: Strict Tally XML Date Formatter
// Formats any date strictly to 8 digits (YYYYMMDD) with no spaces or dashes.
// Never overwrites, clamps, or mutates the user's selected date behind the scenes.
function formatTallyDate(dateInput) {
    const { year, month, day } = parseDateParts(dateInput);
    const yStr = String(year).padStart(4, '0');
    const mStr = String(month).padStart(2, '0');
    const dStr = String(day).padStart(2, '0');
    return `${yStr}${mStr}${dStr}`;
}

// Backward compatibility helper
function useEduSafeDate(dateInput) {
    return formatTallyDate(dateInput);
}

// Backward compatibility alias
function formatDateForTallyXML(isoDateStr) {
    return formatTallyDate(isoDateStr);
}

// Utility: Indian 2-Digit GSTIN State Code Lookup Map (Task 2)
const GSTIN_STATE_MAP = {
    "01": "Jammu & Kashmir",
    "02": "Himachal Pradesh",
    "03": "Punjab",
    "04": "Chandigarh",
    "05": "Uttarakhand",
    "06": "Haryana",
    "07": "Delhi",
    "08": "Rajasthan",
    "09": "Uttar Pradesh",
    "10": "Bihar",
    "11": "Sikkim",
    "12": "Arunachal Pradesh",
    "13": "Nagaland",
    "14": "Manipur",
    "15": "Mizoram",
    "16": "Tripura",
    "17": "Meghalaya",
    "18": "Assam",
    "19": "West Bengal",
    "20": "Jharkhand",
    "21": "Odisha",
    "22": "Chhattisgarh",
    "23": "Madhya Pradesh",
    "24": "Gujarat",
    "26": "Dadra & Nagar Haveli and Daman & Diu",
    "27": "Maharashtra",
    "29": "Karnataka",
    "30": "Goa",
    "31": "Lakshadweep",
    "32": "Kerala",
    "33": "Tamil Nadu",
    "34": "Puducherry",
    "35": "Andaman & Nicobar Islands",
    "36": "Telangana",
    "37": "Andhra Pradesh",
    "38": "Ladakh",
    "97": "Other Territory"
};

// Utility: Dynamically derive Indian state name from 15-digit GSTIN (Task 2)
function getStateFromGstin(gstin, fallback = '') {
    if (gstin && typeof gstin === 'string') {
        const clean = gstin.trim().toUpperCase();
        const code = clean.slice(0, 2);
        if (GSTIN_STATE_MAP[code]) {
            return GSTIN_STATE_MAP[code];
        }
    }
    return fallback || '';
}

// Utility: Extract 10-character PAN from 15-digit GSTIN (Task 2 Step 2A)
function getPanFromGstin(gstin) {
    if (!gstin || typeof gstin !== 'string') return '';
    const clean = gstin.trim().toUpperCase();
    if (clean.length === 15) {
        return clean.slice(2, 12);
    }
    return '';
}

// Utility: Date formatter helper
function getTallyEduSafeDate(dateInput) {
    const { year, month, day } = parseDateParts(dateInput);
    const yStr = String(year).padStart(4, '0');
    const mStr = String(month).padStart(2, '0');
    const dStr = String(day).padStart(2, '0');
    return `${yStr}-${mStr}-${dStr}`;
}

// Utility: Generate TallyPrime Purchase Voucher XML — Invoice Voucher View with Full Item Table (Task 2)
function generateTallyXml(data, options = {}) {
    const rawInvoices = Array.isArray(data) ? data : [data];
    if (rawInvoices.length === 0) return '';

    // 1. Normalize all invoice records
    const normalizedInvoices = rawInvoices.map((inv, idx) => {
        const d = inv || {};
        const invoiceNumber = (d.invoice_number || d.invoiceNumber || `INV-${idx + 1}`).trim();
        // Priority: read exact updated date property from the invoice object
        const rawDate = d.invoiceDate || d.invoice_date || d.date || '';
        const isoDate = parseIndianDateToISO(rawDate);
        const tallyDate = formatTallyDate(rawDate);
        const rawRefDate = d.referenceDate || d.reference_date || d.orderDate || d.order_date || rawDate;
        const tallyRefDate = formatTallyDate(rawRefDate);
        const tallyTime = (d.voucher_time || d.voucherTime || d.time || '').trim();

        const vendorGstin = (d.vendor_gstin || d.supplier_gstin || d.gstin || '').trim().toUpperCase();
        const fallbackState = d.vendor_state || d.supplier_state || d.place_of_supply || d.placeOfSupply || 'Delhi';
        const vendorState = getStateFromGstin(vendorGstin, fallbackState) || fallbackState || 'Delhi';
        const vendorName = (d.vendor_name || d.supplier_name || d.vendorName || 'Vendor Ledger').trim();
        const vendorAddress = (d.vendor_address || d.supplier_address || d.supplierAddress || '').trim();

        // Fix 3: Strict 6-Digit Pincode Only
        const rawPin = (d.vendor_pincode || d.pincode || '').toString().trim();
        let pincode = '';
        if (/^\d{6}$/.test(rawPin)) {
            pincode = rawPin;
        } else {
            const addressMatch = vendorAddress.match(/\b\d{6}\b/);
            if (addressMatch) {
                pincode = addressMatch[0];
            }
        }
        const panNumber = getPanFromGstin(vendorGstin);
        const vendorPhone = (d.vendor_phone || d.phone || '').trim();
        const bankName = (d.bank_name || d.bankName || '').trim();
        const accountNumber = (d.account_number || d.accountNumber || '').trim();
        const ifscCode = (d.ifsc_code || d.ifscCode || '').trim();
        const upiId = (d.upi_id || d.upiId || '').trim();

        const buyerName = (d.buyer_name || d.buyerName || '').trim();
        const buyerGstin = (d.buyer_gstin || d.buyerGstin || '').trim().toUpperCase();
        const buyerState = (d.buyer_state || d.buyerState || '').trim();
        const buyerAddress = (d.buyer_address || d.buyerAddress || '').trim();

        const buyerOrderNo = (d.buyer_order_no || d.buyerOrderNo || '').trim();
        const orderDate = d.order_date || d.orderDate || '';
        const dueDate = d.due_date || d.dueDate || '';
        const paymentMode = (d.payment_mode || d.paymentMode || '').trim();
        const reverseCharge = (d.reverse_charge || d.reverseCharge || 'No').trim();
        const supplierRef = (d.supplier_ref || d.supplierRef || '').trim();
        const vehicleNo = (d.vehicle_no || d.vehicleNumber || d.vehicle_number || '').trim();
        const ewayBillNo = (d.eway_bill_no || d.ewayBillNo || '').trim();

        const rawItems = d.line_items || d.items || [];
        let lineItems = [];
        if (Array.isArray(rawItems) && rawItems.length > 0) {
            lineItems = rawItems.map(item => {
                const desc = (item.description || item.itemName || item.name || 'Item').trim();
                const hsn = String(item.hsn_code ?? item.hsn_sac ?? item.hsn ?? '').trim();
                const qty = Number(item.quantity ?? item.qty ?? 1);
                const uom = String(item.uom || item.unit || 'Nos').trim() || 'Nos';
                let rate = Number(item.rate ?? 0);
                const disc = Number(item.discount_percent ?? item.discount ?? 0);
                let tv = Number(item.taxable_value ?? item.taxableValue ?? 0);
                if (tv <= 0 && qty > 0 && rate > 0) {
                    tv = Math.round(qty * rate * (1 - disc / 100) * 100) / 100;
                }
                if (rate <= 0 && tv > 0 && qty > 0) {
                    rate = Math.round((tv / qty) * 100) / 100;
                }

                let gstRate = item.gst_rate ?? item.gstRate ?? item.tax_rate ?? item.taxRate;
                if (gstRate == null && (item.cgst_rate != null && item.sgst_rate != null)) {
                    gstRate = Number(item.cgst_rate) + Number(item.sgst_rate);
                }
                if (gstRate == null && (item.cgst_amount || item.sgst_amount || item.igst_amount) && tv > 0) {
                    const itemTax = Number(item.cgst_amount || 0) + Number(item.sgst_amount || 0) + Number(item.igst_amount || 0);
                    gstRate = Math.round((itemTax / tv) * 100);
                }
                if (gstRate == null) gstRate = 18;

                const cgstAmt = Number(item.cgst_amount ?? 0);
                const sgstAmt = Number(item.sgst_amount ?? 0);
                const igstAmt = Number(item.igst_amount ?? 0);
                const totAmt = Number(item.total_amount ?? item.total ?? (tv + cgstAmt + sgstAmt + igstAmt));

                return {
                    description: desc,
                    hsn_code: hsn,
                    quantity: qty,
                    uom,
                    rate,
                    discount_percent: disc,
                    taxable_value: tv,
                    gst_rate: Number(gstRate),
                    cgst_amount: cgstAmt,
                    sgst_amount: sgstAmt,
                    igst_amount: igstAmt,
                    total_amount: totAmt
                };
            });
        }

        // If lineItems is completely empty, create a fallback item so the item table is always populated
        if (lineItems.length === 0) {
            let fallbackRate = parseFloat(d.total_taxable ?? d.taxable_amount ?? d.taxableAmount ?? 0);
            if (fallbackRate <= 0) {
                fallbackRate = parseFloat(d.grand_total ?? d.totalAmount ?? 0);
            }
            fallbackRate = Number(fallbackRate.toFixed(2));
            lineItems.push({
                description: 'General Purchase',
                hsn_code: '',
                quantity: 1,
                uom: 'Nos',
                rate: fallbackRate,
                discount_percent: 0,
                taxable_value: fallbackRate,
                gst_rate: 18,
                cgst_amount: 0,
                sgst_amount: 0,
                igst_amount: 0,
                total_amount: fallbackRate
            });
        }

        // Fix 3: Strict Pre-Export Debit === Credit Math Enforcer
        // Calculate sumItemsTaxable = line_items.reduce((acc, item) => acc + Number(Number(item.taxable_value).toFixed(2)), 0)
        let sumItemsTaxable = lineItems.reduce((acc, item) => acc + Number(Number(item.taxable_value).toFixed(2)), 0);
        sumItemsTaxable = Number(sumItemsTaxable.toFixed(2));

        let totalTaxable = sumItemsTaxable;
        let totalCgst = Number(Number(d.total_cgst ?? d.taxBreakdown?.cgst ?? d.cgst_amount ?? 0).toFixed(2));
        let totalSgst = Number(Number(d.total_sgst ?? d.taxBreakdown?.sgst ?? d.sgst_amount ?? 0).toFixed(2));
        let totalIgst = Number(Number(d.total_igst ?? d.taxBreakdown?.igst ?? d.igst_amount ?? 0).toFixed(2));
        let freightCharges = Number(Number(d.freight_charges ?? d.freightCharges ?? d.freight ?? 0).toFixed(2));
        let roundOff = Number(Number(d.round_off ?? d.roundoff_amount ?? d.roundoffAmount ?? 0).toFixed(2));
        let grandTotal = Number(Number(d.grand_total ?? d.totalAmount ?? 0).toFixed(2));

        const taxesSum = Number((totalCgst + totalSgst + totalIgst + freightCharges).toFixed(2));
        const subtotal = Number((sumItemsTaxable + taxesSum).toFixed(2));

        if (grandTotal <= 0) {
            grandTotal = Number((subtotal + roundOff).toFixed(2));
        }

        // Verify that Number((sumItemsTaxable + totalCgst + totalSgst + totalIgst + freight + roundOff).toFixed(2)) === Number(grandTotal.toFixed(2)).
        // If there is a difference (e.g., due to edited line items), automatically set roundOff = Number((grandTotal - (sumItemsTaxable + totalCgst + totalSgst + totalIgst + freight)).toFixed(2)) so TallyPrime NEVER encounters a Debit/Credit mismatch exception.
        const calculatedDebits = Number((sumItemsTaxable + totalCgst + totalSgst + totalIgst + freightCharges + roundOff).toFixed(2));
        if (calculatedDebits !== Number(grandTotal.toFixed(2))) {
            roundOff = Number((grandTotal - (sumItemsTaxable + totalCgst + totalSgst + totalIgst + freightCharges)).toFixed(2));
        }

        // Strictly ensure total debits equal total credits to the exact paisa
        grandTotal = Number((sumItemsTaxable + totalCgst + totalSgst + totalIgst + freightCharges + roundOff).toFixed(2));

        // Rich audit trail narration
        const auditParts = [];
        auditParts.push(`Invoice No: ${invoiceNumber}`);
        if (isoDate || rawDate) auditParts.push(`Original Date: ${isoDate || rawDate}`);
        if (buyerOrderNo) auditParts.push(`Order No: ${buyerOrderNo}`);
        if (vehicleNo) auditParts.push(`Vehicle No: ${vehicleNo}`);
        if (supplierRef) auditParts.push(`Supplier Ref: ${supplierRef}`);
        if (buyerName) auditParts.push(`Buyer: ${buyerName}${buyerGstin ? ` (${buyerGstin})` : ''}`);

        const bankParts = [];
        if (bankName) bankParts.push(`Bank: ${bankName}`);
        if (accountNumber) bankParts.push(`A/c: ${accountNumber}`);
        if (ifscCode) bankParts.push(`IFSC: ${ifscCode}`);
        if (upiId) bankParts.push(`UPI: ${upiId}`);
        if (bankParts.length > 0) auditParts.push(`Supplier Bank: [${bankParts.join(', ')}]`);

        const hsnSummarySet = new Set();
        lineItems.forEach(it => {
            if (it.hsn_code) {
                hsnSummarySet.add(`${it.hsn_code} (${it.gst_rate}%)`);
            }
        });
        if (hsnSummarySet.size > 0) {
            auditParts.push(`HSN summary: ${Array.from(hsnSummarySet).join(', ')}`);
        }

        const autoNarration = auditParts.join(' | ');
        const finalNarration = d.narration && !d.narration.startsWith('Purchase from')
            ? `${d.narration} | ${autoNarration}`
            : autoNarration;

        return {
            invoiceNumber,
            isoDate,
            tallyDate,
            tallyRefDate,
            tallyTime,
            vendorName,
            vendorGstin,
            vendorState,
            vendorAddress,
            pincode,
            panNumber,
            buyerName,
            buyerGstin,
            buyerState,
            buyerAddress,
            buyerOrderNo,
            supplierRef,
            vehicleNo,
            lineItems,
            totalTaxable,
            totalCgst,
            totalSgst,
            totalIgst,
            freightCharges,
            roundOff,
            grandTotal,
            narration: finalNarration
        };
    });

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<ENVELOPE>\n`;
    xml += `  <HEADER>\n`;
    xml += `    <TALLYREQUEST>Import Data</TALLYREQUEST>\n`;
    xml += `  </HEADER>\n`;
    xml += `  <BODY>\n`;
    xml += `    <IMPORTDATA>\n`;
    xml += `      <REQUESTDESC>\n`;
    xml += `        <REPORTNAME>All Masters</REPORTNAME>\n`;
    xml += `      </REQUESTDESC>\n`;
    xml += `      <REQUESTDATA>\n`;

    // ── STEP 2B: MASTER BLOCK 1 — Auto-Create Unique <UNIT> Masters First ─────
    const emittedUnits = new Set();
    normalizedInvoices.forEach(inv => {
        inv.lineItems.forEach(item => {
            const uom = item.uom || 'Nos';
            if (!emittedUnits.has(uom)) {
                emittedUnits.add(uom);
                xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
                xml += `          <UNIT ACTION="Create" NAME="${escapeXml(uom)}">\n`;
                xml += `            <NAME>${escapeXml(uom)}</NAME>\n`;
                xml += `            <ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>\n`;
                xml += `          </UNIT>\n`;
                xml += `        </TALLYMESSAGE>\n`;
            }
        });
    });

    // ── STEP 2C: MASTER BLOCK 2 — Auto-Create Party, Purchase Slab, Tax, Freight & Round-Off <LEDGER> Masters
    // 1. Party Ledger (Sundry Creditors)
    const emittedVendors = new Set();
    normalizedInvoices.forEach(inv => {
        if (!emittedVendors.has(inv.vendorName)) {
            emittedVendors.add(inv.vendorName);
            const regType = inv.vendorGstin ? 'Regular' : 'Unregistered';
            xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
            xml += `          <LEDGER NAME="${escapeXml(inv.vendorName)}" ACTION="Create">\n`;
            xml += `            <NAME.LIST>\n`;
            xml += `              <NAME>${escapeXml(inv.vendorName)}</NAME>\n`;
            xml += `            </NAME.LIST>\n`;
            xml += `            <PARENT>Sundry Creditors</PARENT>\n`;
            xml += `            <ISBILLWISEON>Yes</ISBILLWISEON>\n`;
            xml += `            <COUNTRYNAME>India</COUNTRYNAME>\n`;
            xml += `            <LEDSTATENAME>${escapeXml(inv.vendorState)}</LEDSTATENAME>\n`;
            if (inv.pincode && /^\d{6}$/.test(String(inv.pincode).trim())) {
                xml += `            <PINCODE>${escapeXml(String(inv.pincode).trim())}</PINCODE>\n`;
            }
            xml += `            <INCOMETAXNUMBER>${escapeXml(inv.panNumber)}</INCOMETAXNUMBER>\n`;
            xml += `            <GSTREGISTRATIONTYPE>${regType}</GSTREGISTRATIONTYPE>\n`;
            xml += `            <PARTYGSTIN>${escapeXml(inv.vendorGstin)}</PARTYGSTIN>\n`;
            xml += `            <ADDRESS.LIST>\n`;
            xml += `              <ADDRESS>${escapeXml(inv.vendorAddress)}</ADDRESS>\n`;
            xml += `            </ADDRESS.LIST>\n`;
            xml += `          </LEDGER>\n`;
            xml += `        </TALLYMESSAGE>\n`;
        }
    });

    // 2. Purchase Slab Ledgers (Purchase @ ${rate}%)
    // CRITICAL: Do NOT include <TAXCLASSIFICATIONNAME> (it causes missing master exceptions in TallyPrime 4.0+)
    const emittedSlabs = new Set();
    normalizedInvoices.forEach(inv => {
        inv.lineItems.forEach(item => {
            const slabName = `Purchase @ ${item.gst_rate}%`;
            if (!emittedSlabs.has(slabName)) {
                emittedSlabs.add(slabName);
                xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
                xml += `          <LEDGER NAME="${escapeXml(slabName)}" ACTION="Create">\n`;
                xml += `            <NAME.LIST>\n`;
                xml += `              <NAME>${escapeXml(slabName)}</NAME>\n`;
                xml += `            </NAME.LIST>\n`;
                xml += `            <PARENT>Purchase Accounts</PARENT>\n`;
                xml += `            <ISGSTAPPLICABLE>Applicable</ISGSTAPPLICABLE>\n`;
                xml += `          </LEDGER>\n`;
                xml += `        </TALLYMESSAGE>\n`;
            }
        });
    });

    // 3. Tax & Additional Ledgers
    const hasCgst = normalizedInvoices.some(inv => inv.totalCgst > 0);
    const hasSgst = normalizedInvoices.some(inv => inv.totalSgst > 0);
    const hasIgst = normalizedInvoices.some(inv => inv.totalIgst > 0);
    const hasFreight = normalizedInvoices.some(inv => inv.freightCharges > 0);
    const hasRoundOff = normalizedInvoices.some(inv => Math.abs(inv.roundOff) > 0.0001);

    if (hasCgst) {
        xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
        xml += `          <LEDGER NAME="Input CGST" ACTION="Create">\n`;
        xml += `            <NAME.LIST>\n`;
        xml += `              <NAME>Input CGST</NAME>\n`;
        xml += `            </NAME.LIST>\n`;
        xml += `            <PARENT>Duties &amp; Taxes</PARENT>\n`;
        xml += `          </LEDGER>\n`;
        xml += `        </TALLYMESSAGE>\n`;
    }

    if (hasSgst) {
        xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
        xml += `          <LEDGER NAME="Input SGST" ACTION="Create">\n`;
        xml += `            <NAME.LIST>\n`;
        xml += `              <NAME>Input SGST</NAME>\n`;
        xml += `            </NAME.LIST>\n`;
        xml += `            <PARENT>Duties &amp; Taxes</PARENT>\n`;
        xml += `          </LEDGER>\n`;
        xml += `        </TALLYMESSAGE>\n`;
    }

    if (hasIgst) {
        xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
        xml += `          <LEDGER NAME="Input IGST" ACTION="Create">\n`;
        xml += `            <NAME.LIST>\n`;
        xml += `              <NAME>Input IGST</NAME>\n`;
        xml += `            </NAME.LIST>\n`;
        xml += `            <PARENT>Duties &amp; Taxes</PARENT>\n`;
        xml += `          </LEDGER>\n`;
        xml += `        </TALLYMESSAGE>\n`;
    }

    if (hasFreight) {
        xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
        xml += `          <LEDGER NAME="Freight &amp; Packing Charges" ACTION="Create">\n`;
        xml += `            <NAME.LIST>\n`;
        xml += `              <NAME>Freight &amp; Packing Charges</NAME>\n`;
        xml += `            </NAME.LIST>\n`;
        xml += `            <PARENT>Direct Expenses</PARENT>\n`;
        xml += `          </LEDGER>\n`;
        xml += `        </TALLYMESSAGE>\n`;
    }

    if (hasRoundOff) {
        xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
        xml += `          <LEDGER NAME="Round Off" ACTION="Create">\n`;
        xml += `            <NAME.LIST>\n`;
        xml += `              <NAME>Round Off</NAME>\n`;
        xml += `            </NAME.LIST>\n`;
        xml += `            <PARENT>Indirect Expenses</PARENT>\n`;
        xml += `          </LEDGER>\n`;
        xml += `        </TALLYMESSAGE>\n`;
    }

    // ── STEP 2D: MASTER BLOCK 3 — Auto-Create <STOCKITEM> Masters with HSN Details ──
    const emittedStockItems = new Set();
    normalizedInvoices.forEach(inv => {
        inv.lineItems.forEach(item => {
            const itemName = item.description || 'Item';
            if (!emittedStockItems.has(itemName)) {
                emittedStockItems.add(itemName);
                const uom = item.uom || 'Nos';
                const hsnCode = item.hsn_code || '';
                xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
                xml += `          <STOCKITEM NAME="${escapeXml(itemName)}" ACTION="Create">\n`;
                xml += `            <NAME.LIST>\n`;
                xml += `              <NAME>${escapeXml(itemName)}</NAME>\n`;
                xml += `            </NAME.LIST>\n`;
                xml += `            <BASEUNITS>${escapeXml(uom)}</BASEUNITS>\n`;
                xml += `            <GSTAPPLICABLE>Applicable</GSTAPPLICABLE>\n`;
                xml += `            <HSNDETAILS.LIST>\n`;
                xml += `              <HSNCODE>${escapeXml(hsnCode)}</HSNCODE>\n`;
                xml += `              <SRCOFHSNDETAILS>Specify Details Here</SRCOFHSNDETAILS>\n`;
                xml += `            </HSNDETAILS.LIST>\n`;
                xml += `          </STOCKITEM>\n`;
                xml += `        </TALLYMESSAGE>\n`;
            }
        });
    });

    // ── STEP 2E: TRANSACTION BLOCK — Emit <VOUCHER> in "Invoice Voucher View" ───────
    // Fix 1: All <ALLINVENTORYENTRIES.LIST> blocks first (contiguous), followed immediately
    // by all <LEDGERENTRIES.LIST> blocks (Party + Taxes + Freight + Round Off) in one unbroken sequence.
    normalizedInvoices.forEach(inv => {
        const strictDate = (inv.tallyDate && /^\d{8}$/.test(inv.tallyDate))
            ? inv.tallyDate
            : formatTallyDate(inv.rawDate || inv.isoDate);
        const tallyRefDate = (inv.tallyRefDate && /^\d{8}$/.test(inv.tallyRefDate))
            ? inv.tallyRefDate
            : strictDate;

        xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
        xml += `          <VOUCHER VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Invoice Voucher View">\n`;
        xml += `            <DATE>${strictDate}</DATE>\n`;
        xml += `            <EFFECTIVEDATE>${strictDate}</EFFECTIVEDATE>\n`;
        xml += `            <REFERENCEDATE>${tallyRefDate}</REFERENCEDATE>\n`;
        xml += `            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>\n`;
        xml += `            <VOUCHERNUMBER>${escapeXml(inv.invoiceNumber)}</VOUCHERNUMBER>\n`;
        xml += `            <REFERENCE>${escapeXml(inv.invoiceNumber)}</REFERENCE>\n`;
        xml += `            <PARTYLEDGERNAME>${escapeXml(inv.vendorName)}</PARTYLEDGERNAME>\n`;
        xml += `            <PARTYNAME>${escapeXml(inv.vendorName)}</PARTYNAME>\n`;
        xml += `            <BASICBASEPARTYNAME>${escapeXml(inv.vendorName)}</BASICBASEPARTYNAME>\n`;
        xml += `            <PARTYGSTIN>${escapeXml(inv.vendorGstin || '')}</PARTYGSTIN>\n`;
        xml += `            <STATENAME>${escapeXml(inv.vendorState)}</STATENAME>\n`;
        xml += `            <PLACEOFSUPPLY>${escapeXml(inv.vendorState)}</PLACEOFSUPPLY>\n`;
        xml += `            <ISINVOICE>Yes</ISINVOICE>\n`;
        xml += `            <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>\n`;
        xml += `            <BASICBUYERORDERNO>${escapeXml(inv.buyerOrderNo || '')}</BASICBUYERORDERNO>\n`;
        xml += `            <BASICSHIPDOCUMENTNO>${escapeXml(inv.supplierRef || '')}</BASICSHIPDOCUMENTNO>\n`;
        xml += `            <BASICSHIPVESSELNO>${escapeXml(inv.vehicleNo || '')}</BASICSHIPVESSELNO>\n`;
        xml += `            <NARRATION>${escapeXml(inv.narration || '')}</NARRATION>\n`;

        // Block A — All <ALLINVENTORYENTRIES.LIST> Blocks First (Contiguous)
        inv.lineItems.forEach(item => {
            const itemName = item.description || 'Item';
            const uom = item.uom || 'Nos';
            const slabName = `Purchase @ ${item.gst_rate}%`;
            const itemAmount = Number(item.taxable_value).toFixed(2);

            xml += `            <ALLINVENTORYENTRIES.LIST>\n`;
            xml += `              <STOCKITEMNAME>${escapeXml(itemName)}</STOCKITEMNAME>\n`;
            xml += `              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n`;
            xml += `              <ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE>\n`;
            xml += `              <RATE>${Number(item.rate).toFixed(2)}/${escapeXml(uom)}</RATE>\n`;
            xml += `              <DISCOUNT>${item.discount_percent || 0}</DISCOUNT>\n`;
            xml += `              <AMOUNT>-${itemAmount}</AMOUNT>\n`;
            xml += `              <ACTUALQTY> ${item.quantity} ${escapeXml(uom)}</ACTUALQTY>\n`;
            xml += `              <BILLEDQTY> ${item.quantity} ${escapeXml(uom)}</BILLEDQTY>\n`;
            xml += `              <ACCOUNTINGALLOCATIONS.LIST>\n`;
            xml += `                <LEDGERNAME>${escapeXml(slabName)}</LEDGERNAME>\n`;
            xml += `                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n`;
            xml += `                <ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE>\n`;
            xml += `                <AMOUNT>-${itemAmount}</AMOUNT>\n`;
            xml += `              </ACCOUNTINGALLOCATIONS.LIST>\n`;
            xml += `            </ALLINVENTORYENTRIES.LIST>\n`;
        });

        // Block B — All <LEDGERENTRIES.LIST> Blocks Together Immediately After Inventory (Contiguous!)
        // 1. First <LEDGERENTRIES.LIST> (Party Credit)
        xml += `            <LEDGERENTRIES.LIST>\n`;
        xml += `              <LEDGERNAME>${escapeXml(inv.vendorName)}</LEDGERNAME>\n`;
        xml += `              <ISPARTYLEDGER>Yes</ISPARTYLEDGER>\n`;
        xml += `              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n`;
        xml += `              <ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>\n`;
        xml += `              <AMOUNT>${inv.grandTotal.toFixed(2)}</AMOUNT>\n`;
        xml += `              <BILLALLOCATIONS.LIST>\n`;
        xml += `                <NAME>${escapeXml(inv.invoiceNumber)}</NAME>\n`;
        xml += `                <BILLTYPE>New Ref</BILLTYPE>\n`;
        xml += `                <AMOUNT>${inv.grandTotal.toFixed(2)}</AMOUNT>\n`;
        xml += `              </BILLALLOCATIONS.LIST>\n`;
        xml += `            </LEDGERENTRIES.LIST>\n`;

        // 2. Next <LEDGERENTRIES.LIST> (Tax Ledgers — Input CGST, Input SGST, Input IGST)
        if (inv.totalCgst > 0) {
            xml += `            <LEDGERENTRIES.LIST>\n`;
            xml += `              <LEDGERNAME>Input CGST</LEDGERNAME>\n`;
            xml += `              <ISPARTYLEDGER>No</ISPARTYLEDGER>\n`;
            xml += `              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n`;
            xml += `              <ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE>\n`;
            xml += `              <AMOUNT>-${inv.totalCgst.toFixed(2)}</AMOUNT>\n`;
            xml += `            </LEDGERENTRIES.LIST>\n`;
        }

        if (inv.totalSgst > 0) {
            xml += `            <LEDGERENTRIES.LIST>\n`;
            xml += `              <LEDGERNAME>Input SGST</LEDGERNAME>\n`;
            xml += `              <ISPARTYLEDGER>No</ISPARTYLEDGER>\n`;
            xml += `              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n`;
            xml += `              <ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE>\n`;
            xml += `              <AMOUNT>-${inv.totalSgst.toFixed(2)}</AMOUNT>\n`;
            xml += `            </LEDGERENTRIES.LIST>\n`;
        }

        if (inv.totalIgst > 0) {
            xml += `            <LEDGERENTRIES.LIST>\n`;
            xml += `              <LEDGERNAME>Input IGST</LEDGERNAME>\n`;
            xml += `              <ISPARTYLEDGER>No</ISPARTYLEDGER>\n`;
            xml += `              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n`;
            xml += `              <ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE>\n`;
            xml += `              <AMOUNT>-${inv.totalIgst.toFixed(2)}</AMOUNT>\n`;
            xml += `            </LEDGERENTRIES.LIST>\n`;
        }

        // Freight Entry (if > 0)
        if (inv.freightCharges > 0) {
            xml += `            <LEDGERENTRIES.LIST>\n`;
            xml += `              <LEDGERNAME>Freight &amp; Packing Charges</LEDGERNAME>\n`;
            xml += `              <ISPARTYLEDGER>No</ISPARTYLEDGER>\n`;
            xml += `              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n`;
            xml += `              <ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE>\n`;
            xml += `              <AMOUNT>-${inv.freightCharges.toFixed(2)}</AMOUNT>\n`;
            xml += `            </LEDGERENTRIES.LIST>\n`;
        }

        // 3. Last <LEDGERENTRIES.LIST> (Round Off)
        if (Math.abs(inv.roundOff) > 0.0001) {
            const isRoundUp = inv.roundOff > 0;
            xml += `            <LEDGERENTRIES.LIST>\n`;
            xml += `              <LEDGERNAME>Round Off</LEDGERNAME>\n`;
            xml += `              <ISPARTYLEDGER>No</ISPARTYLEDGER>\n`;
            xml += `              <ISDEEMEDPOSITIVE>${isRoundUp ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>\n`;
            xml += `              <ISLASTDEEMEDPOSITIVE>${isRoundUp ? 'Yes' : 'No'}</ISLASTDEEMEDPOSITIVE>\n`;
            xml += `              <AMOUNT>${isRoundUp ? '-' : ''}${Math.abs(inv.roundOff).toFixed(2)}</AMOUNT>\n`;
            xml += `            </LEDGERENTRIES.LIST>\n`;
        }

        xml += `          </VOUCHER>\n`;
        xml += `        </TALLYMESSAGE>\n`;
    });

    xml += `      </REQUESTDATA>\n`;
    xml += `    </IMPORTDATA>\n`;
    xml += `  </BODY>\n`;
    xml += `</ENVELOPE>`;

    return xml.replace(/&#4;\s*/g, '');
}

// Utility: Audit math check & complete bookkeeper schema normalization
function auditInvoiceData(raw = {}) {
    raw = raw || {};

    // 1. Supplier Fields
    const vendorName = (raw.vendor_name || raw.supplier_name || raw.vendorName || '').trim();
    const vendorGstin = (raw.vendor_gstin || raw.supplier_gstin || raw.gstin || '').trim().toUpperCase();
    const vendorAddress = (raw.vendor_address || raw.supplier_address || raw.supplierAddress || '').trim();
    const derivedVendorState = getStateFromGstin(vendorGstin, raw.vendor_state || raw.supplier_state || raw.place_of_supply || raw.placeOfSupply || 'Delhi');
    const vendorState = (raw.vendor_state || raw.supplier_state || derivedVendorState || 'Delhi').trim();
    const rawPin = (raw.vendor_pincode || raw.pincode || '').toString().trim();
    let vendorPincode = '';
    if (/^\d{6}$/.test(rawPin)) {
        vendorPincode = rawPin;
    } else {
        const pinMatch = vendorAddress.match(/\b\d{6}\b/);
        vendorPincode = pinMatch ? pinMatch[0] : '';
    }
    const vendorPhone = (raw.vendor_phone || raw.phone || '').trim();
    const bankName = (raw.bank_name || raw.bankName || '').trim();
    const accountNumber = (raw.account_number || raw.accountNumber || '').trim();
    const ifscCode = (raw.ifsc_code || raw.ifscCode || '').trim();
    const upiId = (raw.upi_id || raw.upiId || '').trim();

    // 2. Buyer Fields
    const buyerName = (raw.buyer_name || raw.buyerName || '').trim();
    const buyerGstin = (raw.buyer_gstin || raw.buyerGstin || '').trim().toUpperCase();
    const derivedBuyerState = getStateFromGstin(buyerGstin, raw.buyer_state || raw.buyerState || '');
    const buyerState = (raw.buyer_state || raw.buyerState || derivedBuyerState || '').trim();
    const buyerAddress = (raw.buyer_address || raw.buyerAddress || '').trim();

    // 3. Tax Classification (Intra-State vs Inter-State)
    const rawPrintedCgst = parseFloat(raw.printed_cgst_total ?? raw.total_cgst ?? raw.taxBreakdown?.cgst ?? raw.cgst_amount ?? 0);
    const rawPrintedSgst = parseFloat(raw.printed_sgst_total ?? raw.total_sgst ?? raw.taxBreakdown?.sgst ?? raw.sgst_amount ?? 0);
    const rawPrintedIgst = parseFloat(raw.printed_igst_total ?? raw.total_igst ?? raw.taxBreakdown?.igst ?? raw.igst_amount ?? 0);
    const hasCgstSgst = (rawPrintedCgst > 0 || rawPrintedSgst > 0);
    const statesDiffer = Boolean(buyerState && vendorState && vendorState.toLowerCase() !== buyerState.toLowerCase());
    const isInterState = (rawPrintedIgst > 0 && !hasCgstSgst) || (statesDiffer && !hasCgstSgst && rawPrintedIgst > 0);

    // 4. Line Items Normalization
    const rawItems = raw.line_items || raw.items || [];
    const VALID_GST_SLABS = [0, 5, 12, 18, 28];

    const normalizedLineItems = rawItems.map((item, idx) => {
        const srNo = Number(item.sr_no ?? item.sr ?? idx + 1);
        const desc = (item.description || item.itemName || item.name || 'Item').trim();
        const hsn = String(item.hsn_code ?? item.hsn_sac ?? item.hsn ?? '').trim();
        const qty = Number(item.quantity ?? item.qty ?? 1);
        const uom = String(item.uom || item.unit || 'Nos').trim() || 'Nos';
        let rate = Number(item.rate ?? 0);
        const disc = Number(item.discount_percent ?? item.discount ?? 0);

        let tv = round2(qty * rate * (1 - disc / 100));
        if (tv <= 0) {
            tv = Number(item.taxable_value ?? item.taxableValue ?? 0);
        }
        if (rate <= 0 && tv > 0 && qty > 0) {
            rate = round2(tv / qty);
        }

        let gstRate = Number(item.gst_rate ?? item.gstRate ?? item.tax_rate ?? item.taxRate);
        if (isNaN(gstRate) || gstRate == null) {
            if (item.cgst_rate != null && item.sgst_rate != null) {
                gstRate = Number(item.cgst_rate) + Number(item.sgst_rate);
            } else if ((item.cgst_amount || item.sgst_amount || item.igst_amount) && tv > 0) {
                const itemTax = Number(item.cgst_amount || 0) + Number(item.sgst_amount || 0) + Number(item.igst_amount || 0);
                gstRate = Math.round((itemTax / tv) * 100);
            } else {
                gstRate = 18;
            }
        }
        if (!VALID_GST_SLABS.includes(gstRate)) {
            const closest = VALID_GST_SLABS.reduce((prev, curr) => Math.abs(curr - gstRate) < Math.abs(prev - gstRate) ? curr : prev);
            gstRate = closest;
        }

        const itemTaxTotal = round2(tv * (gstRate / 100));
        let cgstAmt = 0;
        let sgstAmt = 0;
        let igstAmt = 0;

        if (isInterState) {
            igstAmt = itemTaxTotal;
        } else {
            cgstAmt = round2(itemTaxTotal / 2);
            sgstAmt = round2(itemTaxTotal / 2);
        }

        const totAmt = round2(tv + cgstAmt + sgstAmt + igstAmt);

        return {
            sr_no: srNo,
            description: desc,
            hsn_code: hsn,
            hsn_sac: hsn,
            quantity: qty,
            uom: uom,
            unit: uom,
            rate: rate,
            discount_percent: disc,
            taxable_value: tv,
            gst_rate: Number(gstRate),
            cgst_amount: cgstAmt,
            sgst_amount: sgstAmt,
            igst_amount: igstAmt,
            total_amount: totAmt
        };
    });

    // 5. Pure Accounting Math Calculation
    const itemsTaxableSum = round2(normalizedLineItems.reduce((acc, it) => acc + (it.taxable_value || 0), 0));
    const totalTaxable = itemsTaxableSum;

    const expectedTax = round2(normalizedLineItems.reduce((acc, it) => acc + (it.taxable_value * (it.gst_rate / 100)), 0));

    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;

    if (isInterState) {
        totalIgst = expectedTax;
    } else {
        totalCgst = round2(expectedTax / 2);
        totalSgst = round2(expectedTax / 2);
    }

    const freightCharges = round2(parseFloat(raw.freight_charges ?? raw.freightCharges ?? raw.freight ?? 0));
    const calculatedTotalBeforeRoundOff = round2(itemsTaxableSum + totalCgst + totalSgst + totalIgst + freightCharges);

    const printedGrandTotal = parseFloat(raw.printed_grand_total ?? raw.grand_total ?? raw.totalAmount ?? 0);
    const printedRoundOff = parseFloat(raw.printed_round_off ?? raw.round_off ?? raw.roundoff_amount ?? 0);

    let grandTotal = 0;
    let roundOff = 0;

    if (printedGrandTotal > 0 && Math.abs(printedGrandTotal - calculatedTotalBeforeRoundOff) <= 1.0) {
        grandTotal = round2(printedGrandTotal);
        roundOff = round2(grandTotal - calculatedTotalBeforeRoundOff);
    } else if (printedGrandTotal > 0) {
        // Never overwrite grand_total to a mismatched number that contradicts taxable + tax + round_off
        grandTotal = round2(printedGrandTotal);
        roundOff = round2(printedRoundOff);
    } else {
        roundOff = round2(printedRoundOff);
        grandTotal = round2(calculatedTotalBeforeRoundOff + roundOff);
    }

    const actualDebits = round2(itemsTaxableSum + totalCgst + totalSgst + totalIgst + freightCharges + roundOff);
    const balanceDiff = round2(actualDebits - grandTotal);
    let mathDiff = balanceDiff;

    let status = 'verified';
    if (Math.abs(balanceDiff) <= 0.05) {
        mathDiff = 0.0;
        status = 'verified';
    } else {
        status = 'math_error';
    }

    // 6. Header Fields
    const invNum = (raw.invoice_number || raw.invoiceNumber || '').trim();
    const rawDate = raw.invoice_date || raw.invoiceDate || '';
    const invDateIso = parseIndianDateToISO(rawDate);
    const dueDateIso = (raw.due_date || raw.dueDate) ? parseIndianDateToISO(raw.due_date || raw.dueDate) : '';
    const paymentMode = (raw.payment_mode || raw.paymentMode || '').trim();
    const reverseChargeRaw = raw.reverse_charge || raw.reverseCharge || 'No';
    const reverseCharge = String(reverseChargeRaw).trim().toLowerCase() === 'yes' ? 'Yes' : 'No';
    const buyerOrderNo = (raw.buyer_order_no || raw.buyerOrderNo || '').trim();
    const orderDateIso = (raw.order_date || raw.orderDate) ? parseIndianDateToISO(raw.order_date || raw.orderDate) : '';
    const supplierRef = (raw.supplier_ref || raw.supplierRef || '').trim();
    const vehicleNo = (raw.vehicle_no || raw.vehicleNumber || raw.vehicle_number || '').trim();
    const ewayBillNo = (raw.eway_bill_no || raw.ewayBillNo || '').trim();

    if (!vendorName || !invNum || grandTotal <= 0) {
        if (status !== 'math_error') {
            status = 'needs_review';
        }
    }

    return {
        // Complete Bookkeeper OCR Schema
        vendor_name: vendorName,
        vendor_gstin: vendorGstin,
        vendor_address: vendorAddress,
        vendor_state: vendorState,
        vendor_pincode: vendorPincode,
        vendor_phone: vendorPhone,
        bank_name: bankName,
        account_number: accountNumber,
        ifsc_code: ifscCode,
        upi_id: upiId,

        buyer_name: buyerName,
        buyer_gstin: buyerGstin,
        buyer_state: buyerState,
        buyer_address: buyerAddress,

        invoice_number: invNum,
        invoice_date: invDateIso,
        due_date: dueDateIso,
        payment_mode: paymentMode,
        reverse_charge: reverseCharge,
        buyer_order_no: buyerOrderNo,
        order_date: orderDateIso,
        supplier_ref: supplierRef,
        vehicle_no: vehicleNo,
        eway_bill_no: ewayBillNo,

        line_items: normalizedLineItems,
        total_taxable: totalTaxable,
        total_cgst: totalCgst,
        total_sgst: totalSgst,
        total_igst: totalIgst,
        freight_charges: freightCharges,
        round_off: roundOff,
        grand_total: grandTotal,

        printed_taxable_subtotal: parseFloat(raw.printed_taxable_subtotal ?? 0),
        printed_cgst_total: parseFloat(raw.printed_cgst_total ?? 0),
        printed_sgst_total: parseFloat(raw.printed_sgst_total ?? 0),
        printed_igst_total: parseFloat(raw.printed_igst_total ?? 0),
        printed_round_off: parseFloat(raw.printed_round_off ?? 0),
        printed_grand_total: printedGrandTotal,

        verification_state: status,
        math_difference: mathDiff,

        // Backward compatibility aliases
        items: normalizedLineItems,
        taxable_amount: totalTaxable,
        cgst_amount: totalCgst,
        sgst_amount: totalSgst,
        igst_amount: totalIgst,
        roundoff_amount: roundOff,
        roundOff: roundOff ? Number(roundOff).toFixed(2) : '0.00',
        supplier_name: vendorName,
        supplier_gstin: vendorGstin,
        gstin: vendorGstin,
        supplier_address: vendorAddress,
        supplier_state: vendorState,
        place_of_supply: vendorState
    };
}

// Helper: Convert file buffer to Generative AI part
function fileToGenerativePart(filePath, mimeType) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(filePath)).toString('base64'),
            mimeType
        }
    };
}

// Helper: Call Gemini AI with gemini-2.5-flash and retry mechanism (Task 1 & Task 2)
async function processFileWithGemini(genAI, filePath, mimeType, res = null) {
    const imagePart = fileToGenerativePart(filePath, mimeType);
    const prompt = `
    Extract complete invoice metadata from this Indian vendor invoice image or document.
    Return a valid JSON object strictly matching this complete bookkeeper schema:
    {
      "vendor_name": "Supplier / Vendor business name",
      "vendor_gstin": "15-character GSTIN of the supplier (null if unregistered or missing)",
      "vendor_address": "Complete registered or street address of the supplier (null if missing)",
      "vendor_state": "State of the supplier (e.g. Maharashtra, Delhi, Gujarat) (null if missing)",
      "vendor_pincode": "6-digit postal PIN code of the supplier (null if missing)",
      "vendor_phone": "Contact or phone/mobile number of the supplier (null if missing)",
      "bank_name": "Supplier bank name (e.g. HDFC Bank, ICICI Bank, State Bank of India) (null if missing)",
      "account_number": "Supplier bank account number (null if missing)",
      "ifsc_code": "Supplier bank 11-character IFSC code (null if missing)",
      "upi_id": "Supplier UPI ID or VPA (e.g. vendor@okaxis) (null if missing)",

      "buyer_name": "Buyer / Bill To / Ship To company or customer name (null if missing)",
      "buyer_gstin": "15-character GSTIN of the buyer (null if missing)",
      "buyer_state": "State of the buyer / Place of supply (null if missing)",
      "buyer_address": "Delivery or billing address of the buyer (null if missing)",

      "invoice_number": "Invoice, Tax Invoice, or Bill number",
      "invoice_date": "Invoice date parsed strictly from Indian format (DD-MM-YY or DD-MM-YYYY) into ISO YYYY-MM-DD",
      "due_date": "Payment due date in ISO YYYY-MM-DD format (null if not specified)",
      "payment_mode": "Payment mode (e.g. UPI, Cash, Bank Transfer, Cheque, Credit) (null if not specified)",
      "reverse_charge": "\"Yes\" or \"No\" (strictly \"Yes\" or \"No\", defaults to \"No\")",
      "buyer_order_no": "Buyer purchase order number (P.O. No) (null if missing)",
      "order_date": "Order date in ISO YYYY-MM-DD format (null if missing)",
      "supplier_ref": "Supplier reference / challan / dispatch number (null if missing)",
      "vehicle_no": "Vehicle or transport number (null if missing)",
      "eway_bill_no": "E-Way Bill number (null if missing)",

      "line_items": [
        {
          "sr_no": 1,
          "description": "Item or product description / ledger name",
          "hsn_code": "HSN or SAC code string (e.g. \"8471\", \"9983\") (null if missing)",
          "quantity": 1,
          "uom": "Unit of measurement string (e.g. \"Nos\", \"Box\", \"Pkt\", \"Kgs\", \"Pcs\" - default to \"Nos\" if blank)",
          "rate": 100.0,
          "discount_percent": 0.0,
          "taxable_value": 100.0,
          "gst_rate": 18,
          "cgst_amount": 9.0,
          "sgst_amount": 9.0,
          "igst_amount": 0.0,
          "total_amount": 118.0
        }
      ],

      "printed_taxable_subtotal": 100.0,
      "printed_cgst_total": 9.0,
      "printed_sgst_total": 9.0,
      "printed_igst_total": 0.0,
      "printed_round_off": 0.0,
      "printed_grand_total": 118.0,

      "total_taxable": 100.0,
      "total_cgst": 9.0,
      "total_sgst": 9.0,
      "total_igst": 0.0,
      "freight_charges": 0.0,
      "round_off": 0.0,
      "grand_total": 118.0
    }

    STRICT BOOKKEEPER OCR RULES:
    1. STRICT SEQUENTIAL ROW EXTRACTION (Sr 1 to Sr N):
       - CRITICAL: Scan the line-item table starting immediately below the column header row (e.g., "Sr | Goods & Service Description | HSN | Quantity | Rate | Taxable | GST | Total").
       - Do NOT skip Row 1 (Sr 1), even if it is flush against the header border or has a small amount.
       - Extract the "sr_no" for every row.
       - Before returning JSON, verify that line_items.length matches the final Sr number printed in the table (e.g., if Sr goes from 1 to 8, line_items MUST contain all 8 items) and that the sum of line_items[].taxable_value equals the printed Sub-Total.
    2. PRESERVE PRINTED SUMMARY TOTALS SEPARATELY:
       - Extract "printed_taxable_subtotal", "printed_cgst_total", "printed_sgst_total", "printed_igst_total", "printed_round_off", and "printed_grand_total" directly from the bottom summary box/table of the invoice.
    3. Indian Date Parsing Rule: Indian invoices print dates as DD-MM-YYYY or DD-MM-YY (e.g. 10-01-25 is January 10th 2025, NOT October 1st). Parse strictly into ISO YYYY-MM-DD.
    4. Full Line Items Array: Extract EVERY single line item present in the invoice table without summarizing, grouping, or truncating.
    5. uom: If unit is not explicitly written on the item line, default to "Nos".
    6. Visual Primacy: Extract the EXACT numeric values printed on the invoice for Rate and Taxable Value. DO NOT guess or alter numbers. If an item says '10.00', extract 10.00.
    7. Reverse Charge: Must be strictly "Yes" or "No".
    8. Null safety: If a text field is absent from the document, output null for text and 0 for numeric fields. Do NOT refuse to extract the document.
    9. Grand Total Validation: Ensure numeric amounts are precise numbers without currency symbols.
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const result = await model.generateContent([prompt, imagePart]);
            let responseText = result.response.text();
            let parsedData;
            try {
                parsedData = JSON.parse(responseText);
            } catch (jsonErr) {
                // If partial JSON is returned, sanitize it and return it instead of throwing a 500 error
                const sanitized = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
                parsedData = JSON.parse(sanitized);
            }

            // Auto-Recovery Retry When a Table Row is Missed
            if (parsedData) {
                const lineItems = Array.isArray(parsedData.line_items) ? parsedData.line_items : [];
                const printedSubTotal = Number(parsedData.printed_taxable_subtotal || parsedData.total_taxable || 0);
                const itemsTaxableSum = round2(lineItems.reduce((s, i) => s + Number(i.taxable_value || (i.quantity * i.rate) || 0), 0));

                if (printedSubTotal > 0 && Math.abs(itemsTaxableSum - printedSubTotal) > 1.0) {
                    console.warn(`[Gemini AI] Taxable sum mismatch detected (items: ${itemsTaxableSum}, printed subtotal: ${printedSubTotal}). Attempting auto-recovery retry...`);
                    try {
                        const diff = round2(printedSubTotal - itemsTaxableSum);
                        const retryPrompt = `Your previous extraction summed to ${itemsTaxableSum}, but the printed Sub-Total on the invoice is ${printedSubTotal} (difference: ${diff}). You missed a row (check Row 1 right under the table header). Return the complete JSON with ALL rows included.`;
                        const retryResult = await model.generateContent([
                            prompt + "\n\nCRITICAL AUTO-RECOVERY RETRY INSTRUCTION:\n" + retryPrompt,
                            imagePart
                        ]);
                        let retryText = retryResult.response.text();
                        let retryJSON;
                        try {
                            retryJSON = JSON.parse(retryText);
                        } catch (e) {
                            const clean = retryText.replace(/```json/gi, '').replace(/```/g, '').trim();
                            retryJSON = JSON.parse(clean);
                        }
                        if (retryJSON && Array.isArray(retryJSON.line_items)) {
                            const retryItemsSum = round2(retryJSON.line_items.reduce((s, i) => s + Number(i.taxable_value || (i.quantity * i.rate) || 0), 0));
                            console.log(`[Gemini AI] Auto-recovery retry completed: items count=${retryJSON.line_items.length}, sum=${retryItemsSum}`);
                            if (Math.abs(retryItemsSum - printedSubTotal) <= Math.abs(itemsTaxableSum - printedSubTotal)) {
                                parsedData = retryJSON;
                            }
                        }
                    } catch (retryErr) {
                        console.warn(`[Gemini AI] Auto-recovery retry encountered an error:`, retryErr.message);
                    }
                }
            }

            return parsedData;
        } catch (err) {
            lastError = err;
            console.warn(`[Gemini AI] Attempt ${attempt} failed:`, err.message);

            const is503 = err.status === 503 ||
                (err.message && (err.message.includes('503') || err.message.includes('Service Unavailable') || err.message.includes('overloaded') || err.message.includes('ResourceExhausted')));

            if (is503 && attempt < maxAttempts) {
                console.log(`[Gemini AI] 503 / Service Unavailable encountered. Waiting 2 seconds before retry (attempt ${attempt + 1}/${maxAttempts})...`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            if (!is503) {
                break;
            }
        }
    }

    const is503Final = lastError && (lastError.status === 503 ||
        (lastError.message && (lastError.message.includes('503') || lastError.message.includes('Service Unavailable') || lastError.message.includes('overloaded') || lastError.message.includes('ResourceExhausted'))));

    if (is503Final) {
        if (res && typeof res.status === 'function' && !res.headersSent) {
            return res.status(503).json({ error: "AI Service temporarily unavailable. Please try again." });
        }
        const err503 = new Error("AI Service temporarily unavailable. Please try again.");
        err503.status = 503;
        throw err503;
    }

    throw new Error(`AI extraction failed: ${lastError ? lastError.message : 'Unknown error'}`);
}

// API ENDPOINT: POST /api/vendors
app.post('/api/vendors', (req, res) => {
    const { rawVendorName, tallyLedgerName, gstin } = req.body;
    const orgId = 'default_org';
    if (!rawVendorName || !tallyLedgerName) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    saveVendorMapping(orgId, rawVendorName, tallyLedgerName, gstin);
    res.json({ success: true });
});

// API ENDPOINT: POST /api/extract-invoice (Supports concurrent multi-file upload processing)
app.post('/api/extract-invoice', ClerkExpressRequireAuth({}), extractLimiter, upload.any(), async (req, res) => {
    const uploadedFiles = req.files || [];
    const userId = req.auth ? req.auth.userId : 'default_user';
    const orgId = req.auth ? (req.auth.orgId || 'default_org') : 'default_org';

    try {
        if (!uploadedFiles || uploadedFiles.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No invoice files uploaded. Please select PNG, JPG, WEBP, or PDF files.'
            });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey || apiKey === 'your_gemini_api_key_here' || apiKey.trim() === '') {
            uploadedFiles.forEach(f => { if (fs.existsSync(f.path)) fs.unlink(f.path, () => { }); });
            return res.status(500).json({
                success: false,
                error: 'Gemini API Key is not configured on the backend server. Please set GEMINI_API_KEY in your .env file.'
            });
        }

        const genAI = new GoogleGenerativeAI(apiKey);

        // Concurrent promise execution for all uploaded files
        const processedInvoices = await Promise.all(
            uploadedFiles.map(async (file, i) => {
                try {
                    const extractedRaw = await processFileWithGemini(genAI, file.path, file.mimetype, res);
                    if (res.headersSent) return null;
                    const audited = auditInvoiceData(extractedRaw);
                    const savedLedger = await getMappedVendorLedger(orgId, audited.vendor_name);
                    const finalLedgerName = savedLedger || (audited.vendor_name ? `${audited.vendor_name} Ledger` : 'Sundry Creditors');
                    const xml = generateTallyXml(audited);

                    return {
                        id: `inv_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 7)}`,
                        orgId: orgId || null,
                        userId: userId || null,
                        fileName: file.originalname,
                        fileSize: formatBytes(file.size),
                        fileType: file.mimetype.includes('pdf') ? 'pdf' : 'image',

                        // Full Bookkeeper OCR Schema (Task 1)
                        vendor_name: audited.vendor_name,
                        vendor_gstin: audited.vendor_gstin,
                        vendor_address: audited.vendor_address,
                        vendor_state: audited.vendor_state,
                        vendor_pincode: audited.vendor_pincode,
                        vendor_phone: audited.vendor_phone,
                        bank_name: audited.bank_name,
                        account_number: audited.account_number,
                        ifsc_code: audited.ifsc_code,
                        upi_id: audited.upi_id,

                        buyer_name: audited.buyer_name,
                        buyer_gstin: audited.buyer_gstin,
                        buyer_state: audited.buyer_state,
                        buyer_address: audited.buyer_address,

                        invoice_number: audited.invoice_number,
                        invoice_date: audited.invoice_date,
                        due_date: audited.due_date,
                        payment_mode: audited.payment_mode,
                        reverse_charge: audited.reverse_charge,
                        buyer_order_no: audited.buyer_order_no,
                        order_date: audited.order_date,
                        supplier_ref: audited.supplier_ref,
                        vehicle_no: audited.vehicle_no,
                        eway_bill_no: audited.eway_bill_no,

                        line_items: audited.line_items,
                        total_taxable: audited.total_taxable,
                        total_cgst: audited.total_cgst,
                        total_sgst: audited.total_sgst,
                        total_igst: audited.total_igst,
                        freight_charges: audited.freight_charges,
                        round_off: audited.round_off,
                        grand_total: audited.grand_total,

                        printed_taxable_subtotal: audited.printed_taxable_subtotal,
                        printed_cgst_total: audited.printed_cgst_total,
                        printed_sgst_total: audited.printed_sgst_total,
                        printed_igst_total: audited.printed_igst_total,
                        printed_round_off: audited.printed_round_off,
                        printed_grand_total: audited.printed_grand_total,

                        // Frontend aliases for full seamless UI reactivity
                        vendorName: audited.vendor_name,
                        invoiceNumber: audited.invoice_number,
                        invoiceDate: audited.invoice_date,
                        reverseCharge: audited.reverse_charge,
                        buyerName: audited.buyer_name,
                        buyerGstin: audited.buyer_gstin,
                        buyerOrderNo: audited.buyer_order_no,
                        supplierRef: audited.supplier_ref,
                        vehicleNo: audited.vehicle_no,
                        vehicleNumber: audited.vehicle_no,
                        paymentMode: audited.payment_mode,
                        supplierAddress: audited.vendor_address,
                        supplierState: audited.vendor_state,
                        gstin: audited.vendor_gstin,
                        placeOfSupply: audited.vendor_state || 'Delhi',
                        tallyLedgerName: finalLedgerName,
                        narration: audited.narration,
                        items: audited.line_items,
                        taxableAmount: audited.total_taxable,
                        freightCharges: audited.freight_charges,
                        taxBreakdown: {
                            cgst: audited.total_cgst,
                            sgst: audited.total_sgst,
                            igst: audited.total_igst
                        },
                        roundoffAmount: audited.round_off,
                        roundOff: audited.round_off ? Number(audited.round_off).toFixed(2) : '0.00',
                        totalAmount: audited.grand_total,
                        verificationState: audited.verification_state,
                        mathDifference: audited.math_difference,
                        tallyXml: xml,
                        uploadedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    };
                } catch (fileErr) {
                    console.error(`Error processing file ${file.originalname}:`, fileErr);
                    if (fileErr.status === 503 || (fileErr.message && (fileErr.message.includes('503') || fileErr.message.includes('temporarily unavailable')))) {
                        throw fileErr;
                    }
                    return {
                        id: `inv_${Date.now()}_${i}_err`,
                        orgId: orgId || null,
                        userId: userId || null,
                        fileName: file.originalname,
                        fileSize: formatBytes(file.size),
                        fileType: file.mimetype.includes('pdf') ? 'pdf' : 'image',
                        invoiceNumber: 'ERR',
                        invoiceDate: '',
                        vendorName: 'Extraction Failed',
                        gstin: '',
                        placeOfSupply: 'Pending',
                        tallyLedgerName: 'Pending',
                        narration: 'N/A',
                        items: [],
                        taxableAmount: 0,
                        taxBreakdown: { cgst: 0, sgst: 0, igst: 0 },
                        roundoffAmount: 0,
                        roundOff: '0.00',
                        totalAmount: 0,
                        verificationState: 'needs_review',
                        mathDifference: 0,
                        tallyXml: '',
                        errorText: fileErr.message
                    };
                } finally {
                    if (fs.existsSync(file.path)) {
                        fs.unlink(file.path, () => { });
                    }
                }
            })
        );

        if (res.headersSent) return;

        try {
            const stmt = db.prepare('INSERT OR REPLACE INTO invoices (id, orgId, userId, fileName, vendorName, invoiceNumber, totalAmount, verificationState, fullData) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
            processedInvoices.forEach(inv => {
                if (inv && inv.id && !inv.id.endsWith('_err')) {
                    stmt.run(inv.id, orgId, userId, inv.fileName, inv.vendorName, inv.invoiceNumber, inv.totalAmount, inv.verificationState, JSON.stringify(inv));
                    if (inv.vendorName) {
                        saveVendorMapping(orgId, inv.vendorName, inv.tallyLedgerName, inv.gstin);
                    }
                }
            });
            stmt.finalize();
        } catch (dbErr) {
            console.error('Database Insert Error:', dbErr.message);
            return res.status(500).json({ success: false, error: dbErr.message });
        }

        return res.status(200).json({
            success: true,
            message: `${processedInvoices.length} invoice(s) processed successfully`,
            userId: userId || null,
            orgId: orgId || null,
            data: processedInvoices
        });

    } catch (err) {
        uploadedFiles.forEach(f => {
            if (fs.existsSync(f.path)) fs.unlink(f.path, () => { });
        });
        console.error('Extraction Error:', err.message);
        if (res.headersSent) return;
        if (err.status === 503 || (err.message && (err.message.includes('503') || err.message.includes('temporarily unavailable')))) {
            return res.status(503).json({
                error: "AI Service temporarily unavailable. Please try again."
            });
        }
        return res.status(500).json({
            success: false,
            error: err.message || 'An unexpected error occurred during invoice processing.'
        });
    }
});

app.get('/api/invoices', ClerkExpressRequireAuth({}), (req, res) => {
    try {
        const orgId = req.auth ? (req.auth.orgId || 'default_org') : 'default_org';
        db.all('SELECT * FROM invoices WHERE orgId = ? ORDER BY createdAt DESC', [orgId], (err, rows) => {
            if (err) {
                console.error('Database Error:', err.message);
                return res.status(500).json({ success: false, error: 'Failed to fetch invoices.' });
            }
            const data = rows.map(row => {
                try {
                    const parsed = JSON.parse(row.fullData);
                    if (parsed && (!parsed.tallyXml || parsed.tallyXml.includes('<ALLLEDGERENTRIES.LIST>') || parsed.tallyXml.includes('<TAXTYPE>GST</TAXTYPE>'))) {
                        parsed.tallyXml = generateTallyXml(parsed);
                    }
                    return parsed;
                } catch (e) {
                    return null;
                }
            }).filter(Boolean);
            res.json({ success: true, data });
        });
    } catch (err) {
        console.error('Database query exception:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// API ENDPOINT: PUT /api/invoices/:id — Update invoice fields, regenerate XML, persist to DB
app.put('/api/invoices/:id', ClerkExpressRequireAuth({}), (req, res) => {
    try {
        const { id } = req.params;
        const orgId = req.auth ? (req.auth.orgId || 'default_org') : 'default_org';
        const updates = req.body; // Full updated invoice payload from frontend

        if (!id || !updates) {
            return res.status(400).json({ success: false, error: 'Invoice ID and update payload are required.' });
        }

        // Fetch existing record first
        db.get('SELECT * FROM invoices WHERE id = ? AND orgId = ?', [id, orgId], (err, row) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error: ' + err.message });
            }
            if (!row) {
                return res.status(404).json({ success: false, error: 'Invoice not found.' });
            }

            let existing;
            try {
                existing = JSON.parse(row.fullData);
            } catch (e) {
                return res.status(500).json({ success: false, error: 'Failed to parse existing invoice data.' });
            }

            // Merge updates into existing record
            const merged = { ...existing, ...updates, id };

            // Ensure date fields updated from audit review take strict priority
            const updatedDate = updates.invoiceDate || updates.invoice_date || updates.date;
            if (updatedDate) {
                merged.invoiceDate = updatedDate;
                merged.invoice_date = updatedDate;
                merged.date = updatedDate;
            }

            // Build the data object expected by generateTallyXml
            const xmlInput = {
                invoice_number:   merged.invoice_number || merged.invoiceNumber || '',
                invoice_date:     parseIndianDateToISO(merged.invoiceDate || merged.invoice_date || merged.date || ''),
                due_date:         merged.due_date || merged.dueDate || '',
                payment_mode:     merged.payment_mode || merged.paymentMode || '',
                reverse_charge:   merged.reverse_charge || merged.reverseCharge || 'No',
                buyer_order_no:   merged.buyer_order_no || merged.buyerOrderNo || '',
                order_date:       merged.order_date || merged.orderDate || '',
                supplier_ref:     merged.supplier_ref || merged.supplierRef || '',
                vehicle_no:       merged.vehicle_no || merged.vehicleNumber || merged.vehicle_number || '',
                eway_bill_no:     merged.eway_bill_no || merged.ewayBillNo || '',

                vendor_name:      merged.vendor_name || merged.vendorName || '',
                vendor_gstin:     merged.vendor_gstin || merged.gstin || '',
                vendor_address:   merged.vendor_address || merged.supplier_address || merged.supplierAddress || '',
                vendor_state:     merged.vendor_state || merged.supplier_state || merged.place_of_supply || merged.placeOfSupply || '',
                vendor_pincode:   merged.vendor_pincode || merged.pincode || '',
                vendor_phone:     merged.vendor_phone || merged.phone || '',
                bank_name:        merged.bank_name || merged.bankName || '',
                account_number:   merged.account_number || merged.accountNumber || '',
                ifsc_code:        merged.ifsc_code || merged.ifscCode || '',
                upi_id:           merged.upi_id || merged.upiId || '',

                buyer_name:       merged.buyer_name || merged.buyerName || '',
                buyer_gstin:      merged.buyer_gstin || merged.buyerGstin || '',
                buyer_state:      merged.buyer_state || merged.buyerState || '',
                buyer_address:    merged.buyer_address || merged.buyerAddress || '',

                line_items:       merged.line_items || merged.items || [],
                items:            merged.line_items || merged.items || [],
                total_taxable:    parseFloat(merged.total_taxable ?? merged.taxableAmount ?? merged.taxable_amount ?? 0),
                total_cgst:       parseFloat(merged.total_cgst ?? merged.taxBreakdown?.cgst ?? merged.cgst_amount ?? 0),
                total_sgst:       parseFloat(merged.total_sgst ?? merged.taxBreakdown?.sgst ?? merged.sgst_amount ?? 0),
                total_igst:       parseFloat(merged.total_igst ?? merged.taxBreakdown?.igst ?? merged.igst_amount ?? 0),
                freight_charges:  parseFloat(merged.freight_charges ?? merged.freightCharges ?? 0),
                round_off:        parseFloat(merged.round_off ?? merged.roundoffAmount ?? merged.roundoff_amount ?? 0),
                grand_total:      parseFloat(merged.grand_total ?? merged.totalAmount ?? 0),
                purchase_ledger:  merged.tallyLedgerName || 'Purchase Account',
                narration:        merged.narration || ''
            };

            // Regenerate Tally XML with current field values
            const freshXml = generateTallyXml(xmlInput);
            merged.tallyXml = freshXml;

            // Persist back to DB
            const fullDataStr = JSON.stringify(merged);
            db.run(
                'UPDATE invoices SET vendorName = ?, invoiceNumber = ?, totalAmount = ?, verificationState = ?, fullData = ? WHERE id = ? AND orgId = ?',
                [
                    merged.vendorName      || '',
                    merged.invoiceNumber   || '',
                    parseFloat(merged.totalAmount || 0),
                    merged.verificationState || 'needs_review',
                    fullDataStr,
                    id,
                    orgId
                ],
                function(updateErr) {
                    if (updateErr) {
                        return res.status(500).json({ success: false, error: 'Failed to save invoice: ' + updateErr.message });
                    }
                    return res.json({ success: true, data: merged });
                }
            );
        });
    } catch (err) {
        console.error('Invoice Update Error:', err.message);
        res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
    }
});

// Config endpoint for frontend Clerk publishable key
app.get('/api/config', (req, res) => {
    res.json({
        clerkPublishableKey: (process.env.CLERK_PUBLISHABLE_KEY || '').trim()
    });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    const key = (process.env.GEMINI_API_KEY || '').trim();
    const isApiKeyConfigured = Boolean(key && key !== 'your_gemini_api_key_here');
    res.json({
        status: 'online',
        service: 'TallyFlow AI Backend Middleware',
        security: {
            api_key_configured: isApiKeyConfigured,
            key_length: key.length,
            frontend_key_exposed: false
        }
    });
});

// API ENDPOINT: POST /api/sync-tally (Direct bridge to local TallyPrime server)
app.post('/api/sync-tally', async (req, res) => {
    try {
        const { xmlData } = req.body;
        if (!xmlData) {
            return res.status(400).json({ success: false, error: 'xmlData is required in request body' });
        }

        const tallyResponse = await fetch('http://127.0.0.1:9000/', {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml'
            },
            body: xmlData
        });

        const responseText = await tallyResponse.text();

        if (!tallyResponse.ok) {
            return res.status(tallyResponse.status).send(responseText);
        }

        res.set('Content-Type', 'text/xml');
        return res.status(200).send(responseText);
    } catch (err) {
        console.error('❌ Tally Direct Sync Error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to connect to Tally. Ensure TallyPrime is open and running on port 9000.'
        });
    }
});

// Clerk Error Handling Middleware
app.use((err, req, res, next) => {
    if (err.message === 'Unauthenticated' || err.status === 401) {
        console.error('\n❌ CLERK AUTH REJECTED THE TOKEN:');
        if (err.errors) {
            console.error('Details:', JSON.stringify(err.errors, null, 2));
        } else {
            console.error('Reason:', err.message);
        }
        console.error('-----------------------------------\n');
        return res.status(401).json({ success: false, error: 'Unauthenticated request' });
    }
    console.error('Unhandled Server Error:', err);
    res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

// Start Server
if (require.main === module) {
app.listen(PORT, () => {
    console.log(`========================================================`);
    console.log(`⚡ TallyFlow AI Backend Middleware Server Running`);
    console.log(`🔒 Security: Gemini API Key secured on backend via .env`);
    console.log(`🌐 Server Base URL: http://localhost:${PORT}`);
    console.log(`🚀 API Endpoint:   http://localhost:${PORT}/api/extract-invoice`);
    console.log(`========================================================`);
});
}

// Export helpers for testing and external integrations
module.exports = {
    app,
    parseIndianDateToISO,
    formatDateForTallyXML,
    formatTallyDate,
    useEduSafeDate,
    getTallyEduSafeDate,
    getStateFromGstin,
    getPanFromGstin,
    GSTIN_STATE_MAP,
    generateTallyXml,
    auditInvoiceData,
    processFileWithGemini,
    round2,
    escapeXml
};
