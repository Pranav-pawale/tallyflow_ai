const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '.env'), override: true });

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for frontend communication
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

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

// Utility: Generate TallyPrime Purchase Voucher XML
function generateTallyXml(data, options = { safeEduMode: true }) {
    const {
        invoice_number = 'INV-001',
        invoice_date = '',
        vendor_name = 'Vendor Ledger',
        gstin = '',
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
        roundoff_ledger = 'Round Off'
    } = data;

    let dateFormatted = '';
    if (invoice_date) {
        const d = new Date(invoice_date);
        if (!isNaN(d.getTime())) {
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = options.safeEduMode ? '01' : String(d.getDate()).padStart(2, '0');
            dateFormatted = `${year}${month}${day}`;
        }
    }
    if (!dateFormatted) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        dateFormatted = `${year}${month}01`;
    }

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
    xml += `          </LEDGER>\n`;
    xml += `        </TALLYMESSAGE>\n`;

    xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n`;
    xml += `          <VOUCHER VCHTYPE="Purchase" ACTION="Create">\n`;
    xml += `            <DATE>${dateFormatted}</DATE>\n`;
    xml += `            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>\n`;
    xml += `            <VOUCHERNUMBER>${escapeXml(invNo)}</VOUCHERNUMBER>\n`;
    xml += `            <REFERENCE>${escapeXml(invNo)}</REFERENCE>\n`;
    xml += `            <PARTYLEDGERNAME>${escapeXml(cleanVendor)}</PARTYLEDGERNAME>\n`;
    xml += `            <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>\n`;

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

    if (taxable_amount > 0) {
        xml += `            <ALLLEDGERENTRIES.LIST>\n`;
        xml += `              <LEDGERNAME>${escapeXml(purchase_ledger)}</LEDGERNAME>\n`;
        xml += `              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n`;
        xml += `              <AMOUNT>${Number(taxable_amount).toFixed(2)}</AMOUNT>\n`;
        xml += `            </ALLLEDGERENTRIES.LIST>\n`;
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

    const vendorName = (raw.vendor_name || raw.vendorName || '').trim();
    const invNum = (raw.invoice_number || raw.invoiceNumber || '').trim();
    const gstin = (raw.gstin || '').trim();
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
        taxable_amount: taxable,
        cgst_amount: cgst,
        sgst_amount: sgst,
        igst_amount: igst,
        roundoff_amount: roundoff,
        grand_total: grandTotal,
        verification_state: status,
        math_difference: mathDiff
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

// Helper: Call Gemini AI with fallback from 2.5-flash to 1.5-flash
async function processFileWithGemini(genAI, filePath, mimeType) {
    const imagePart = fileToGenerativePart(filePath, mimeType);
    const prompt = `
    Extract invoice metadata from this Indian vendor invoice image or document.
    Return a valid JSON object with the following exact keys:
    - "invoice_number": (string) Unique invoice or bill number
    - "invoice_date": (string) Date in YYYY-MM-DD format
    - "vendor_name": (string) Supplier/seller company full name
    - "gstin": (string) 15-character GSTIN number of the vendor (supplier)
    - "taxable_amount": (number) Subtotal taxable amount before tax
    - "cgst_amount": (number) Central GST amount (0.0 if not present)
    - "sgst_amount": (number) State GST amount (0.0 if not present)
    - "igst_amount": (number) Integrated GST amount (0.0 if not present)
    - "roundoff_amount": (number) Rounding adjustment amount
    - "grand_total": (number) Final payable total amount
    - "place_of_supply": (string) Place/State of supply (e.g. Maharashtra)
    - "narration": (string) Short narration note
    - "hsn_code": (string) HSN/SAC code of main items
    - "quantity": (number or string) Item quantity

    Ensure numeric amounts are precise numbers without currency symbols.
    `;

    const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-latest'];
    let lastError = null;

    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({
                model: modelName,
                generationConfig: {
                    responseMimeType: 'application/json',
                    temperature: 0.1
                }
            });

            const result = await model.generateContent([prompt, imagePart]);
            const responseText = result.response.text();
            return JSON.parse(responseText);
        } catch (err) {
            console.warn(`[Gemini AI] Model ${modelName} failed:`, err.message);
            lastError = err;
        }
    }

    throw new Error(`AI extraction failed: ${lastError ? lastError.message : 'Unknown error'}`);
}

// API ENDPOINT: POST /api/extract-invoice (Supports concurrent multi-file upload processing)
app.post('/api/extract-invoice', upload.any(), async (req, res) => {
    const uploadedFiles = req.files || [];

    try {
        if (!uploadedFiles || uploadedFiles.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No invoice files uploaded. Please select PNG, JPG, WEBP, or PDF files.'
            });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey || apiKey === 'your_gemini_api_key_here' || apiKey.trim() === '') {
            uploadedFiles.forEach(f => { if (fs.existsSync(f.path)) fs.unlink(f.path, () => {}); });
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
                    const extractedRaw = await processFileWithGemini(genAI, file.path, file.mimetype);
                    const audited = auditInvoiceData(extractedRaw);
                    const xml = generateTallyXml(audited);

                    return {
                        id: `inv_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 7)}`,
                        fileName: file.originalname,
                        fileSize: formatBytes(file.size),
                        fileType: file.mimetype.includes('pdf') ? 'pdf' : 'image',
                        invoiceNumber: audited.invoice_number,
                        invoiceDate: audited.invoice_date,
                        vendorName: audited.vendor_name,
                        gstin: audited.gstin,
                        placeOfSupply: extractedRaw.place_of_supply || 'Maharashtra',
                        tallyLedgerName: audited.vendor_name ? `${audited.vendor_name} Ledger` : 'Sundry Creditors',
                        narration: extractedRaw.narration || `Purchase from ${audited.vendor_name || 'Vendor'} vide Invoice #${audited.invoice_number || ''}`,
                        hsnCode: extractedRaw.hsn_code || '998313',
                        quantity: extractedRaw.quantity || 1,
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
                    return {
                        id: `inv_${Date.now()}_${i}_err`,
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
                        hsnCode: 'N/A',
                        quantity: 0,
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
                        fs.unlink(file.path, () => {});
                    }
                }
            })
        );

        return res.status(200).json({
            success: true,
            message: `${processedInvoices.length} invoice(s) processed successfully`,
            data: processedInvoices
        });

    } catch (err) {
        uploadedFiles.forEach(f => {
            if (fs.existsSync(f.path)) fs.unlink(f.path, () => {});
        });
        console.error('Extraction Error:', err.message);
        return res.status(500).json({
            success: false,
            error: err.message || 'An unexpected error occurred during invoice processing.'
        });
    }
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

// Catch-all Multer or Express errors
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    } else if (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
    next();
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

