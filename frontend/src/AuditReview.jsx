import React from 'react';

/**
 * Ensures payload explicitly forces verification state to 'verified'.
 */
export const createApprovedPayload = (currentInvoice) => {
    return {
        ...currentInvoice,
        verificationState: 'verified',
        verification_state: 'verified'
    };
};

export default function AuditReview(props) {
    return null;
}
