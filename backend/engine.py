import os
import re
import sqlite3
import xml.etree.ElementTree as ET
from xml.dom import minidom
from datetime import datetime, date
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

# Indian 2-Digit GSTIN State Code Lookup Map (Task 2 Step 2A)
GSTIN_STATE_MAP = {
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
    "28": "Andhra Pradesh",
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
}


def get_state_from_gstin(gstin: Optional[str], fallback: str = "Delhi") -> str:
    """Dynamically derive Indian state name from 15-digit GSTIN (Task 2 Step 2A)."""
    if gstin and len(gstin.strip()) >= 2:
        code = gstin.strip().upper()[:2]
        return GSTIN_STATE_MAP.get(code, fallback)
    return fallback


def get_pan_from_gstin(gstin: Optional[str]) -> str:
    """Extract 10-character PAN from 15-digit GSTIN (Task 2 Step 2A)."""
    if gstin and len(gstin.strip()) == 15:
        return gstin.strip().upper()[2:12]
    return ""


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
    taxable = round(float(invoice.get("taxable_amount") or 0.0), 2)
    cgst = round(float(invoice.get("cgst_amount") or 0.0), 2)
    sgst = round(float(invoice.get("sgst_amount") or 0.0), 2)
    igst = round(float(invoice.get("igst_amount") or 0.0), 2)
    roundoff = round(float(invoice.get("roundoff_amount") or 0.0), 2)
    grand_total = round(float(invoice.get("grand_total") or 0.0), 2)

    # Sum of items & taxes
    calculated_subtotal = round(taxable + cgst + sgst + igst, 2)
    
    # Check current difference with existing roundoff
    diff_with_roundoff = round(grand_total - (calculated_subtotal + roundoff), 2)
    
    final_roundoff = roundoff
    math_diff = diff_with_roundoff

    # Auto round-off allocation if difference is within ₹1.00 tolerance
    if abs(diff_with_roundoff) > 0.00 and abs(diff_with_roundoff) <= 1.00:
        final_roundoff = round(grand_total - calculated_subtotal, 2)
        math_diff = 0.0
    elif abs(diff_with_roundoff) <= 0.05:
        math_diff = 0.0

    # Status Determination logic
    vendor_name = (invoice.get("vendor_name") or "").strip()
    inv_num = (invoice.get("invoice_number") or "").strip()
    gstin = (invoice.get("gstin") or "").strip()

    has_essential_fields = bool(vendor_name and inv_num and grand_total > 0)
    
    if abs(math_diff) > 0.05:
        status = "Math Error"
    elif not has_essential_fields:
        status = "Needs Review"
    else:
        status = "Verified"

    return status, final_roundoff, math_diff

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
    Extract complete invoice metadata from this Indian vendor invoice image or document.
    Return a structured JSON object containing:
    - vendor_name (string): Supplier / Vendor business name
    - vendor_gstin (string): 15-character GSTIN of the supplier
    - vendor_address (string): Full address of supplier
    - vendor_state (string): State of supplier
    - vendor_pincode (string): 6-digit postal PIN code
    - vendor_phone (string): Supplier phone/mobile number
    - bank_name (string): Supplier bank name
    - account_number (string): Supplier bank account number
    - ifsc_code (string): Supplier bank IFSC code
    - upi_id (string): Supplier UPI ID
    - buyer_name (string): Buyer / Bill To / Ship To customer name
    - buyer_gstin (string): Buyer GSTIN
    - buyer_state (string): Buyer state
    - buyer_address (string): Buyer address
    - invoice_number (string): Unique invoice / bill number
    - invoice_date (string): Date parsed strictly from Indian DD-MM-YY or DD-MM-YYYY into ISO YYYY-MM-DD
    - due_date (string): Due date in YYYY-MM-DD format
    - payment_mode (string): Payment mode (UPI, Cash, Bank Transfer, etc.)
    - reverse_charge (string): "Yes" or "No"
    - buyer_order_no (string): Buyer's purchase order number
    - order_date (string): Order date in YYYY-MM-DD format
    - supplier_ref (string): Supplier reference / challan number
    - vehicle_no (string): Vehicle or transport number
    - eway_bill_no (string): E-Way Bill number
    - line_items (array of objects): Extract EVERY single line item without summarizing or truncating:
        - sr_no (number): Row sequence number (1, 2, 3...)
        - description (string): Item description / Ledger
        - hsn_code (string): HSN/SAC string
        - quantity (number): Item quantity
        - uom (string): Unit string (default "Nos" if blank)
        - rate (number): Item rate
        - discount_percent (number): Discount percentage (default 0)
        - taxable_value (number): Taxable value
        - gst_rate (number): GST rate (0, 5, 12, 18, 28)
        - cgst_amount (number): Central GST amount
        - sgst_amount (number): State GST amount
        - igst_amount (number): Integrated GST amount
        - total_amount (number): Total amount
    - printed_taxable_subtotal (number): Sub-total printed on the invoice table/summary
    - printed_cgst_total (number): CGST total printed on summary
    - printed_sgst_total (number): SGST total printed on summary
    - printed_igst_total (number): IGST total printed on summary
    - printed_round_off (number): Round off printed on summary
    - printed_grand_total (number): Final payable grand total printed on summary
    - total_taxable (number): Total taxable value before taxes
    - total_cgst (number): Total Central GST
    - total_sgst (number): Total State GST
    - total_igst (number): Total Integrated GST
    - freight_charges (number): Freight / transport charges (default 0)
    - round_off (number): Rounding adjustment amount (+/- number)
    - grand_total (number): Final payable grand total amount

    Strict Rules:
    1. STRICT SEQUENTIAL ROW EXTRACTION (Sr 1 to Sr N):
       - Scan the line-item table starting immediately below the column header row.
       - Do NOT skip Row 1 (Sr 1), even if flush against header border.
       - Verify line_items.length matches the final Sr number and sum of line_items[].taxable_value equals printed Sub-Total.
    2. PRESERVE PRINTED SUMMARY TOTALS SEPARATELY:
       - Extract printed_taxable_subtotal, printed_cgst_total, printed_sgst_total, printed_igst_total, printed_round_off, and printed_grand_total directly from invoice summary.
    3. Parse Indian dates (DD-MM-YYYY or DD-MM-YY) strictly to ISO (YYYY-MM-DD).
    4. uom defaults to "Nos" if not explicitly specified.
    5. Ensure numerical amounts are accurate numbers without currency symbols.
    """

    # Schema definition for JSON response
    response_schema = {
        "type": "OBJECT",
        "properties": {
            "vendor_name": {"type": "STRING"},
            "vendor_gstin": {"type": "STRING"},
            "vendor_address": {"type": "STRING"},
            "vendor_state": {"type": "STRING"},
            "vendor_pincode": {"type": "STRING"},
            "vendor_phone": {"type": "STRING"},
            "bank_name": {"type": "STRING"},
            "account_number": {"type": "STRING"},
            "ifsc_code": {"type": "STRING"},
            "upi_id": {"type": "STRING"},
            "buyer_name": {"type": "STRING"},
            "buyer_gstin": {"type": "STRING"},
            "buyer_state": {"type": "STRING"},
            "buyer_address": {"type": "STRING"},
            "invoice_number": {"type": "STRING"},
            "invoice_date": {"type": "STRING"},
            "due_date": {"type": "STRING"},
            "payment_mode": {"type": "STRING"},
            "reverse_charge": {"type": "STRING"},
            "buyer_order_no": {"type": "STRING"},
            "order_date": {"type": "STRING"},
            "supplier_ref": {"type": "STRING"},
            "vehicle_no": {"type": "STRING"},
            "eway_bill_no": {"type": "STRING"},
            "line_items": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "sr_no": {"type": "NUMBER"},
                        "description": {"type": "STRING"},
                        "hsn_code": {"type": "STRING"},
                        "quantity": {"type": "NUMBER"},
                        "uom": {"type": "STRING"},
                        "rate": {"type": "NUMBER"},
                        "discount_percent": {"type": "NUMBER"},
                        "taxable_value": {"type": "NUMBER"},
                        "gst_rate": {"type": "NUMBER"},
                        "cgst_amount": {"type": "NUMBER"},
                        "sgst_amount": {"type": "NUMBER"},
                        "igst_amount": {"type": "NUMBER"},
                        "total_amount": {"type": "NUMBER"}
                    },
                    "required": ["description", "quantity", "taxable_value"]
                }
            },
            "printed_taxable_subtotal": {"type": "NUMBER"},
            "printed_cgst_total": {"type": "NUMBER"},
            "printed_sgst_total": {"type": "NUMBER"},
            "printed_igst_total": {"type": "NUMBER"},
            "printed_round_off": {"type": "NUMBER"},
            "printed_grand_total": {"type": "NUMBER"},
            "total_taxable": {"type": "NUMBER"},
            "total_cgst": {"type": "NUMBER"},
            "total_sgst": {"type": "NUMBER"},
            "total_igst": {"type": "NUMBER"},
            "freight_charges": {"type": "NUMBER"},
            "round_off": {"type": "NUMBER"},
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

        # Auto-Recovery Retry if items taxable sum does not match printed subtotal
        line_items = data.get("line_items") or []
        printed_subtotal = float(data.get("printed_taxable_subtotal") or data.get("total_taxable") or 0.0)
        items_sum = round(sum(float(i.get("taxable_value") or (float(i.get("quantity", 0)) * float(i.get("rate", 0)))) for i in line_items), 2)

        if printed_subtotal > 0 and abs(items_sum - printed_subtotal) > 1.0:
            diff = round(printed_subtotal - items_sum, 2)
            retry_prompt = f"Your previous extraction summed to {items_sum}, but the printed Sub-Total on the invoice is {printed_subtotal} (difference: {diff}). You missed a row (check Row 1 right under the table header). Return the complete JSON with ALL rows included."
            retry_response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=[content_item, prompt + "\n\nCRITICAL RETRY CORRECTION:\n" + retry_prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=response_schema,
                    temperature=0.1
                )
            )
            retry_data = json.loads(retry_response.text)
            retry_items = retry_data.get("line_items") or []
            retry_sum = round(sum(float(i.get("taxable_value") or (float(i.get("quantity", 0)) * float(i.get("rate", 0)))) for i in retry_items), 2)
            if abs(retry_sum - printed_subtotal) <= abs(items_sum - printed_subtotal):
                data = retry_data

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


def parse_date_parts(date_input: Any) -> Tuple[int, int, int]:
    """Parse date input into (year, month, day). Never returns empty or invalid values."""
    if not date_input:
        now = datetime.now()
        return now.year, now.month, now.day
    if isinstance(date_input, (datetime, date)):
        return date_input.year, date_input.month, date_input.day
    s = str(date_input).strip()
    if not s:
        now = datetime.now()
        return now.year, now.month, now.day

    # 1. 8-digit YYYYMMDD
    m8 = re.match(r"^(\d{4})(\d{2})(\d{2})$", s)
    if m8:
        y, m, d = int(m8.group(1)), int(m8.group(2)), int(m8.group(3))
        if 1 <= m <= 12 and 1 <= d <= 31:
            return y, m, d

    # 2. YYYY-MM-DD or YYYY/MM/DD
    m_iso = re.match(r"^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$", s)
    if m_iso:
        y, m, d = int(m_iso.group(1)), int(m_iso.group(2)), int(m_iso.group(3))
        if 1 <= m <= 12 and 1 <= d <= 31:
            return y, m, d

    # 3. DD-MM-YYYY or DD/MM/YYYY or DD-MM-YY or DD/MM/YY
    m_dmy = re.match(r"^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$", s)
    if m_dmy:
        d, m, y = int(m_dmy.group(1)), int(m_dmy.group(2)), int(m_dmy.group(3))
        if y < 100:
            y += 2000
        if 1 <= m <= 12 and 1 <= d <= 31:
            return y, m, d

    # Common strptime formats
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d", "%d.%m.%Y", "%d %b %Y", "%d-%b-%Y"):
        try:
            dt = datetime.strptime(s, fmt)
            return dt.year, dt.month, dt.day
        except ValueError:
            continue

    now = datetime.now()
    return now.year, now.month, now.day


def format_tally_date(date_str: Any, safe_edu: bool = False, use_edu_safe_date: Optional[bool] = None) -> str:
    """
    Format invoice date strictly to 8-digit Tally YYYYMMDD format with no spaces or dashes.
    Never overwrites, clamps, or mutates the date.
    """
    y, m, d = parse_date_parts(date_str)
    return f"{y:04d}{m:02d}{d:02d}"


def use_edu_safe_date(date_str: Any) -> str:
    """Utility function: Tally date helper."""
    return format_tally_date(date_str)


def export_batch_to_tally_xml(invoice_ids: List[int], output_path: str, safe_edu: bool = True) -> str:
    """
    Generates TallyPrime Purchase Vouchers XML file for the given invoice IDs (Task 2).
    
    Exact dependency order:
    1. Unique <UNIT> masters
    2. Unique <LEDGER> masters (Party, Purchase @ rate%, Taxes, Freight, Round-off)
    3. Unique <STOCKITEM> masters with HSN details
    4. <VOUCHER> transaction block in 'Invoice Voucher View' with ALLLEDGERENTRIES.LIST and ALLINVENTORYENTRIES.LIST
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
    ET.SubElement(reqdesc, "REPORTNAME").text = "All Masters"

    reqdata = ET.SubElement(importdata, "REQUESTDATA")

    # Step 2B: Master Block 1 — Auto-Create Unique <UNIT> Masters First
    unique_units = {"Nos"}
    for inv in invoices:
        items = inv.get("line_items") or inv.get("items") or []
        for it in items:
            uom = it.get("uom") or it.get("unit") or "Nos"
            unique_units.add(uom.strip())

    for uom in sorted(unique_units):
        msg_unit = ET.SubElement(reqdata, "TALLYMESSAGE", {"xmlns:UDF": "TallyUDF"})
        unit_node = ET.SubElement(msg_unit, "UNIT", {"ACTION": "Create", "NAME": uom})
        ET.SubElement(unit_node, "NAME").text = uom
        ET.SubElement(unit_node, "ISSIMPLEUNIT").text = "Yes"

    # Step 2C: Master Block 2 — Auto-Create Party, Purchase Slab, Tax, Freight & Round-Off <LEDGER> Masters
    created_vendor_ledgers = set()
    unique_slabs = set()
    has_cgst = False
    has_sgst = False
    has_igst = False
    has_freight = False
    has_roundoff = False

    for inv in invoices:
        vendor_name = (inv.get("vendor_name") or "Unknown Vendor").strip()
        gstin = (inv.get("gstin") or "").strip().upper()
        state = inv.get("vendor_state") or get_state_from_gstin(gstin, "Delhi")
        raw_pin = str(inv.get("vendor_pincode") or "").strip()
        address = str(inv.get("vendor_address") or "").strip()
        pincode = ""
        if re.match(r'^\d{6}$', raw_pin):
            pincode = raw_pin
        elif address:
            m_pin = re.search(r'\b\d{6}\b', address)
            if m_pin:
                pincode = m_pin.group(0)

        pan = get_pan_from_gstin(gstin)
        if vendor_name not in created_vendor_ledgers:
            created_vendor_ledgers.add(vendor_name)
            msg_ledger = ET.SubElement(reqdata, "TALLYMESSAGE", {"xmlns:UDF": "TallyUDF"})
            ledger_node = ET.SubElement(msg_ledger, "LEDGER", {"NAME": vendor_name, "ACTION": "Create"})
            name_list = ET.SubElement(ledger_node, "NAME.LIST")
            ET.SubElement(name_list, "NAME").text = vendor_name
            ET.SubElement(ledger_node, "PARENT").text = "Sundry Creditors"
            ET.SubElement(ledger_node, "ISBILLWISEON").text = "Yes"
            ET.SubElement(ledger_node, "COUNTRYNAME").text = "India"
            if state:
                ET.SubElement(ledger_node, "LEDSTATENAME").text = state
            if pincode and re.match(r'^\d{6}$', pincode):
                ET.SubElement(ledger_node, "PINCODE").text = str(pincode)
            if pan:
                ET.SubElement(ledger_node, "INCOMETAXNUMBER").text = pan
            ET.SubElement(ledger_node, "GSTREGISTRATIONTYPE").text = "Regular" if gstin else "Unregistered"
            if gstin:
                ET.SubElement(ledger_node, "PARTYGSTIN").text = gstin
            if address:
                addr_list = ET.SubElement(ledger_node, "ADDRESS.LIST")
                ET.SubElement(addr_list, "ADDRESS").text = address

        # Check line items for purchase slabs
        items = inv.get("line_items") or inv.get("items") or []
        for it in items:
            rate = it.get("gst_rate") if it.get("gst_rate") is not None else 18
            unique_slabs.add(int(rate) if float(rate).is_integer() else rate)

        if float(inv.get("cgst_amount") or 0.0) > 0:
            has_cgst = True
        if float(inv.get("sgst_amount") or 0.0) > 0:
            has_sgst = True
        if float(inv.get("igst_amount") or 0.0) > 0:
            has_igst = True
        if float(inv.get("freight_charges") or 0.0) > 0:
            has_freight = True
        inv_roundoff = float(inv.get("roundoff_amount") or 0.0)
        inv_taxable = float(inv.get("taxable_amount") or 0.0)
        inv_taxes = float(inv.get("cgst_amount") or 0.0) + float(inv.get("sgst_amount") or 0.0) + float(inv.get("igst_amount") or 0.0) + float(inv.get("freight_charges") or 0.0)
        inv_grand = float(inv.get("grand_total") or 0.0)
        if abs(inv_roundoff) > 0.0001 or (inv_grand > 0 and abs(inv_grand - (inv_taxable + inv_taxes)) > 0.001):
            has_roundoff = True

    if not unique_slabs:
        unique_slabs.add(18)

    for slab in sorted(unique_slabs):
        slab_name = f"Purchase @ {slab}%"
        msg_slab = ET.SubElement(reqdata, "TALLYMESSAGE", {"xmlns:UDF": "TallyUDF"})
        slab_node = ET.SubElement(msg_slab, "LEDGER", {"NAME": slab_name, "ACTION": "Create"})
        name_list = ET.SubElement(slab_node, "NAME.LIST")
        ET.SubElement(name_list, "NAME").text = slab_name
        ET.SubElement(slab_node, "PARENT").text = "Purchase Accounts"
        ET.SubElement(slab_node, "ISGSTAPPLICABLE").text = "Applicable"

    if has_cgst:
        msg_cgst = ET.SubElement(reqdata, "TALLYMESSAGE", {"xmlns:UDF": "TallyUDF"})
        cgst_node = ET.SubElement(msg_cgst, "LEDGER", {"NAME": cgst_ledger, "ACTION": "Create"})
        ET.SubElement(ET.SubElement(cgst_node, "NAME.LIST"), "NAME").text = cgst_ledger
        ET.SubElement(cgst_node, "PARENT").text = "Duties & Taxes"

    if has_sgst:
        msg_sgst = ET.SubElement(reqdata, "TALLYMESSAGE", {"xmlns:UDF": "TallyUDF"})
        sgst_node = ET.SubElement(msg_sgst, "LEDGER", {"NAME": sgst_ledger, "ACTION": "Create"})
        ET.SubElement(ET.SubElement(sgst_node, "NAME.LIST"), "NAME").text = sgst_ledger
        ET.SubElement(sgst_node, "PARENT").text = "Duties & Taxes"

    if has_igst:
        msg_igst = ET.SubElement(reqdata, "TALLYMESSAGE", {"xmlns:UDF": "TallyUDF"})
        igst_node = ET.SubElement(msg_igst, "LEDGER", {"NAME": igst_ledger, "ACTION": "Create"})
        ET.SubElement(ET.SubElement(igst_node, "NAME.LIST"), "NAME").text = igst_ledger
        ET.SubElement(igst_node, "PARENT").text = "Duties & Taxes"

    if has_freight:
        msg_fr = ET.SubElement(reqdata, "TALLYMESSAGE", {"xmlns:UDF": "TallyUDF"})
        fr_node = ET.SubElement(msg_fr, "LEDGER", {"NAME": "Freight & Packing Charges", "ACTION": "Create"})
        ET.SubElement(ET.SubElement(fr_node, "NAME.LIST"), "NAME").text = "Freight & Packing Charges"
        ET.SubElement(fr_node, "PARENT").text = "Direct Expenses"

    if has_roundoff:
        msg_ro = ET.SubElement(reqdata, "TALLYMESSAGE", {"xmlns:UDF": "TallyUDF"})
        ro_node = ET.SubElement(msg_ro, "LEDGER", {"NAME": roundoff_ledger, "ACTION": "Create"})
        ET.SubElement(ET.SubElement(ro_node, "NAME.LIST"), "NAME").text = roundoff_ledger
        ET.SubElement(ro_node, "PARENT").text = "Indirect Expenses"

    # Step 2D: Master Block 3 — Auto-Create <STOCKITEM> Masters with HSN Details
    created_items = set()
    for inv in invoices:
        items = inv.get("line_items") or inv.get("items") or []
        for it in items:
            item_name = (it.get("description") or "Item").strip()
            if item_name not in created_items:
                created_items.add(item_name)
                uom = it.get("uom") or it.get("unit") or "Nos"
                hsn = str(it.get("hsn_code") or it.get("hsn_sac") or "")
                msg_stock = ET.SubElement(reqdata, "TALLYMESSAGE", {"xmlns:UDF": "TallyUDF"})
                stock_node = ET.SubElement(msg_stock, "STOCKITEM", {"NAME": item_name, "ACTION": "Create"})
                ET.SubElement(ET.SubElement(stock_node, "NAME.LIST"), "NAME").text = item_name
                ET.SubElement(stock_node, "BASEUNITS").text = uom
                ET.SubElement(stock_node, "GSTAPPLICABLE").text = "Applicable"
                if hsn:
                    hsn_list = ET.SubElement(stock_node, "HSNDETAILS.LIST")
                    ET.SubElement(hsn_list, "HSNCODE").text = hsn
                    ET.SubElement(hsn_list, "SRCOFHSNDETAILS").text = "Specify Details Here"

    # Step 2E: Transaction Block — Emit <VOUCHER> in 'Invoice Voucher View'
    for inv in invoices:
        vendor_name = (inv.get("vendor_name") or "Unknown Vendor").strip()
        gstin = (inv.get("gstin") or "").strip().upper()
        state = inv.get("vendor_state") or get_state_from_gstin(gstin, "Delhi")
        inv_no = inv.get("invoice_number") or f"INV-{inv['id']}"
        tally_date = format_tally_date(inv.get("invoice_date", ""), safe_edu=safe_edu)
        grand_total = float(inv.get("grand_total") or 0.0)
        taxable = float(inv.get("taxable_amount") or 0.0)
        cgst = float(inv.get("cgst_amount") or 0.0)
        sgst = float(inv.get("sgst_amount") or 0.0)
        igst = float(inv.get("igst_amount") or 0.0)
        freight = float(inv.get("freight_charges") or 0.0)
        roundoff = float(inv.get("roundoff_amount") or 0.0)

        buyer_order_no = inv.get("buyer_order_no") or ""
        supplier_ref = inv.get("supplier_ref") or ""
        vehicle_no = inv.get("vehicle_no") or ""

        # Normalize line items and ensure taxable aligns with line items sum
        line_items = inv.get("line_items") or inv.get("items") or []
        if isinstance(line_items, str):
            try:
                line_items = json.loads(line_items)
            except Exception:
                line_items = []

        line_items_taxable = round(sum(float(it.get("taxable_value") or (float(it.get("rate") or 0.0) * float(it.get("quantity") or 1.0))) for it in line_items), 2)
        if line_items and line_items_taxable > 0:
            taxable = line_items_taxable
        elif not line_items:
            fallback_val = taxable if taxable > 0 else grand_total
            line_items = [{
                "description": "General Purchase",
                "rate": fallback_val,
                "uom": "Nos",
                "quantity": 1,
                "taxable_value": fallback_val,
                "discount_percent": 0,
                "gst_rate": 18
            }]
            taxable = fallback_val

        # Fix 3: Strict Pre-Export Debit === Credit Math Enforcer
        sum_items_taxable = round(sum(float(f"{float(it.get('taxable_value') or (float(it.get('rate') or 0.0) * float(it.get('quantity') or 1.0))):.2f}") for it in line_items), 2)
        taxes_sum = round(cgst + sgst + igst + freight, 2)
        calculated_debits = round(sum_items_taxable + taxes_sum + roundoff, 2)

        if grand_total <= 0:
            grand_total = calculated_debits
        elif calculated_debits != round(grand_total, 2):
            roundoff = round(grand_total - (sum_items_taxable + taxes_sum), 2)

        # Strictly ensure total debits equal total credits to the exact paisa
        grand_total = round(sum_items_taxable + taxes_sum + roundoff, 2)

        msg_voucher = ET.SubElement(reqdata, "TALLYMESSAGE", {"xmlns:UDF": "TallyUDF"})
        voucher = ET.SubElement(msg_voucher, "VOUCHER", {"VCHTYPE": "Purchase", "ACTION": "Create", "OBJVIEW": "Invoice Voucher View"})

        # Fix 1: Exact native TallyPrime Item-Invoice schema order
        ET.SubElement(voucher, "DATE").text = tally_date
        ET.SubElement(voucher, "EFFECTIVEDATE").text = tally_date
        ET.SubElement(voucher, "REFERENCEDATE").text = tally_date
        ET.SubElement(voucher, "VOUCHERTYPENAME").text = "Purchase"
        ET.SubElement(voucher, "VOUCHERNUMBER").text = inv_no
        ET.SubElement(voucher, "REFERENCE").text = inv_no
        ET.SubElement(voucher, "PARTYLEDGERNAME").text = vendor_name
        ET.SubElement(voucher, "PARTYNAME").text = vendor_name
        ET.SubElement(voucher, "BASICBASEPARTYNAME").text = vendor_name
        ET.SubElement(voucher, "PARTYGSTIN").text = gstin
        ET.SubElement(voucher, "STATENAME").text = state
        ET.SubElement(voucher, "PLACEOFSUPPLY").text = state
        ET.SubElement(voucher, "ISINVOICE").text = "Yes"
        ET.SubElement(voucher, "PERSISTEDVIEW").text = "Invoice Voucher View"
        ET.SubElement(voucher, "BASICBUYERORDERNO").text = buyer_order_no
        ET.SubElement(voucher, "BASICSHIPDOCUMENTNO").text = supplier_ref
        ET.SubElement(voucher, "BASICSHIPVESSELNO").text = vehicle_no

        narration = f"Invoice No: {inv_no} | Original Date: {inv.get('invoice_date', '')}"
        if buyer_order_no:
            narration += f" | Order No: {buyer_order_no}"
        if vehicle_no:
            narration += f" | Vehicle No: {vehicle_no}"
        if supplier_ref:
            narration += f" | Supplier Ref: {supplier_ref}"
        ET.SubElement(voucher, "NARRATION").text = narration

        # Block A — All <ALLINVENTORYENTRIES.LIST> Blocks First (Contiguous)
        for item in line_items:
            item_name = (item.get("description") or "Item").strip()
            uom = item.get("uom") or item.get("unit") or "Nos"
            rate = float(item.get("rate") or 0.0)
            qty = float(item.get("quantity") or 1.0)
            disc = float(item.get("discount_percent") or 0.0)
            item_tv = float(item.get("taxable_value") or (rate * qty))
            item_amount = f"{item_tv:.2f}"
            gst_rate = item.get("gst_rate") if item.get("gst_rate") is not None else 18
            slab_name = f"Purchase @ {gst_rate}%"

            inv_entry = ET.SubElement(voucher, "ALLINVENTORYENTRIES.LIST")
            ET.SubElement(inv_entry, "STOCKITEMNAME").text = item_name
            ET.SubElement(inv_entry, "ISDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(inv_entry, "ISLASTDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(inv_entry, "RATE").text = f"{rate:.2f}/{uom}"
            ET.SubElement(inv_entry, "DISCOUNT").text = f"{disc}"
            ET.SubElement(inv_entry, "AMOUNT").text = f"-{item_amount}"
            qty_fmt = int(qty) if qty.is_integer() else qty
            ET.SubElement(inv_entry, "ACTUALQTY").text = f" {qty_fmt} {uom}"
            ET.SubElement(inv_entry, "BILLEDQTY").text = f" {qty_fmt} {uom}"

            alloc = ET.SubElement(inv_entry, "ACCOUNTINGALLOCATIONS.LIST")
            ET.SubElement(alloc, "LEDGERNAME").text = slab_name
            ET.SubElement(alloc, "ISDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(alloc, "ISLASTDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(alloc, "AMOUNT").text = f"-{item_amount}"

        # Block B — All <LEDGERENTRIES.LIST> Blocks Together Immediately After Inventory (Contiguous!)
        # 1. First <LEDGERENTRIES.LIST> (Party Credit)
        creditor_entry = ET.SubElement(voucher, "LEDGERENTRIES.LIST")
        ET.SubElement(creditor_entry, "LEDGERNAME").text = vendor_name
        ET.SubElement(creditor_entry, "ISPARTYLEDGER").text = "Yes"
        ET.SubElement(creditor_entry, "ISDEEMEDPOSITIVE").text = "No"
        ET.SubElement(creditor_entry, "ISLASTDEEMEDPOSITIVE").text = "No"
        ET.SubElement(creditor_entry, "AMOUNT").text = f"{grand_total:.2f}"
        bill_alloc = ET.SubElement(creditor_entry, "BILLALLOCATIONS.LIST")
        ET.SubElement(bill_alloc, "NAME").text = inv_no
        ET.SubElement(bill_alloc, "BILLTYPE").text = "New Ref"
        ET.SubElement(bill_alloc, "AMOUNT").text = f"{grand_total:.2f}"

        # 2. Next <LEDGERENTRIES.LIST> (Tax Ledgers — Input CGST, Input SGST, Input IGST)
        if cgst > 0:
            cgst_e = ET.SubElement(voucher, "LEDGERENTRIES.LIST")
            ET.SubElement(cgst_e, "LEDGERNAME").text = cgst_ledger
            ET.SubElement(cgst_e, "ISPARTYLEDGER").text = "No"
            ET.SubElement(cgst_e, "ISDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(cgst_e, "ISLASTDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(cgst_e, "AMOUNT").text = f"{-cgst:.2f}"

        if sgst > 0:
            sgst_e = ET.SubElement(voucher, "LEDGERENTRIES.LIST")
            ET.SubElement(sgst_e, "LEDGERNAME").text = sgst_ledger
            ET.SubElement(sgst_e, "ISPARTYLEDGER").text = "No"
            ET.SubElement(sgst_e, "ISDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(sgst_e, "ISLASTDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(sgst_e, "AMOUNT").text = f"{-sgst:.2f}"

        if igst > 0:
            igst_e = ET.SubElement(voucher, "LEDGERENTRIES.LIST")
            ET.SubElement(igst_e, "LEDGERNAME").text = igst_ledger
            ET.SubElement(igst_e, "ISPARTYLEDGER").text = "No"
            ET.SubElement(igst_e, "ISDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(igst_e, "ISLASTDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(igst_e, "AMOUNT").text = f"{-igst:.2f}"

        # Freight Entry
        if freight > 0:
            fr_e = ET.SubElement(voucher, "LEDGERENTRIES.LIST")
            ET.SubElement(fr_e, "LEDGERNAME").text = "Freight & Packing Charges"
            ET.SubElement(fr_e, "ISPARTYLEDGER").text = "No"
            ET.SubElement(fr_e, "ISDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(fr_e, "ISLASTDEEMEDPOSITIVE").text = "Yes"
            ET.SubElement(fr_e, "AMOUNT").text = f"{-freight:.2f}"

        # 3. Last <LEDGERENTRIES.LIST> (Round Off)
        if abs(roundoff) > 0.0001:
            ro_e = ET.SubElement(voucher, "LEDGERENTRIES.LIST")
            ET.SubElement(ro_e, "LEDGERNAME").text = roundoff_ledger
            ET.SubElement(ro_e, "ISPARTYLEDGER").text = "No"
            is_pos = "Yes" if roundoff > 0 else "No"
            ET.SubElement(ro_e, "ISDEEMEDPOSITIVE").text = is_pos
            ET.SubElement(ro_e, "ISLASTDEEMEDPOSITIVE").text = is_pos
            ro_amount = f"-{abs(roundoff):.2f}" if roundoff > 0 else f"{abs(roundoff):.2f}"
            ET.SubElement(ro_e, "AMOUNT").text = ro_amount

    # Pretty print XML string
    raw_xml_str = ET.tostring(envelope, encoding="utf-8")
    parsed_dom = minidom.parseString(raw_xml_str)
    pretty_xml = parsed_dom.toprettyxml(indent="  ")

    clean_lines = [line for line in pretty_xml.splitlines() if line.strip()]
    final_xml = "\n".join(clean_lines).replace("&#4; ", "").replace("&#4;", "")

    output_file = Path(output_path)
    output_file.parent.mkdir(exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(final_xml)

    return str(output_file)
