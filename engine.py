import os
import re
import sqlite3
import xml.etree.ElementTree as ET
from xml.dom import minidom
from datetime import datetime
from typing import Dict, List, Optional, Tuple, Any
import json
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).parent.resolve()
DATA_DIR = BASE_DIR / "data"
INVOICES_DIR = BASE_DIR / "invoices"
EXPORTS_DIR = BASE_DIR / "exports"
DB_PATH = DATA_DIR / "tallyflow.db"

# Ensure directories exist
DATA_DIR.mkdir(exist_ok=True)
INVOICES_DIR.mkdir(exist_ok=True)
EXPORTS_DIR.mkdir(exist_ok=True)

# GSTIN Regex: 15 alphanumeric characters matching Indian GSTIN format
GSTIN_REGEX = r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$"


def get_db_connection() -> sqlite3.Connection:
    """Returns a connection to the SQLite database with Row factory enabled."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Initializes SQLite database schema and seeds default settings if empty."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        
        # Settings table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                gemini_api_key TEXT,
                tally_host TEXT DEFAULT 'localhost',
                tally_port INTEGER DEFAULT 9000,
                default_purchase_ledger TEXT DEFAULT 'Purchase Account',
                default_cgst_ledger TEXT DEFAULT 'Input CGST',
                default_sgst_ledger TEXT DEFAULT 'Input SGST',
                default_igst_ledger TEXT DEFAULT 'Input IGST',
                default_roundoff_ledger TEXT DEFAULT 'Round Off'
            )
        """)
        
        # Seed default settings row if not present
        cursor.execute("SELECT COUNT(*) FROM settings")
        if cursor.fetchone()[0] == 0:
            cursor.execute("""
                INSERT INTO settings (id, gemini_api_key, tally_host, tally_port, 
                                     default_purchase_ledger, default_cgst_ledger, 
                                     default_sgst_ledger, default_igst_ledger, default_roundoff_ledger)
                VALUES (1, '', 'localhost', 9000, 'Purchase Account', 'Input CGST', 'Input SGST', 'Input IGST', 'Round Off')
            """)

        # Vendors table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS vendors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vendor_name TEXT UNIQUE NOT NULL,
                gstin TEXT,
                state TEXT,
                tally_ledger_name TEXT NOT NULL,
                maintain_billwise INTEGER DEFAULT 1
            )
        """)

        # Invoices table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS invoices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                invoice_number TEXT,
                invoice_date TEXT,
                vendor_name TEXT,
                gstin TEXT,
                taxable_amount REAL DEFAULT 0.0,
                cgst_amount REAL DEFAULT 0.0,
                sgst_amount REAL DEFAULT 0.0,
                igst_amount REAL DEFAULT 0.0,
                roundoff_amount REAL DEFAULT 0.0,
                grand_total REAL DEFAULT 0.0,
                status TEXT DEFAULT 'Needs Review',
                math_difference REAL DEFAULT 0.0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        conn.commit()


# Initialize database on module import
init_db()


def get_settings() -> Dict[str, Any]:
    """Fetch global settings dictionary."""
    with get_db_connection() as conn:
        row = conn.execute("SELECT * FROM settings WHERE id = 1").fetchone()
        return dict(row) if row else {}


def update_settings(tally_host: str, tally_port: int,
                    default_purchase_ledger: str, default_cgst_ledger: str,
                    default_sgst_ledger: str, default_igst_ledger: str,
                    default_roundoff_ledger: str, gemini_api_key: str = "") -> None:
    """Update system configuration settings."""
    with get_db_connection() as conn:
        conn.execute("""
            UPDATE settings SET
                tally_host = ?,
                tally_port = ?,
                default_purchase_ledger = ?,
                default_cgst_ledger = ?,
                default_sgst_ledger = ?,
                default_igst_ledger = ?,
                default_roundoff_ledger = ?
            WHERE id = 1
        """, (tally_host, tally_port,
              default_purchase_ledger, default_cgst_ledger,
              default_sgst_ledger, default_igst_ledger, default_roundoff_ledger))
        conn.commit()


def get_vendor_by_name(vendor_name: str) -> Optional[Dict[str, Any]]:
    """Look up a vendor by name (case-insensitive substring match or exact match)."""
    if not vendor_name:
        return None
    with get_db_connection() as conn:
        # Try exact match first
        row = conn.execute("SELECT * FROM vendors WHERE LOWER(vendor_name) = LOWER(?)", (vendor_name.strip(),)).fetchone()
        if row:
            return dict(row)
        # Try like match
        row = conn.execute("SELECT * FROM vendors WHERE LOWER(vendor_name) LIKE LOWER(?)", (f"%{vendor_name.strip()}%",)).fetchone()
        return dict(row) if row else None


def save_vendor(vendor_name: str, gstin: str, state: str, tally_ledger_name: str, maintain_billwise: int = 1) -> int:
    """Create or update vendor entry in database."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO vendors (vendor_name, gstin, state, tally_ledger_name, maintain_billwise)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(vendor_name) DO UPDATE SET
                gstin = excluded.gstin,
                state = excluded.state,
                tally_ledger_name = excluded.tally_ledger_name,
                maintain_billwise = excluded.maintain_billwise
        """, (vendor_name.strip(), gstin.strip().upper(), state.strip(), tally_ledger_name.strip(), maintain_billwise))
        conn.commit()
        return cursor.lastrowid or 0


def validate_gstin(gstin: str) -> bool:
    """Validates whether a GSTIN string follows Indian 15-character standard format."""
    if not gstin or len(gstin.strip()) != 15:
        return False
    return bool(re.match(GSTIN_REGEX, gstin.strip().upper()))


def audit_and_compute_status(invoice: Dict[str, Any]) -> Tuple[str, float, float]:
    """
    Performs math delta calculation, auto-allocates round-off within ₹1.00 tolerance,
    and returns tuple: (assigned_status, adjusted_roundoff, math_difference).
    """
    taxable = float(invoice.get("taxable_amount") or 0.0)
    cgst = float(invoice.get("cgst_amount") or 0.0)
    sgst = float(invoice.get("sgst_amount") or 0.0)
    igst = float(invoice.get("igst_amount") or 0.0)
    roundoff = float(invoice.get("roundoff_amount") or 0.0)
    grand_total = float(invoice.get("grand_total") or 0.0)

    # Sum of items & taxes
    calculated_subtotal = round(taxable + cgst + sgst + igst, 2)
    # Target without roundoff
    raw_delta = round(grand_total - calculated_subtotal, 2)
    
    # Check current difference with existing roundoff
    diff_with_roundoff = round(grand_total - (calculated_subtotal + roundoff), 2)
    
    final_roundoff = roundoff
    math_diff = diff_with_roundoff

    # Auto round-off allocation if difference is within ₹1.00 tolerance
    if abs(diff_with_roundoff) > 0.00 and abs(diff_with_roundoff) <= 1.00:
        final_roundoff = round(grand_total - calculated_subtotal, 2)
        math_diff = 0.0
    elif abs(diff_with_roundoff) == 0.0:
        math_diff = 0.0

    # Status Determination logic
    vendor_name = (invoice.get("vendor_name") or "").strip()
    inv_num = (invoice.get("invoice_number") or "").strip()
    gstin = (invoice.get("gstin") or "").strip()

    is_gstin_valid = validate_gstin(gstin) if gstin else True  # allow unstated gstin if not strict, but flag if bad format
    has_essential_fields = bool(vendor_name and inv_num and grand_total > 0)
    
    if math_diff != 0.0:
        status = "Math Error"
    elif not has_essential_fields or (gstin and not is_gstin_valid):
        status = "Needs Review"
    else:
        # Check vendor mapping
        vendor_info = get_vendor_by_name(vendor_name)
        status = "Verified" if vendor_info else "Needs Review"

    return status, final_roundoff, math_diff


def extract_invoice_data_with_gemini(file_path: str, api_key: Optional[str] = None) -> Dict[str, Any]:
    """
    Extracts invoice attributes from image/PDF using google-genai SDK (gemini-2.5-flash).
    Returns dictionary with extracted values.
    """
    if not api_key:
        settings = get_settings()
        api_key = settings.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY", "")

    if not api_key:
        raise ValueError("Gemini API key is not configured. Please set it in Settings.")

    from google import genai
    from google.genai import types
    from PIL import Image

    client = genai.Client(api_key=api_key)

    # Prepare file content
    file_ext = Path(file_path).suffix.lower()
    
    if file_ext in [".png", ".jpg", ".jpeg", ".webp"]:
        image = Image.open(file_path)
        content_item = image
    else:
        # For PDF or other files, read raw bytes with mime type
        mime_type = "application/pdf" if file_ext == ".pdf" else "image/png"
        with open(file_path, "rb") as f:
            file_bytes = f.read()
        content_item = types.Part.from_bytes(data=file_bytes, mime_type=mime_type)

    prompt = """
    Extract invoice metadata from this Indian vendor invoice.
    Return a structured JSON object containing:
    - invoice_number (string): Unique invoice / bill number
    - invoice_date (string): Date of invoice formatted as YYYY-MM-DD
    - vendor_name (string): Full name of the supplier/seller company
    - gstin (string): 15-character GSTIN number of the vendor (supplier)
    - taxable_amount (number): Total taxable amount before GST/taxes
    - cgst_amount (number): Central GST amount (0.0 if not applicable)
    - sgst_amount (number): State GST amount (0.0 if not applicable)
    - igst_amount (number): Integrated GST amount (0.0 if not applicable)
    - roundoff_amount (number): Rounding adjustment amount (can be positive or negative)
    - grand_total (number): Final payable grand total amount
    
    Important: Ensure numerical amounts are accurate floating point numbers.
    """

    # Schema definition for JSON response
    response_schema = {
        "type": "OBJECT",
        "properties": {
            "invoice_number": {"type": "STRING"},
            "invoice_date": {"type": "STRING"},
            "vendor_name": {"type": "STRING"},
            "gstin": {"type": "STRING"},
            "taxable_amount": {"type": "NUMBER"},
            "cgst_amount": {"type": "NUMBER"},
            "sgst_amount": {"type": "NUMBER"},
            "igst_amount": {"type": "NUMBER"},
            "roundoff_amount": {"type": "NUMBER"},
            "grand_total": {"type": "NUMBER"}
        },
        "required": ["invoice_number", "vendor_name", "grand_total"]
    }

    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[content_item, prompt],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=response_schema,
                temperature=0.1
            )
        )
        
        data = json.loads(response.text)
        return data
    except Exception as e:
        # Fallback or re-raise
        raise RuntimeError(f"Gemini Extraction Failed: {str(e)}")


def process_and_save_invoice(file_name: str, file_path: str, raw_extracted: Optional[Dict[str, Any]] = None) -> int:
    """
    Saves an invoice to DB after performing math verification and status calculation.
    If raw_extracted is not provided, runs Gemini extraction.
    """
    settings = get_settings()
    api_key = settings.get("gemini_api_key", "")

    if raw_extracted is None:
        raw_extracted = extract_invoice_data_with_gemini(file_path, api_key=api_key)

    invoice_data = {
        "file_name": file_name,
        "file_path": str(file_path),
        "invoice_number": str(raw_extracted.get("invoice_number") or "").strip(),
        "invoice_date": str(raw_extracted.get("invoice_date") or "").strip(),
        "vendor_name": str(raw_extracted.get("vendor_name") or "").strip(),
        "gstin": str(raw_extracted.get("gstin") or "").strip().upper(),
        "taxable_amount": float(raw_extracted.get("taxable_amount") or 0.0),
        "cgst_amount": float(raw_extracted.get("cgst_amount") or 0.0),
        "sgst_amount": float(raw_extracted.get("sgst_amount") or 0.0),
        "igst_amount": float(raw_extracted.get("igst_amount") or 0.0),
        "roundoff_amount": float(raw_extracted.get("roundoff_amount") or 0.0),
        "grand_total": float(raw_extracted.get("grand_total") or 0.0)
    }

    status, final_roundoff, math_diff = audit_and_compute_status(invoice_data)
    invoice_data["roundoff_amount"] = final_roundoff
    invoice_data["status"] = status
    invoice_data["math_difference"] = math_diff

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO invoices (
                file_name, file_path, invoice_number, invoice_date, vendor_name, gstin,
                taxable_amount, cgst_amount, sgst_amount, igst_amount, roundoff_amount,
                grand_total, status, math_difference
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            invoice_data["file_name"], invoice_data["file_path"], invoice_data["invoice_number"],
            invoice_data["invoice_date"], invoice_data["vendor_name"], invoice_data["gstin"],
            invoice_data["taxable_amount"], invoice_data["cgst_amount"], invoice_data["sgst_amount"],
            invoice_data["igst_amount"], invoice_data["roundoff_amount"], invoice_data["grand_total"],
            invoice_data["status"], invoice_data["math_difference"]
        ))
        conn.commit()
        return cursor.lastrowid or 0


def update_invoice(invoice_id: int, invoice_fields: Dict[str, Any]) -> Tuple[str, float]:
    """Updates an invoice's fields in DB and recalculates status and math difference."""
    status, final_roundoff, math_diff = audit_and_compute_status(invoice_fields)
    invoice_fields["roundoff_amount"] = final_roundoff
    invoice_fields["status"] = status
    invoice_fields["math_difference"] = math_diff

    with get_db_connection() as conn:
        conn.execute("""
            UPDATE invoices SET
                invoice_number = ?,
                invoice_date = ?,
                vendor_name = ?,
                gstin = ?,
                taxable_amount = ?,
                cgst_amount = ?,
                sgst_amount = ?,
                igst_amount = ?,
                roundoff_amount = ?,
                grand_total = ?,
                status = ?,
                math_difference = ?
            WHERE id = ?
        """, (
            invoice_fields.get("invoice_number", ""),
            invoice_fields.get("invoice_date", ""),
            invoice_fields.get("vendor_name", ""),
            invoice_fields.get("gstin", ""),
            float(invoice_fields.get("taxable_amount") or 0.0),
            float(invoice_fields.get("cgst_amount") or 0.0),
            float(invoice_fields.get("sgst_amount") or 0.0),
            float(invoice_fields.get("igst_amount") or 0.0),
            float(invoice_fields.get("roundoff_amount") or 0.0),
            float(invoice_fields.get("grand_total") or 0.0),
            status,
            math_diff,
            invoice_id
        ))
        conn.commit()
    return status, math_diff


