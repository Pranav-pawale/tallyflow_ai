import React from 'react';

/**
 * Propagates updated invoice into dashboard state.
 */
export const handleUpdateInvoice = (setInvoices) => (updatedInvoice) => {
    setInvoices(prev => prev.map(inv => inv.id === updatedInvoice.id ? updatedInvoice : inv));
};

/**
 * Deletes selected invoices from the backend SQLite database and updates local React state upon success.
 */
export const deleteSelectedInvoices = async (selectedInvoices, setInvoices, setSelectedInvoices, getToken) => {
    if (!selectedInvoices || selectedInvoices.length === 0) return;
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (getToken) {
            const token = await getToken();
            if (token) headers['Authorization'] = `Bearer ${token}`;
        }
        const response = await fetch('/api/invoices', {
            method: 'DELETE',
            headers,
            body: JSON.stringify({ ids: selectedInvoices })
        });
        const result = await response.json();
        if (result.success) {
            // Only update React state if DB deletion was successful
            setInvoices(prev => prev.filter(inv => !selectedInvoices.includes(inv.id)));
            if (setSelectedInvoices) {
                setSelectedInvoices([]);
            }
        } else {
            console.error("Deletion failed:", result.error);
        }
        return result;
    } catch (err) {
        console.error("Error calling delete endpoint:", err);
    }
};

export default function InvoiceWorkbench(props) {
    return null;
}
