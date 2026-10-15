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

// Utility: Flexible date parser → YYYYMMDD (Tally required format)
// Accepts: '2026-09-01', '01/09/2026', '1-sept 2026', '1 Sep 2026', '20260901', etc.
function formatTallyDate(dateString) {
    if (!dateString) return null;
    const str = String(dateString).trim();

    // Already in YYYYMMDD numeric form
    if (/^\d{8}$/.test(str)) return str;

    // Month name → number map (covers full names + common abbreviations)
    const monthMap = {
        january: '01', jan: '01',
        february: '02', feb: '02',
        march: '03', mar: '03',
        april: '04', apr: '04',
        may: '05',
        june: '06', jun: '06',
        july: '07', jul: '07',
        august: '08', aug: '08',
        september: '09', sep: '09', sept: '09',
        october: '10', oct: '10',
        november: '11', nov: '11',
        december: '12', dec: '12'
    };

    // Normalise separators so we can split uniformly
    const normalised = str.replace(/[\-\/\s,]+/g, ' ').trim().toLowerCase();
    const parts = normalised.split(' ').filter(Boolean);

    let day, month, year;

    if (parts.length === 3) {
        // Try DD-MonthName-YYYY  or  MonthName-DD-YYYY  or  YYYY-MM-DD
        const p0 = parts[0], p1 = parts[1], p2 = parts[2];

        if (monthMap[p1]) {
            // DD MonthName YYYY
            day   = p0.padStart(2, '0');
            month = monthMap[p1];
            year  = p2;
        } else if (monthMap[p0]) {
            // MonthName DD YYYY
            month = monthMap[p0];
            day   = p1.padStart(2, '0');
            year  = p2;
        } else if (monthMap[p2]) {
            // DD MM(name) YYYY — already handled above; fallback
            day   = p0.padStart(2, '0');
            month = monthMap[p2];
            year  = p1;
        } else if (/^\d{4}$/.test(p0)) {
            // YYYY MM DD
            year  = p0;
            month = p1.padStart(2, '0');
            day   = p2.padStart(2, '0');
        } else if (/^\d{4}$/.test(p2)) {
            // DD MM YYYY  or  MM DD YYYY
            // Heuristic: if first part > 12, it must be DD
            const n0 = parseInt(p0, 10);
            const n1 = parseInt(p1, 10);
            year = p2;
            if (n0 > 12) {
                day   = p0.padStart(2, '0');
                month = p1.padStart(2, '0');
            } else {
                // Ambiguous — assume DD/MM for Indian locale
                day   = p0.padStart(2, '0');
                month = p1.padStart(2, '0');
            }
        }
    }

    if (year && month && day) {
        const candidate = `${year}${month}${day}`;
        // Quick sanity check via native Date
        const d = new Date(`${year}-${month}-${day}`);
        if (!isNaN(d.getTime())) return candidate;
    }

    // Last-resort: let native Date try to parse it
    const d = new Date(dateString);
    if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${y}${m}${dd}`;
    }

    // Fallback: today's date
    const now = new Date();
    const fy = now.getFullYear();
    const fm = String(now.getMonth() + 1).padStart(2, '0');
    const fd = String(now.getDate()).padStart(2, '0');
    console.warn(`[formatTallyDate] Could not parse "${dateString}", falling back to today: ${fy}${fm}${fd}`);
    return `${fy}${fm}${fd}`;
}

// Utility: Generate TallyPrime Purchase Voucher XML
function generateTallyXml(data, options = { safeEduMode: true }) {
    const {
        invoice_number = 'INV-001',
        invoice_date = '',
        vendor_name = 'Vendor Ledger',
        gstin = '',
        supplier_address = '',
        supplier_state = '',
        buyer_order_no = '',
        supplier_ref = '',
        vehicle_number = '',
        taxable_amount = 0,
        cgst_amount = 0,
        sgst_amount = 0,
        igst_amount = 0,
        roundoff_amount = 0,
        grand_total = 0,
        purchase_ledger = 'Purchase Account',
        cgst_ledger = 'Input CGST',
        sgst_ledger = 'Input SGST',
        igst_ledger = 'Input IGST',
        roundoff_ledger = 'Round Off',
        items = []
    } = data;

    // Use the robust multi-format date parser
    const dateFormatted = formatTallyDate(invoice_date) || (() => {
        const now = new Date();
        return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    })();

    const invNo = (invoice_number || 'INV-001').trim();
    const cleanVendor = (vendor_name || 'Vendor Ledger').trim();

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<ENVELOPE>\n`;
    xml += `  <HEADER>\n`;
    xml += `    <TALLYREQUEST>Import Data</TALLYREQUEST>\n`;
    xml += `  </HEADER>\n`;
    xml += `  <BODY>\n`;
    xml += `    <IMPORTDATA>\n`;
    xml += `      <REQUESTDESC>\n`;
    xml += `        <REPORTNAME>Vouchers</REPORTNAME>\n`;
    xml += `        <STATICVARIABLES>\n`;
    xml += `          <SVCURRENTCOMPANY>##SVCURRENTCOMPANY</SVCURRENTCOMPANY>\n`;
    xml += `        </STATICVARIABLES>\n`;
    xml += `      </REQUESTDESC>\n`;
    xml += `      <REQUESTDATA>\n`;

    xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
    xml += `          <LEDGER NAME="${escapeXml(cleanVendor)}" ACTION="Create">\n`;
    xml += `            <NAME>${escapeXml(cleanVendor)}</NAME>\n`;
    xml += `            <PARENT>Sundry Creditors</PARENT>\n`;
    xml += `            <ISBILLWISEON>Yes</ISBILLWISEON>\n`;
    if (gstin) {
        xml += `            <PARTYGSTIN>${escapeXml(gstin)}</PARTYGSTIN>\n`;
    }
    if (supplier_address) {
        xml += `            <ADDRESS.LIST>\n`;
        xml += `              <ADDRESS>${escapeXml(supplier_address)}</ADDRESS>\n`;
        xml += `            </ADDRESS.LIST>\n`;
    }
    if (supplier_state) {
        xml += `            <STATENAME>${escapeXml(supplier_state)}</STATENAME>\n`;
    }
    xml += `          </LEDGER>\n`;
    xml += `        </TALLYMESSAGE>\n`;

    xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
    xml += `          <VOUCHER VCHTYPE="Purchase" ACTION="Create">\n`;
    xml += `            <DATE>${dateFormatted}</DATE>\n`;
    xml += `            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>\n`;
    xml += `            <VOUCHERNUMBER>${escapeXml(invNo)}</VOUCHERNUMBER>\n`;
    xml += `            <REFERENCE>${escapeXml(invNo)}</REFERENCE>\n`;
    xml += `            <PARTYLEDGERNAME>${escapeXml(cleanVendor)}</PARTYLEDGERNAME>\n`;
    if (items && items.length > 0) {
        xml += `            <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>\n`;
    } else {
        xml += `            <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>\n`;
    }
    if (buyer_order_no) {
        xml += `            <BASICBUYERORDERNO>${escapeXml(buyer_order_no)}</BASICBUYERORDERNO>\n`;
    }
    if (supplier_ref) {
        xml += `            <PARTYREFERENCE>${escapeXml(supplier_ref)}</PARTYREFERENCE>\n`;
    }
    if (vehicle_number) {
        xml += `            <VCHBKGTRANSPORT>${escapeXml(vehicle_number)}</VCHBKGTRANSPORT>\n`;
    }

    xml += `            <ALLLEDGERENTRIES.LIST>\n`;
    xml += `              <LEDGERNAME>${escapeXml(cleanVendor)}</LEDGERNAME>\n`;
    xml += `              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n`;
    xml += `              <AMOUNT>-${Number(grand_total).toFixed(2)}</AMOUNT>\n`;
    xml += `              <BILLALLOCATIONS.LIST>\n`;
    xml += `                <NAME>${escapeXml(invNo)}</NAME>\n`;
    xml += `                <BILLTYPE>New Ref</BILLTYPE>\n`;
    xml += `                <AMOUNT>-${Number(grand_total).toFixed(2)}</AMOUNT>\n`;
    xml += `              </BILLALLOCATIONS.LIST>\n`;
    xml += `            </ALLLEDGERENTRIES.LIST>\n`;

    if (items && items.length > 0) {
        items.forEach(item => {
            const itemName = escapeXml(item.description || 'Item');
            const itemQty = escapeXml(`${item.quantity || 1} ${item.unit || 'Nos'}`);
            const itemRate = escapeXml(`${item.rate || 0}/${item.unit || 'Nos'}`);
            const itemTaxable = Number(item.taxable_value || 0).toFixed(2);

            xml += `            <ALLINVENTORYENTRIES.LIST>\n`;
            xml += `              <STOCKITEMNAME>${itemName}</STOCKITEMNAME>\n`;
            xml += `              <HSNCODE>${escapeXml(item.hsn_sac || '')}</HSNCODE>\n`;
            xml += `              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n`;
            xml += `              <RATE>${itemRate}</RATE>\n`;
            xml += `              <AMOUNT>-${itemTaxable}</AMOUNT>\n`;
            xml += `              <ACTUALQTY>${itemQty}</ACTUALQTY>\n`;
            xml += `              <BILLEDQTY>${itemQty}</BILLEDQTY>\n`;
            xml += `              <ACCOUNTINGALLOCATIONS.LIST>\n`;
            xml += `                <LEDGERNAME>${escapeXml(purchase_ledger)}</LEDGERNAME>\n`;
            xml += `                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n`;
            xml += `                <AMOUNT>-${itemTaxable}</AMOUNT>\n`;
            xml += `              </ACCOUNTINGALLOCATIONS.LIST>\n`;
            xml += `            </ALLINVENTORYENTRIES.LIST>\n`;
        });
    } else {
        if (taxable_amount > 0) {
            xml += `            <ALLLEDGERENTRIES.LIST>\n`;
            xml += `              <LEDGERNAME>${escapeXml(purchase_ledger)}</LEDGERNAME>\n`;
            xml += `              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n`;
            xml += `              <AMOUNT>${Number(taxable_amount).toFixed(2)}</AMOUNT>\n`;
            xml += `            </ALLLEDGERENTRIES.LIST>\n`;
        }
    }

    if (cgst_amount > 0) {
        xml += `            <ALLLEDGERENTRIES.LIST>\n`;
        xml += `              <LEDGERNAME>${escapeXml(cgst_ledger)}</LEDGERNAME>\n`;
        xml += `              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n`;
        xml += `              <AMOUNT>${Number(cgst_amount).toFixed(2)}</AMOUNT>\n`;
        xml += `            </ALLLEDGERENTRIES.LIST>\n`;
    }

    if (sgst_amount > 0) {
        xml += `            <ALLLEDGERENTRIES.LIST>\n`;
        xml += `              <LEDGERNAME>${escapeXml(sgst_ledger)}</LEDGERNAME>\n`;
        xml += `              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n`;
        xml += `              <AMOUNT>${Number(sgst_amount).toFixed(2)}</AMOUNT>\n`;
        xml += `            </ALLLEDGERENTRIES.LIST>\n`;
    }

    if (igst_amount > 0) {
        xml += `            <ALLLEDGERENTRIES.LIST>\n`;
        xml += `              <LEDGERNAME>${escapeXml(igst_ledger)}</LEDGERNAME>\n`;
        xml += `              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n`;
        xml += `              <AMOUNT>${Number(igst_amount).toFixed(2)}</AMOUNT>\n`;
        xml += `            </ALLLEDGERENTRIES.LIST>\n`;
    }

    if (roundoff_amount !== 0) {
        const isPos = roundoff_amount > 0;
        xml += `            <ALLLEDGERENTRIES.LIST>\n`;
        xml += `              <LEDGERNAME>${escapeXml(roundoff_ledger)}</LEDGERNAME>\n`;
        xml += `              <ISDEEMEDPOSITIVE>${isPos ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>\n`;
        xml += `              <AMOUNT>${Number(roundoff_amount).toFixed(2)}</AMOUNT>\n`;
        xml += `            </ALLLEDGERENTRIES.LIST>\n`;
    }

    xml += `          </VOUCHER>\n`;
    xml += `        </TALLYMESSAGE>\n`;
    xml += `      </REQUESTDATA>\n`;
    xml += `    </IMPORTDATA>\n`;
    xml += `  </BODY>\n`;
    xml += `</ENVELOPE>`;

    return xml;
}