def get_all_invoices() -> List[Dict[str, Any]]:
    """Retrieve all invoices from SQLite."""
    with get_db_connection() as conn:
        rows = conn.execute("SELECT * FROM invoices ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows]


def get_invoice_by_id(invoice_id: int) -> Optional[Dict[str, Any]]:
    """Retrieve invoice by ID."""
    with get_db_connection() as conn:
        row = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        return dict(row) if row else None


def delete_invoice(invoice_id: int) -> None:
    """Delete an invoice by ID."""
    with get_db_connection() as conn:
        conn.execute("DELETE FROM invoices WHERE id = ?", (invoice_id,))
        conn.commit()


def format_tally_date(date_str: str, safe_edu: bool = True) -> str:
    """
    Format invoice date to Tally YYYYMMDD format.
    If safe_edu is True, clamps day to 01 (YYYYMM01) for Educational Mode compatibility.
    """
    if not date_str:
        now = datetime.now()
        return now.strftime("%Y%m01" if safe_edu else "%Y%m%d")

    # Try parsing common date formats
    clean_date = date_str.strip()
    parsed_dt = None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d", "%d.%m.%Y"):
        try:
            parsed_dt = datetime.strptime(clean_date, fmt)
            break
        except ValueError:
            continue

    if not parsed_dt:
        parsed_dt = datetime.now()

    if safe_edu:
        return parsed_dt.strftime("%Y%m01")
    return parsed_dt.strftime("%Y%m%d")


def export_batch_to_tally_xml(invoice_ids: List[int], output_path: str, safe_edu: bool = True) -> str:
    """
    Generates TallyPrime Purchase Vouchers XML file for the given invoice IDs.
    
    Features:
    - Prepends <LEDGER ACTION="Create"> blocks for unmapped vendors under <PARENT>Sundry Creditors</PARENT>.
    - Wraps all vouchers in a single <ENVELOPE><BODY><IMPORTDATA><REQUESTDATA> block.
    - Observes debit/credit conventions (Creditor negative with ISDEEMEDPOSITIVE=No; Purchase & Taxes positive with ISDEEMEDPOSITIVE=Yes).
    - Includes Educational Mode date clamp to 1st of month when safe_edu=True.
    """
    settings = get_settings()
    pur_ledger = settings.get("default_purchase_ledger") or "Purchase Account"
    cgst_ledger = settings.get("default_cgst_ledger") or "Input CGST"
    sgst_ledger = settings.get("default_sgst_ledger") or "Input SGST"
    igst_ledger = settings.get("default_igst_ledger") or "Input IGST"
    roundoff_ledger = settings.get("default_roundoff_ledger") or "Round Off"

    with get_db_connection() as conn:
        placeholders = ",".join(["?"] * len(invoice_ids))
        invoices = [dict(r) for r in conn.execute(f"SELECT * FROM invoices WHERE id IN ({placeholders})", invoice_ids).fetchall()]

    if not invoices:
        raise ValueError("No invoices selected for export.")

    # Build XML Root Envelope
    envelope = ET.Element("ENVELOPE")
    header = ET.SubElement(envelope, "HEADER")
    ET.SubElement(header, "TALLYREQUEST").text = "Import Data"

    body = ET.SubElement(envelope, "BODY")
    importdata = ET.SubElement(body, "IMPORTDATA")
    
    reqdesc = ET.SubElement(importdata, "REQUESTDESC")
    ET.SubElement(reqdesc, "REPORTNAME").text = "Vouchers"
    staticvars = ET.SubElement(reqdesc, "STATICVARIABLES")
    ET.SubElement(staticvars, "SVCURRENTCOMPANY").text = "##SVCURRENTCOMPANY"

    reqdata = ET.SubElement(importdata, "REQUESTDATA")

    # Keep track of created vendor ledgers to avoid duplicate <LEDGER> tags in XML
    created_vendor_ledgers = set()

    for inv in invoices:
        vendor_name = (inv.get("vendor_name") or "Unknown Vendor").strip()
        vendor_info = get_vendor_by_name(vendor_name)
        
        tally_ledger_name = vendor_info["tally_ledger_name"] if vendor_info else vendor_name
        maintain_billwise = vendor_info["maintain_billwise"] if vendor_info else 1
        gstin = inv.get("gstin") or (vendor_info.get("gstin") if vendor_info else "")

        # 1. Prepend <LEDGER ACTION="Create"> if vendor is unmapped or not in system
        if not vendor_info and tally_ledger_name not in created_vendor_ledgers:
            created_vendor_ledgers.add(tally_ledger_name)
            msg_ledger = ET.SubElement(reqdata, "TALLYMESSAGE", {"xmlns:UDF": "TallyUDF"})
            ledger_node = ET.SubElement(msg_ledger, "LEDGER", {"NAME": tally_ledger_name, "ACTION": "Create"})
            ET.SubElement(ledger_node, "NAME").text = tally_ledger_name
            ET.SubElement(ledger_node, "PARENT").text = "Sundry Creditors"
            ET.SubElement(ledger_node, "ISBILLWISEON").text = "Yes" if maintain_billwise else "No"
            if gstin:
                ET.SubElement(ledger_node, "PARTYGSTIN").text = gstin

        # 2. Add Purchase Voucher XML block
        msg_voucher = ET.SubElement(reqdata, "TALLYMESSAGE", {"xmlns:UDF": "TallyUDF"})
        voucher = ET.SubElement(msg_voucher, "VOUCHER", {"VCHTYPE": "Purchase", "ACTION": "Create"})

        tally_date = format_tally_date(inv.get("invoice_date", ""), safe_edu=safe_edu)
        inv_no = inv.get("invoice_number") or f"INV-{inv['id']}"
        grand_total = float(inv.get("grand_total") or 0.0)
        taxable = float(inv.get("taxable_amount") or 0.0)
        cgst = float(inv.get("cgst_amount") or 0.0)
        sgst = float(inv.get("sgst_amount") or 0.0)
        igst = float(inv.get("igst_amount") or 0.0)
        roundoff = float(inv.get("roundoff_amount") or 0.0)

        ET.SubElement(voucher, "DATE").text = tally_date
        ET.SubElement(voucher, "VOUCHERTYPENAME").text = "Purchase"
        ET.SubElement(voucher, "VOUCHERNUMBER").text = inv_no
        ET.SubElement(voucher, "REFERENCE").text = inv_no
        ET.SubElement(voucher, "PARTYLEDGERNAME").text = tally_ledger_name
        ET.SubElement(voucher, "PERSISTEDVIEW").text = "Accounting Voucher View"

        # --- LEDGER ENTRY 1: Vendor / Creditor (Credit = Negative, ISDEEMEDPOSITIVE=No) ---
        creditor_entry = ET.SubElement(voucher, "ALLLEDGERENTRIES.LIST")
        ET.SubElement(creditor_entry, "LEDGERNAME").text = tally_ledger_name
        ET.SubElement(creditor_entry, "ISDEEMEDPOSITIVE").text = "No"
        # Tally represents credit amounts as negative numbers
        ET.SubElement(creditor_entry, "AMOUNT").text = f"{-grand_total:.2f}"

        if maintain_billwise:
            bill_alloc = ET.SubElement(creditor_entry, "BILLALLOCATIONS.LIST")
            ET.SubElement(bill_alloc, "NAME").text = inv_no
            ET.SubElement(bill_alloc, "BILLTYPE").text = "New Ref"
            ET.SubElement(bill_alloc, "AMOUNT").text = f"{-grand_total:.2f}"

        # --- LEDGER ENTRY 2: Purchase Account (Debit = Positive, ISDEEMEDPOSITIVE=Yes) ---
        if taxable > 0:
            pur_entry = ET.SubElement(voucher, "ALLLEDGERENTRIES.LIST")
            ET.SubElement(pur_entry, "LEDGERNAME").text = pur_ledger
            ET.SubElement(pur_entry, "ISDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(pur_entry, "AMOUNT").text = f"{taxable:.2f}"

        # --- LEDGER ENTRY 3: CGST Account (Debit = Positive, ISDEEMEDPOSITIVE=Yes) ---
        if cgst > 0:
            cgst_entry = ET.SubElement(voucher, "ALLLEDGERENTRIES.LIST")
            ET.SubElement(cgst_entry, "LEDGERNAME").text = cgst_ledger
            ET.SubElement(cgst_entry, "ISDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(cgst_entry, "AMOUNT").text = f"{cgst:.2f}"

        # --- LEDGER ENTRY 4: SGST Account (Debit = Positive, ISDEEMEDPOSITIVE=Yes) ---
        if sgst > 0:
            sgst_entry = ET.SubElement(voucher, "ALLLEDGERENTRIES.LIST")
            ET.SubElement(sgst_entry, "LEDGERNAME").text = sgst_ledger
            ET.SubElement(sgst_entry, "ISDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(sgst_entry, "AMOUNT").text = f"{sgst:.2f}"

        # --- LEDGER ENTRY 5: IGST Account (Debit = Positive, ISDEEMEDPOSITIVE=Yes) ---
        if igst > 0:
            igst_entry = ET.SubElement(voucher, "ALLLEDGERENTRIES.LIST")
            ET.SubElement(igst_entry, "LEDGERNAME").text = igst_ledger
            ET.SubElement(igst_entry, "ISDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(igst_entry, "AMOUNT").text = f"{igst:.2f}"

        # --- LEDGER ENTRY 6: Round Off Account ---
        if roundoff != 0:
            ro_entry = ET.SubElement(voucher, "ALLLEDGERENTRIES.LIST")
            ET.SubElement(ro_entry, "LEDGERNAME").text = roundoff_ledger
            if roundoff > 0:
                ET.SubElement(ro_entry, "ISDEEMEDPOSITIVE").text = "Yes"
                ET.SubElement(ro_entry, "AMOUNT").text = f"{roundoff:.2f}"
            else:
                ET.SubElement(ro_entry, "ISDEEMEDPOSITIVE").text = "No"
                # Negative amount for credit round-off
                ET.SubElement(ro_entry, "AMOUNT").text = f"{roundoff:.2f}"

    # Pretty print XML string
    raw_xml_str = ET.tostring(envelope, encoding="utf-8")
    parsed_dom = minidom.parseString(raw_xml_str)
    pretty_xml = parsed_dom.toprettyxml(indent="  ")

    # Remove extra blank lines generated by minidom tokeep clean XML
    clean_lines = [line for line in pretty_xml.splitlines() if line.strip()]
    final_xml = "\n".join(clean_lines)

    output_file = Path(output_path)
    output_file.parent.mkdir(exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(final_xml)

    return str(output_file)
