require('dotenv').config({ override: true });
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
    processFileWithGemini,
    auditInvoiceData,
    generateTallyXml,
    round2
} = require('./server');

// Ensure API key is configured
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    console.error('❌ Error: GEMINI_API_KEY is not set in environment or .env file');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

// Benchmark test suite of 5 distinct invoice images from project dataset
const TEST_INVOICES = [
    {
        name: 'image (1).png',
        path: path.join(__dirname, 'invoices', 'image (1).png'),
        mimeType: 'image/png'
    },
    {
        name: '20251117_234133.jpg',
        path: path.join(__dirname, 'invoices', 'Photos', 'Photos', '20251117_234133.jpg'),
        mimeType: 'image/jpeg'
    },
    {
        name: '20251117_234149.jpg',
        path: path.join(__dirname, 'invoices', 'Photos', 'Photos', '20251117_234149.jpg'),
        mimeType: 'image/jpeg'
    },
    {
        name: '20251117_234224.jpg',
        path: path.join(__dirname, 'invoices', 'Photos', 'Photos', '20251117_234224.jpg'),
        mimeType: 'image/jpeg'
    },
    {
        name: '20251117_234231.jpg',
        path: path.join(__dirname, 'invoices', 'Photos', 'Photos', '20251117_234231.jpg'),
        mimeType: 'image/jpeg'
    }
];

