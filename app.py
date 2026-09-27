import os
import shutil
from pathlib import Path
from PIL import Image
import streamlit as st
import pandas as pd

# Import engine functions
import engine

# Page configuration
st.set_page_config(
    page_title="TallyFlow AI - Invoice to Tally XML",
    page_icon="🧾",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Custom CSS styling for premium look & visual badges
st.markdown("""
<style>
    /* Main Theme Overrides */
    .stApp {
        background-color: #0f172a;
        color: #f8fafc;
        font-family: 'Inter', system-ui, -apple-system, sans-serif;
    }

    /* Card styling */
    .metric-card {
        background: rgba(30, 41, 59, 0.7);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        padding: 18px;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
        backdrop-filter: blur(8px);
        text-align: center;
    }

    .metric-value {
        font-size: 1.8rem;
        font-weight: 700;
        margin-top: 4px;
        letter-spacing: -0.02em;
    }

    .metric-label {
        font-size: 0.85rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #94a3b8;
        font-weight: 600;
    }

    /* Badges */
    .badge-verified {
        background-color: rgba(16, 185, 129, 0.15);
        color: #34d399;
        border: 1px solid rgba(52, 211, 153, 0.3);
        padding: 4px 10px;
        border-radius: 9999px;
        font-size: 0.8rem;
        font-weight: 600;
        display: inline-block;
    }

    .badge-review {
        background-color: rgba(245, 158, 11, 0.15);
        color: #fbbf24;
        border: 1px solid rgba(251, 191, 36, 0.3);
        padding: 4px 10px;
        border-radius: 9999px;
        font-size: 0.8rem;
        font-weight: 600;
        display: inline-block;
    }

    .badge-error {
        background-color: rgba(244, 63, 94, 0.15);
        color: #f87171;
        border: 1px solid rgba(248, 113, 113, 0.3);
        padding: 4px 10px;
        border-radius: 9999px;
        font-size: 0.8rem;
        font-weight: 600;
        display: inline-block;
    }

    /* Header styling */
    .main-header {
        background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        padding: 24px 32px;
        border-radius: 16px;
        margin-bottom: 24px;
        box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
    }
    
    .main-title {
        color: #38bdf8;
        font-size: 2.2rem;
        font-weight: 800;
        letter-spacing: -0.025em;
        margin: 0;
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .subtitle {
        color: #94a3b8;
        font-size: 0.95rem;
        margin-top: 6px;
    }

    /* Buttons */
    .stButton > button {
        border-radius: 8px;
        font-weight: 600;
        transition: all 0.2s ease;
    }

    .stButton > button:hover {
        transform: translateY(-1px);
    }

    /* Image preview wrapper */
    .img-preview-container {
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        padding: 8px;
        background: #020617;
    }
</style>
""", unsafe_allow_html=True)

# Helper function to get status badge HTML
def get_status_badge(status: str) -> str:
    if status == "Verified":
        return '<span class="badge-verified">✓ Verified</span>'
    elif status == "Math Error":
        return '<span class="badge-error">⚠ Math Error</span>'
    else:
        return '<span class="badge-review">👁 Needs Review</span>'

# Header Component
st.markdown("""
<div class="main-header">
    <div class="main-title">
        ⚡ TallyFlow AI
    </div>
    <div class="subtitle">
        Automated Indian Vendor Invoice AI Extraction & TallyPrime Purchase XML Converter
    </div>
</div>
""", unsafe_allow_html=True)

# Fetch settings & database state
settings = engine.get_settings()
api_key = settings.get("gemini_api_key", "")

# Sidebar: Settings & System Config
with st.sidebar:
    st.header("⚙️ Settings & Configuration")
    st.info("🔒 **Security Mode Enabled**: Gemini API Key is securely managed server-side via backend `.env` file.")

    with st.expander("🏢 Tally Server Config", expanded=False):
        tally_host = st.text_input("Tally Host", value=settings.get("tally_host", "localhost"))
        tally_port = st.number_input("Tally Port", value=int(settings.get("tally_port", 9000)), min_value=1, max_value=65535)

    with st.expander("📖 Default Tally Ledgers", expanded=False):
        pur_ledger = st.text_input("Purchase Ledger", value=settings.get("default_purchase_ledger", "Purchase Account"))
        cgst_ledger = st.text_input("CGST Ledger", value=settings.get("default_cgst_ledger", "Input CGST"))
        sgst_ledger = st.text_input("SGST Ledger", value=settings.get("default_sgst_ledger", "Input SGST"))
        igst_ledger = st.text_input("IGST Ledger", value=settings.get("default_igst_ledger", "Input IGST"))
        roundoff_ledger = st.text_input("Round Off Ledger", value=settings.get("default_roundoff_ledger", "Round Off"))

    if st.button("💾 Save Settings", use_container_width=True, type="primary"):
        engine.update_settings(
            tally_host=tally_host,
            tally_port=tally_port,
            default_purchase_ledger=pur_ledger,
            default_cgst_ledger=cgst_ledger,
            default_sgst_ledger=sgst_ledger,
            default_igst_ledger=igst_ledger,
            default_roundoff_ledger=roundoff_ledger
        )
        st.success("Settings saved successfully!")
        st.rerun()

    st.markdown("---")
    safe_edu = st.checkbox("🎓 Educational Mode Date Clamp", value=True, help="Clamps invoice date to the 1st of month (YYYYMM01) for Tally Prime Educational Mode compatibility")
    st.caption("v1.0.0 | Engine Powered by Gemini 2.5 Flash")

# Metrics Banner
invoices = engine.get_all_invoices()
total_count = len(invoices)
verified_count = sum(1 for i in invoices if i["status"] == "Verified")
review_count = sum(1 for i in invoices if i["status"] == "Needs Review")
math_error_count = sum(1 for i in invoices if i["status"] == "Math Error")

col_m1, col_m2, col_m3, col_m4 = st.columns(4)
with col_m1:
    st.markdown(f'<div class="metric-card"><div class="metric-label">Total Invoices</div><div class="metric-value" style="color: #38bdf8;">{total_count}</div></div>', unsafe_allow_html=True)
with col_m2:
    st.markdown(f'<div class="metric-card"><div class="metric-label">Verified (Ready)</div><div class="metric-value" style="color: #34d399;">{verified_count}</div></div>', unsafe_allow_html=True)
with col_m3:
    st.markdown(f'<div class="metric-card"><div class="metric-label">Needs Review</div><div class="metric-value" style="color: #fbbf24;">{review_count}</div></div>', unsafe_allow_html=True)
with col_m4:
    st.markdown(f'<div class="metric-card"><div class="metric-label">Math Errors</div><div class="metric-value" style="color: #f87171;">{math_error_count}</div></div>', unsafe_allow_html=True)

st.markdown("<br>", unsafe_allow_html=True)

# Main Navigation Tabs
tab_queue, tab_inspect, tab_vendors, tab_export = st.tabs([
    "📥 Batch Queue & Upload",
    "🔍 Side-by-Side Inspection",
    "🏢 Vendor Ledger Directory",
    "📤 Tally XML Exporter"
])

# --- TAB 1: BATCH QUEUE & UPLOAD ---
with tab_queue:
    st.subheader("📁 Upload Invoice Files")
    uploaded_files = st.file_uploader(
        "Drag and drop vendor invoice images or PDFs here",
        type=["png", "jpg", "jpeg", "pdf"],
        accept_multiple_files=True
    )

    if uploaded_files:
        if st.button(f"⚡ Process {len(uploaded_files)} Invoices with AI", type="primary"):
            progress_bar = st.progress(0)
            status_text = st.empty()

            for idx, file in enumerate(uploaded_files):
                status_text.text(f"Processing ({idx+1}/{len(uploaded_files)}): {file.name}...")
                
                # Save file locally
                saved_path = engine.INVOICES_DIR / file.name
                with open(saved_path, "wb") as f:
                    f.write(file.getbuffer())

                # Extract via engine
                try:
                    engine.process_and_save_invoice(file.name, saved_path)
                except Exception as e:
                    st.error(f"Error processing {file.name}: {str(e)}")

                progress_bar.progress((idx + 1) / len(uploaded_files))

            status_text.text("Processing complete!")
            st.success("Batch invoice extraction finished successfully!")
            st.rerun()

    st.markdown("---")
    st.subheader("📋 Invoice Batch Queue")
    
    if not invoices:
        st.info("No invoices uploaded yet. Drag and drop invoice files above to start processing.")
    else:
        # Prepare DataFrame display
        df_data = []
        for inv in invoices:
            df_data.append({
                "ID": inv["id"],
                "File Name": inv["file_name"],
                "Invoice No": inv["invoice_number"] or "-",
                "Invoice Date": inv["invoice_date"] or "-",
                "Vendor Name": inv["vendor_name"] or "-",
                "GSTIN": inv["gstin"] or "-",
                "Taxable (₹)": f"₹{inv['taxable_amount']:,.2f}",
                "Grand Total (₹)": f"₹{inv['grand_total']:,.2f}",
                "Status": inv["status"],
                "Math Difference (₹)": f"₹{inv['math_difference']:,.2f}"
            })
        
        df = pd.DataFrame(df_data)

        # Custom display with selection
        for idx, row in df.iterrows():
            col_id, col_file, col_vendor, col_total, col_status, col_action = st.columns([1, 2.5, 2.5, 2, 2, 1.5])
            with col_id:
                st.write(f"#{row['ID']}")
            with col_file:
                st.write(f"**{row['File Name']}**\n\n`{row['Invoice No']}`")
            with col_vendor:
                st.write(f"**{row['Vendor Name']}**\n\nGSTIN: `{row['GSTIN']}`")
            with col_total:
                st.write(f"**{row['Grand Total (₹)']}**\n\nTaxable: {row['Taxable (₹)']}")
            with col_status:
                st.markdown(get_status_badge(row['Status']), unsafe_allow_html=True)
                if row['Math Difference (₹)'] != '₹0.00':
                    st.caption(f"Delta: {row['Math Difference (₹)']}")
            with col_action:
                if st.button("Inspect 🔍", key=f"inspect_btn_{row['ID']}"):
                    st.session_state["selected_invoice_id"] = row['ID']
                    st.session_state["active_tab"] = "inspect"
                    st.rerun()
            st.markdown("<hr style='margin: 8px 0; border-color: rgba(255,255,255,0.05);'>", unsafe_allow_html=True)

# --- TAB 2: SIDE-BY-SIDE INSPECTION & AUDIT ---
with tab_inspect:
    st.subheader("🔍 Side-by-Side Invoice Inspection & Verification")
    
    selected_id = st.session_state.get("selected_invoice_id")
    if not selected_id and invoices:
        selected_id = invoices[0]["id"]

    if not selected_id:
        st.info("No invoice selected. Upload invoices or select one from the Batch Queue.")
    else:
        # Selector dropdown
        inv_options = {f"#{inv['id']} - {inv['file_name']} ({inv['vendor_name'] or 'Unknown'})": inv['id'] for inv in invoices}
        selected_key = next((k for k, v in inv_options.items() if v == selected_id), list(inv_options.keys())[0])
        chosen_option = st.selectbox("Select Invoice to Inspect", list(inv_options.keys()), index=list(inv_options.keys()).index(selected_key))
        current_inv_id = inv_options[chosen_option]
        
        invoice_item = engine.get_invoice_by_id(current_inv_id)

        if invoice_item:
            col_left, col_right = st.columns([1, 1], gap="medium")

            # LEFT COLUMN: Original Document / Image Preview
            with col_left:
                st.markdown("##### 📄 Original Invoice Document")
                file_path = Path(invoice_item["file_path"])
                if file_path.exists():
                    file_ext = file_path.suffix.lower()
                    if file_ext in [".png", ".jpg", ".jpeg", ".webp"]:
                        img = Image.open(file_path)
                        st.image(img, use_container_width=True)
                    elif file_ext == ".pdf":
                        st.info(f"PDF Document: `{file_path.name}`")
                        with open(file_path, "rb") as pdf_file:
                            st.download_button("📥 Download/View PDF", pdf_file, file_name=file_path.name, mime="application/pdf")
                    else:
                        st.write(f"File: {file_path.name}")
                else:
                    st.warning("Original invoice file not found on disk.")

            # RIGHT COLUMN: Editable Form & Real-time Math Check
            with col_right:
                st.markdown("##### ✏️ Extracted Fields & Audit")
                
                # Header Badge
                st.markdown(f"Status: {get_status_badge(invoice_item['status'])}", unsafe_allow_html=True)
                st.markdown("<br>", unsafe_allow_html=True)

                with st.form(key=f"edit_invoice_form_{invoice_item['id']}"):
                    inv_no = st.text_input("Invoice Number", value=invoice_item["invoice_number"] or "")
                    inv_date = st.text_input("Invoice Date (YYYY-MM-DD)", value=invoice_item["invoice_date"] or "")
                    
                    col_v1, col_v2 = st.columns(2)
                    with col_v1:
                        v_name = st.text_input("Vendor Name", value=invoice_item["vendor_name"] or "")
                    with col_v2:
                        gstin = st.text_input("Vendor GSTIN", value=invoice_item["gstin"] or "")

                    # Vendor mapping indicator
                    v_info = engine.get_vendor_by_name(v_name)
                    if v_info:
                        st.success(f"✓ Mapped to Tally Ledger: **{v_info['tally_ledger_name']}**")
                    else:
                        st.warning("⚠️ Vendor not mapped in Directory. Will be auto-created under 'Sundry Creditors' on export.")

                    st.markdown("---")
                    st.markdown("**Tax & Amount Breakdown (₹)**")

                    col_a1, col_a2 = st.columns(2)
                    with col_a1:
                        taxable = st.number_input("Taxable Amount", value=float(invoice_item["taxable_amount"]), step=10.0, format="%.2f")
                        cgst = st.number_input("CGST Amount", value=float(invoice_item["cgst_amount"]), step=1.0, format="%.2f")
                        sgst = st.number_input("SGST Amount", value=float(invoice_item["sgst_amount"]), step=1.0, format="%.2f")
                    with col_a2:
                        igst = st.number_input("IGST Amount", value=float(invoice_item["igst_amount"]), step=1.0, format="%.2f")
                        roundoff = st.number_input("Round Off Amount", value=float(invoice_item["roundoff_amount"]), step=0.1, format="%.2f")
                        grand_total = st.number_input("Grand Total", value=float(invoice_item["grand_total"]), step=10.0, format="%.2f")

                    # Live Arithmetic Check in form
                    calc_total = round(taxable + cgst + sgst + igst + roundoff, 2)
                    diff = round(grand_total - calc_total, 2)
                    
                    if abs(diff) == 0.0:
                        st.info(f"✅ Math Audit: Taxable ({taxable:.2f}) + Taxes ({cgst+sgst+igst:.2f}) + RoundOff ({roundoff:.2f}) = Grand Total ({grand_total:.2f})")
                    else:
                        st.error(f"⚠️ Math Audit Discrepancy: Sum of components is ₹{calc_total:.2f} but Grand Total is ₹{grand_total:.2f} (Difference: ₹{diff:.2f})")

                    btn_cols = st.columns([2, 1])
                    with btn_cols[0]:
                        submitted = st.form_submit_button("💾 Save & Recalculate Audit", type="primary", use_container_width=True)
                    with btn_cols[1]:
                        delete_clicked = st.form_submit_button("🗑️ Delete", use_container_width=True)

                    if submitted:
                        new_fields = {
                            "invoice_number": inv_no,
                            "invoice_date": inv_date,
                            "vendor_name": v_name,
                            "gstin": gstin,
                            "taxable_amount": taxable,
                            "cgst_amount": cgst,
                            "sgst_amount": sgst,
                            "igst_amount": igst,
                            "roundoff_amount": roundoff,
                            "grand_total": grand_total
                        }
                        new_status, new_math_diff = engine.update_invoice(invoice_item["id"], new_fields)
                        st.success(f"Invoice updated! New Status: {new_status}")
                        st.rerun()

                    if delete_clicked:
                        engine.delete_invoice(invoice_item["id"])
                        st.warning("Invoice deleted!")
                        st.rerun()

# --- TAB 3: VENDOR LEDGER DIRECTORY ---
with tab_vendors:
    st.subheader("🏢 Vendor Ledger Directory & Mapping")
    st.caption("Manage mapping between vendor names extracted from invoices and Tally Prime Sundry Creditor Ledgers.")

    # Form to add vendor
    with st.expander("➕ Add / Map New Vendor Ledger", expanded=True):
        with st.form("add_vendor_form"):
            col_v1, col_v2 = st.columns(2)
            with col_v1:
                v_name_input = st.text_input("Vendor / Company Name (as on invoice)")
                v_gstin_input = st.text_input("GSTIN Number (15 digits)")
            with col_v2:
                tally_ledger_input = st.text_input("Tally Ledger Name (Sundry Creditor)", help="Exact name in your TallyPrime Ledger master")
                v_state_input = st.text_input("State", value="Maharashtra")
            
            billwise_input = st.checkbox("Maintain Bill-by-Bill balances", value=True)
            
            submit_vendor = st.form_submit_button("💾 Save Vendor Mapping", type="primary")

            if submit_vendor:
                if not v_name_input or not tally_ledger_input:
                    st.error("Vendor Name and Tally Ledger Name are required!")
                else:
                    engine.save_vendor(
                        vendor_name=v_name_input,
                        gstin=v_gstin_input,
                        state=v_state_input,
                        tally_ledger_name=tally_ledger_input,
                        maintain_billwise=1 if billwise_input else 0
                    )
                    st.success(f"Vendor '{v_name_input}' mapped to Tally Ledger '{tally_ledger_input}' successfully!")
                    st.rerun()

    # Vendor List
    st.markdown("##### 📚 Saved Vendor Directory")
    with engine.get_db_connection() as conn:
        vendors = [dict(r) for r in conn.execute("SELECT * FROM vendors ORDER BY vendor_name").fetchall()]

    if not vendors:
        st.info("No vendor mappings saved yet. Unmapped vendors on invoices will be automatically created in Tally under 'Sundry Creditors'.")
    else:
        v_df = pd.DataFrame(vendors)
        v_df["Maintain Billwise"] = v_df["maintain_billwise"].apply(lambda x: "Yes" if x else "No")
        st.dataframe(
            v_df[["id", "vendor_name", "gstin", "state", "tally_ledger_name", "Maintain Billwise"]],
            column_config={
                "id": "ID",
                "vendor_name": "Vendor Name",
                "gstin": "GSTIN",
                "state": "State",
                "tally_ledger_name": "Tally Ledger Name"
            },
            use_container_width=True
        )

# --- TAB 4: TALLY XML EXPORTER ---
with tab_export:
    st.subheader("📤 Export Purchase XML for TallyPrime")
    st.caption("Generate standard Tally XML import file for all verified invoices.")

    verified_invoices = [i for i in invoices if i["status"] == "Verified"]
    all_eligible_ids = [i["id"] for i in invoices if i["status"] in ["Verified", "Needs Review"]]

    col_e1, col_e2 = st.columns([2, 1])
    with col_e1:
        st.write(f"• **Verified Invoices Ready for Export:** `{len(verified_invoices)}`")
        st.write(f"• **Total Processed Invoices:** `{len(invoices)}`")
        st.write(f"• **Educational Mode Clamp:** `{'Enabled (1st of month)' if safe_edu else 'Disabled (Original date)'}`")

    with col_e2:
        export_mode = st.radio("Export Target", ["Only Verified Invoices", "All Invoices (Inc. Needs Review)"])

    export_ids = [i["id"] for i in verified_invoices] if export_mode == "Only Verified Invoices" else all_eligible_ids

    st.markdown("---")

    if st.button("🚀 Export XML to `exports/import_ready.xml`", type="primary", use_container_width=True):
        if not export_ids:
            st.error("No invoices available for export based on your selection.")
        else:
            try:
                output_path = engine.EXPORTS_DIR / "import_ready.xml"
                result_path = engine.export_batch_to_tally_xml(export_ids, output_path=str(output_path), safe_edu=safe_edu)
                
                st.success(f"🎉 Tally XML Exported successfully to `{result_path}`!")
                
                with open(result_path, "r", encoding="utf-8") as xml_file:
                    xml_content = xml_file.read()

                st.download_button(
                    label="📥 Download Tally XML File (import_ready.xml)",
                    data=xml_content,
                    file_name="import_ready.xml",
                    mime="application/xml",
                    use_container_width=True
                )

                with st.expander("📄 Preview Generated Tally XML Document"):
                    st.code(xml_content, language="xml")
            except Exception as e:
                st.error(f"Export Error: {str(e)}")
