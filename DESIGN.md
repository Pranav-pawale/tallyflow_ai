# TallyFlow Precision Ledger Design System

Extracted design metadata from Stitch project **Tally AI Invoice Studio**.

---

## 🎨 Color Palette & Tokens

### Neutrals & Background Base
- **Canvas / Background**: `#F8FAFC` (Slate-50)
- **Surface**: `#FFFFFF`
- **Surface Low**: `#EFF4FF`
- **Surface Container**: `#E5EEFF`
- **Surface High**: `#DCE9FF`
- **Surface Highest**: `#D3E4FE`
- **On Surface (Primary Text)**: `#0B1C30` / `#0F172A`
- **On Surface Variant (Muted Text)**: `#45464D` / `#64748B`
- **Outline / Dividers**: `#76777D` / `#CBD5E1`
- **Outline Variant**: `#C6C6CD` / `#E2E8F0`

### Primary & Interactive Accents
- **Primary Action (Slate-900 / Deep Navy)**: `#0F172A` (Hover `#1E293B`)
- **Secondary Accent (Enterprise Sky Blue)**: `#0284C7` (Cyan highlight for active targets & processing feedback)

### Semantic Status Engine
- **Verified / Reconciled**: Emerald `#059669` text, `#ECFDF5` background, `#A7F3D0` border
- **Needs Review**: Amber `#D97706` text, `#FFFBEB` background, `#FDE68A` border
- **Math Error / GST Mismatch**: Rose `#E11D48` text, `#FFF1F2` background, `#FECDD3` border
- **Extracting / OCR Syncing**: Sky Blue `#0284C7` text, `#F0F9FF` background, `#BAE6FD` border

---

## 📐 Typography Hierarchy

1. **System Interface Core (`Geist`)**: Used for all headers, labels, buttons, navigation, and validation messages. Compact grotesque structure maintaining legibility at dense scales (12px - 14px).
2. **Financial Data & Currency (`JetBrains Mono`)**: Used for all numerical metrics, GSTIN codes, HSN/SAC classifications, voucher numbers, and Indian Rupee (`₹`) amounts with fixed tabular width (`tnum`).

| Token | Font Family | Size | Line Height | Weight | Letter Spacing |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `headline-lg` | Geist | 1.5rem (24px) | 2.0rem | 600 | normal |
| `headline-md` | Geist | 1.25rem (20px) | 1.75rem | 600 | normal |
| `headline-sm` | Geist | 1.125rem (18px) | 1.5rem | 600 | normal |
| `title-md` | Geist | 0.9375rem (15px) | 1.375rem | 600 | normal |
| `body-md` | Geist | 0.875rem (14px) | 1.25rem | 400 | normal |
| `body-sm` | Geist | 0.8125rem (13px) | 1.125rem | 400 | normal |
| `label-md` | Geist | 0.75rem (12px) | 1.0rem | 500 | 0.025em |
| `data-tabular` | JetBrains Mono | 0.8125rem (13px) | 1.125rem | 500 | normal |
| `currency-md` | JetBrains Mono | 0.875rem (14px) | 1.25rem | 600 | normal |
| `currency-lg` | JetBrains Mono | 1.25rem (20px) | 1.5rem | 700 | normal |

---

## 📏 Layout, Spacing & Geometry

- **Grid System**: 4px baseline grid (`xs`: 4px, `sm`: 6px, `md`: 12px, `lg`: 16px, `xl`: 24px).
- **Density**: Compact row padding (32px to 36px height) enabling high vertical data density for audit grids.
- **Shapes & Radius**: Crisp, low-radius geometric grammar (`sm`: 2px, `DEFAULT`: 4px, `md`: 6px). Avoids rounded-full pill buttons for controls.
- **Elevation**: Tonal borders (`1px solid #E2E8F0`) and hairline dividers rather than heavy blurred drop shadows.