// Utility: Audit math check & status calculation
function auditInvoiceData(raw) {
    const taxable = parseFloat(raw.taxable_amount || raw.taxableAmount || 0);
    const cgst = parseFloat(raw.cgst_amount || 0);
    const sgst = parseFloat(raw.sgst_amount || 0);
    const igst = parseFloat(raw.igst_amount || 0);
    let roundoff = parseFloat(raw.roundoff_amount || raw.roundoffAmount || 0);
    const grandTotal = parseFloat(raw.grand_total || raw.totalAmount || 0);

    const calculatedSubtotal = Math.round((taxable + cgst + sgst + igst) * 100) / 100;
    const diffWithRoundoff = Math.round((grandTotal - (calculatedSubtotal + roundoff)) * 100) / 100;

    let mathDiff = diffWithRoundoff;

    if (Math.abs(diffWithRoundoff) > 0 && Math.abs(diffWithRoundoff) <= 1.0) {
        roundoff = Math.round((grandTotal - calculatedSubtotal) * 100) / 100;
        mathDiff = 0.0;
    } else if (Math.abs(diffWithRoundoff) === 0) {
        mathDiff = 0.0;
    }

    const vendorName = (raw.supplier_name || raw.vendor_name || raw.vendorName || '').trim();
    const invNum = (raw.invoice_number || raw.invoiceNumber || '').trim();
    const gstin = (raw.supplier_gstin || raw.gstin || '').trim();
    const isGstinValid = gstin ? validateGstin(gstin) : false;
    const hasEssentialFields = Boolean(vendorName && invNum && grandTotal > 0);

    let status = 'needs_review';
    if (mathDiff !== 0.0) {
        status = 'math_error';
    } else if (hasEssentialFields && isGstinValid) {
        status = 'verified';
    } else if (hasEssentialFields) {
        status = 'needs_review';
    }

    return {
        invoice_number: invNum,
        invoice_date: raw.invoice_date || raw.invoiceDate || '',
        vendor_name: vendorName,
        gstin: gstin.toUpperCase(),
        buyer_order_no: raw.buyer_order_no || '',
        supplier_ref: raw.supplier_ref || '',
        vehicle_number: raw.vehicle_number || '',
        payment_mode: raw.payment_mode || '',
        supplier_address: raw.supplier_address || '',
        supplier_state: raw.supplier_state || '',
        taxable_amount: taxable,
        cgst_amount: cgst,
        sgst_amount: sgst,
        igst_amount: igst,
        roundoff_amount: roundoff,
        grand_total: grandTotal,
        verification_state: status,
        math_difference: mathDiff,
        items: raw.items || []
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
// Helper: Call Gemini AI with gemini-2.5-flash and retry mechanism
async function processFileWithGemini(genAI, filePath, mimeType, res = null) {
    const imagePart = fileToGenerativePart(filePath, mimeType);
    const prompt = `
    Extract invoice metadata from this Indian vendor invoice image or document.
    Return a valid JSON object with the following exact keys:
    - "invoice_number": (string) Unique invoice or bill number
    - "invoice_date": (string) Date in YYYY-MM-DD format
    - "buyer_order_no": (string) Buyer's order number
    - "supplier_ref": (string) Supplier's reference
    - "vehicle_number": (string) Vehicle number
    - "payment_mode": (string) Payment mode
    - "supplier_name": (string) Supplier/seller company full name
    - "supplier_gstin": (string) 15-character GSTIN number of the vendor (supplier)
    - "supplier_address": (string) Full address of the supplier
    - "supplier_state": (string) State of the supplier
    - "taxable_amount": (number) Subtotal taxable amount before tax
    - "cgst_amount": (number) Central GST amount (0.0 if not present)
    - "sgst_amount": (number) State GST amount (0.0 if not present)
    - "igst_amount": (number) Integrated GST amount (0.0 if not present)
    - "roundoff_amount": (number) Rounding adjustment amount
    - "grand_total": (number) Final payable total amount
    - "place_of_supply": (string) Place/State of supply (e.g. Maharashtra)
    - "items": (array of objects) Extract EVERY single line item present in the invoice table without summarizing, grouping, or truncating the list. Each object must have:
        - "description": (string) Item description / Ledger
        - "hsn_sac": (string) HSN/SAC code
        - "quantity": (number) Item quantity
        - "unit": (string) Item unit (e.g., "Nos", "Box", "Pkt")
        - "rate": (number) Item rate (₹)
        - "taxable_value": (number) Taxable value of the item
        - "gst_rate": (number) GST rate applied
        - "gst_amount": (number) Total GST amount for the item
        - "total": (number) Final total for the item

    STRICT DIRECTIVES:
    1. If the document is rotated, visually auto-orient it before extraction.
    2. If the document contains excessive terms or marketing text, ignore it. Extract ONLY the requested JSON keys.
    3. If a data point (like GSTIN or HSN) is missing, output null for text and 0 for numeric fields. Do NOT refuse to extract the document.
    4. Visual Primacy: You must extract the EXACT numeric values printed on the invoice image for Rate and Taxable Value. DO NOT guess or alter numbers. If an item says '750', extract '750'.
    5. Mathematical Validation Order: When cross-checking (Quantity * Rate = Taxable Value), if the math does not align, assume your OCR/vision reading of the numbers is wrong. Re-read the image carefully. DO NOT alter the extracted 'Taxable Value' to fit a hallucinated 'Rate'. The final Taxable Value column is your absolute source of truth.
    6. Grand Total Validation: Before returning the JSON, add up the 'taxable_value' of every single line item. This sum MUST equal the 'Sub-Total' or 'Total Taxable Value' printed at the bottom of the invoice table. If it does not match, you have misread an item's rate or taxable value.

    Ensure numeric amounts are precise numbers without currency symbols.
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const result = await model.generateContent([prompt, imagePart]);
            let responseText = result.response.text();
            try {
                return JSON.parse(responseText);
            } catch (jsonErr) {
                // If partial JSON is returned, sanitize it and return it instead of throwing a 500 error
                const sanitized = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
                return JSON.parse(sanitized);
            }
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
                        invoiceNumber: audited.invoice_number,
                        invoiceDate: audited.invoice_date,
                        buyerOrderNo: audited.buyer_order_no,
                        supplierRef: audited.supplier_ref,
                        vehicleNumber: audited.vehicle_number,
                        paymentMode: audited.payment_mode,
                        supplierAddress: audited.supplier_address,
                        supplierState: audited.supplier_state,
                        vendorName: audited.vendor_name,
                        gstin: audited.gstin,
                        placeOfSupply: extractedRaw.place_of_supply || 'Maharashtra',
                        tallyLedgerName: finalLedgerName,
                        narration: extractedRaw.narration || `Purchase from ${audited.vendor_name || 'Vendor'} vide Invoice #${audited.invoice_number || ''}`,
                        items: audited.items,
                        taxableAmount: audited.taxable_amount,
                        taxBreakdown: {
                            cgst: audited.cgst_amount,
                            sgst: audited.sgst_amount,
                            igst: audited.igst_amount
                        },
                        roundoffAmount: audited.roundoff_amount,
                        roundOff: audited.roundoff_amount ? Number(audited.roundoff_amount).toFixed(2) : '0.00',
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
                    return JSON.parse(row.fullData);
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

            // Build the data object expected by generateTallyXml
            const xmlInput = {
                invoice_number:    merged.invoiceNumber   || merged.invoice_number   || '',
                invoice_date:      merged.invoiceDate     || merged.invoice_date     || '',
                vendor_name:       merged.vendorName      || merged.vendor_name      || '',
                gstin:             merged.gstin           || '',
                supplier_address:  merged.supplierAddress || merged.supplier_address || '',
                supplier_state:    merged.supplierState   || merged.supplier_state   || '',
                buyer_order_no:    merged.buyerOrderNo    || merged.buyer_order_no   || '',
                supplier_ref:      merged.supplierRef     || merged.supplier_ref     || '',
                vehicle_number:    merged.vehicleNumber   || merged.vehicle_number   || '',
                taxable_amount:    parseFloat(merged.taxableAmount  || merged.taxable_amount  || 0),
                cgst_amount:       parseFloat(merged.taxBreakdown?.cgst || merged.cgst_amount || 0),
                sgst_amount:       parseFloat(merged.taxBreakdown?.sgst || merged.sgst_amount || 0),
                igst_amount:       parseFloat(merged.taxBreakdown?.igst || merged.igst_amount || 0),
                roundoff_amount:   parseFloat(merged.roundoffAmount || merged.roundoff_amount || 0),
                grand_total:       parseFloat(merged.totalAmount    || merged.grand_total     || 0),
                purchase_ledger:   merged.tallyLedgerName || 'Purchase Account',
                items:             merged.items || []
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
app.listen(PORT, () => {
    console.log(`========================================================`);
    console.log(`⚡ TallyFlow AI Backend Middleware Server Running`);
    console.log(`🔒 Security: Gemini API Key secured on backend via .env`);
    console.log(`🌐 Server Base URL: http://localhost:${PORT}`);
    console.log(`🚀 API Endpoint:   http://localhost:${PORT}/api/extract-invoice`);
    console.log(`========================================================`);
});