// Helper: Programmatically parse Tally XML voucher to verify exact Debit === Credit equality
function verifyTallyXmlBalance(xmlStr) {
    if (!xmlStr || typeof xmlStr !== 'string') {
        return { balanced: false, debits: 0, credits: 0, diff: -1, error: 'Empty XML' };
    }

    let totalDebits = 0;
    let totalCredits = 0;

    // 1. Inventory entries (Debits)
    const invMatches = xmlStr.matchAll(/<ALLINVENTORYENTRIES\.LIST>[\s\S]*?<AMOUNT>(-?\d+\.?\d*)<\/AMOUNT>[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/g);
    for (const match of invMatches) {
        const val = Math.abs(parseFloat(match[1]));
        totalDebits = round2(totalDebits + val);
    }

    // 2. Ledger entries
    const ledgerMatches = xmlStr.matchAll(/<LEDGERENTRIES\.LIST>[\s\S]*?<ISDEEMEDPOSITIVE>(Yes|No)<\/ISDEEMEDPOSITIVE>[\s\S]*?<AMOUNT>(-?\d+\.?\d*)<\/AMOUNT>[\s\S]*?<\/LEDGERENTRIES\.LIST>/g);
    for (const match of ledgerMatches) {
        const isDeemedPos = match[1];
        const val = Math.abs(parseFloat(match[2]));
        if (isDeemedPos === 'Yes') {
            totalDebits = round2(totalDebits + val);
        } else {
            totalCredits = round2(totalCredits + val);
        }
    }

    const diff = round2(Math.abs(totalDebits - totalCredits));
    const balanced = diff < 0.005;

    return {
        balanced,
        debits: totalDebits,
        credits: totalCredits,
        diff
    };
}

// Helper: Assert XML Integrity & Contiguous Ledger Entries (Task 1.3)
function verifyXmlStructure(xmlStr) {
    if (!xmlStr || typeof xmlStr !== 'string') {
        return { valid: false, error: 'Empty or non-string XML' };
    }

    // Assertion 1: Must NOT contain the illegal &#4; character or invalid ASCII control characters
    if (xmlStr.includes('&#4;') || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(xmlStr)) {
        return { valid: false, error: 'Contains illegal characters or &#4;' };
    }

    // Assertion 2: In OBJVIEW="Invoice Voucher View", all <ALLINVENTORYENTRIES.LIST> blocks
    // must be emitted together first, followed strictly by all <LEDGERENTRIES.LIST> blocks contiguously without separation.
    const voucherMatch = xmlStr.match(/<VOUCHER\b[^>]*OBJVIEW="Invoice Voucher View"[^>]*>([\s\S]*?)<\/VOUCHER>/);
    if (!voucherMatch) {
        return { valid: false, error: 'Missing VOUCHER with OBJVIEW="Invoice Voucher View"' };
    }

    const voucherContent = voucherMatch[1];
    const tagRegex = /<\/?(ALLINVENTORYENTRIES\.LIST|LEDGERENTRIES\.LIST)>/g;
    let match;
    let seenLedger = false;

    while ((match = tagRegex.exec(voucherContent)) !== null) {
        const tag = match[0];
        if (tag === '<LEDGERENTRIES.LIST>') {
            seenLedger = true;
        } else if (tag === '<ALLINVENTORYENTRIES.LIST>' && seenLedger) {
            return { valid: false, error: 'Inventory entry found after ledger entry (non-contiguous order)' };
        }
    }

    // Ensure all LEDGERENTRIES blocks are contiguous (no foreign blocks between them)
    const firstLedgerIdx = voucherContent.indexOf('<LEDGERENTRIES.LIST>');
    const lastLedgerCloseIdx = voucherContent.lastIndexOf('</LEDGERENTRIES.LIST>');
    if (firstLedgerIdx !== -1 && lastLedgerCloseIdx !== -1) {
        const ledgerSection = voucherContent.substring(firstLedgerIdx, lastLedgerCloseIdx + '</LEDGERENTRIES.LIST>'.length);
        const stripped = ledgerSection.replace(/<LEDGERENTRIES\.LIST>[\s\S]*?<\/LEDGERENTRIES\.LIST>/g, '').trim();
        if (stripped.length > 0) {
            return { valid: false, error: `Non-ledger content inside ledger entries block: "${stripped.slice(0, 50)}"` };
        }
    }

    return { valid: true };
}

async function runBenchmark() {
    console.log('================================================================================');
    console.log('🚀 STARTING UNIVERSAL INDIAN GST EXTRACTION & RECONCILIATION BENCHMARK (5 Invoices)');
    console.log('================================================================================\n');

    const results = [];

    for (let i = 0; i < TEST_INVOICES.length; i++) {
        const item = TEST_INVOICES[i];
        const indexStr = `[${i + 1}/${TEST_INVOICES.length}]`;
        console.log(`--------------------------------------------------------------------------------`);
        console.log(`${indexStr} Processing: ${item.name}`);
        console.log(`   File Path: ${item.path}`);

        if (!fs.existsSync(item.path)) {
            console.error(`   ❌ File not found: ${item.path}`);
            results.push({
                name: item.name,
                rows: 0,
                computedTax: 'N/A',
                roundOff: 'N/A',
                mathVerifiedStatus: 'FAILED (File Not Found)',
                xmlStatus: 'FAILED (File Not Found)'
            });
            continue;
        }

        const startTime = Date.now();
        try {
            console.log(`   Calling Vision OCR extraction...`);
            const rawExtracted = await processFileWithGemini(genAI, item.path, item.mimeType);
            const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`   ✅ OCR complete in ${durationSec}s`);

            // Step 2: auditInvoiceData / math verification
            const audited = auditInvoiceData(rawExtracted);

            // Step 3: Tally XML generation
            const xml = generateTallyXml(audited);

            // Assertions for every test invoice:
            // 1. Math Balance: Math.abs((sum(line_items.taxable_value) + total_cgst + total_sgst + total_igst + freight_charges + round_off) - grand_total) <= 0.01
            const lineItems = audited.line_items || [];
            const sumLineTaxable = round2(lineItems.reduce((acc, it) => acc + (it.taxable_value || 0), 0));
            const totalCgst = audited.total_cgst || 0;
            const totalSgst = audited.total_sgst || 0;
            const totalIgst = audited.total_igst || 0;
            const freightCharges = audited.freight_charges || 0;
            const roundOff = audited.round_off || 0;
            const grandTotal = audited.grand_total || 0;

            const computedDebits = round2(sumLineTaxable + totalCgst + totalSgst + totalIgst + freightCharges + roundOff);
            const mathBalanceDiff = round2(Math.abs(computedDebits - grandTotal));
            const isMathBalanced = mathBalanceDiff <= 0.01;

            // 2. Round Off Limit: Math.abs(round_off) <= 0.99
            const isRoundOffValid = Math.abs(roundOff) <= 0.99;

            // Verification State Check
            const isVerified = audited.verification_state === 'verified';
            const mathPass = isMathBalanced && isRoundOffValid && isVerified;

            // 3. XML Integrity & Contiguous Ledger Entries
            const xmlStructureCheck = verifyXmlStructure(xml);
            const xmlBalanceCheck = verifyTallyXmlBalance(xml);
            const xmlPass = xmlStructureCheck.valid && xmlBalanceCheck.balanced;

            const computedTax = round2(totalCgst + totalSgst + totalIgst);
            const printedSubtotal = audited.printed_taxable_subtotal || 0;
            const printedTax = round2((audited.printed_cgst_total || 0) + (audited.printed_sgst_total || 0) + (audited.printed_igst_total || 0));
            const printedTotal = audited.printed_grand_total || 0;

            console.log(`   Vendor:       "${audited.vendor_name}" (GSTIN: ${audited.vendor_gstin || 'Unregistered'})`);
            console.log(`   Invoice No:   "${audited.invoice_number}" | Date: ${audited.invoice_date}`);
            console.log(`   Line Items:   ${lineItems.length} rows`);
            console.log(`   Taxable:      ₹${audited.total_taxable.toFixed(2)} (Printed: ₹${printedSubtotal.toFixed(2)})`);
            console.log(`   GST Total:    ₹${computedTax.toFixed(2)} [CGST: ${totalCgst.toFixed(2)}, SGST: ${totalSgst.toFixed(2)}, IGST: ${totalIgst.toFixed(2)}] (Printed: ₹${printedTax.toFixed(2)})`);
            console.log(`   Round Off:    ₹${roundOff.toFixed(2)} (${isRoundOffValid ? 'VALID <= ±0.99' : 'INVALID > ±0.99'})`);
            console.log(`   Grand Total:  ₹${grandTotal.toFixed(2)} (Printed: ₹${printedTotal.toFixed(2)})`);
            console.log(`   Math Balance: Debits ₹${computedDebits.toFixed(2)} - GrandTotal ₹${grandTotal.toFixed(2)} = ₹${mathBalanceDiff.toFixed(2)} => ${isMathBalanced ? 'BALANCED <= 0.01 ✅' : 'MISMATCH ❌'}`);
            console.log(`   XML Structure:Contiguous Ledger Entries => ${xmlStructureCheck.valid ? 'VALID ✅' : 'ERROR: ' + xmlStructureCheck.error}`);
            console.log(`   XML Balance:  Debits ₹${xmlBalanceCheck.debits.toFixed(2)} === Credits ₹${xmlBalanceCheck.credits.toFixed(2)} (Diff: ₹${xmlBalanceCheck.diff.toFixed(2)}) => ${xmlBalanceCheck.balanced ? 'BALANCED ✅' : 'MISMATCH ❌'}`);
            console.log(`   Overall:      ${(mathPass && xmlPass) ? '✅ PASS' : '❌ FAIL'}`);

            results.push({
                name: item.name,
                rows: lineItems.length,
                computedTax: `₹${computedTax.toFixed(2)}`,
                roundOff: `₹${roundOff.toFixed(2)}`,
                mathVerifiedStatus: mathPass ? 'VERIFIED' : `FAILED (${audited.verification_state || 'balance error'})`,
                xmlStatus: xmlPass ? 'VALID' : `FAILED (${!xmlStructureCheck.valid ? xmlStructureCheck.error : 'imbalanced'})`
            });
        } catch (err) {
            console.error(`   ❌ Error processing ${item.name}:`, err.message);
            results.push({
                name: item.name,
                rows: 0,
                computedTax: 'ERROR',
                roundOff: 'ERROR',
                mathVerifiedStatus: `FAILED (${err.message.slice(0, 30)})`,
                xmlStatus: 'FAILED (Exception)'
            });
        }
        await new Promise(r => setTimeout(r, 3000));
    }

    console.log('\n================================================================================');
    console.log('📊 FINAL MULTI-INVOICE BENCHMARK REPORT (TASK 1.4)');
    console.log('================================================================================');
    console.table(results.map(r => ({
        'Filename': r.name,
        'Extracted Line Items': r.rows,
        'Computed Tax': r.computedTax,
        'Round Off': r.roundOff,
        'Math Verified Status': r.mathVerifiedStatus,
        'XML Status': r.xmlStatus
    })));

    const allPassed = results.every(r => r.mathVerifiedStatus === 'VERIFIED' && r.xmlStatus === 'VALID');
    console.log(`\nOverall Result: ${allPassed ? '🎉 ALL 5/5 INVOICES PASSED (Math Verified + Valid Tally XML)' : '❌ SOME INVOICES FAILED'}\n`);

    if (!allPassed) {
        process.exit(1);
    }
}

runBenchmark().catch(err => {
    console.error('Fatal benchmark runner error:', err);
    process.exit(1);
});
