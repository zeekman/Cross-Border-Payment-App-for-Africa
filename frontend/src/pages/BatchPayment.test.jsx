// Jest globals (react-scripts test) provide describe/it/expect.

// Exercise the real shared validator, not a copy of it.
import { validateStellarAddress } from '../utils/validation';

// Checksum-valid fixtures (verified with StrKey.isValidEd25519PublicKey).
const VALID_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VALID_B = 'GD57YDCSJARQ2UV7HQANVPWXBWOB3REM6SOLBXXTGIZAXVFZR72OY5PH';
const VALID_C = 'GCI4JAYEWQ4NBWZMX3NDBYYGWHZQF5IKVHLZ5OWX4JNWAXR3C36A7KZ3';
// Same as VALID_B with the last character flipped: passes prefix/length
// checks but fails the CRC16 checksum.
const TYPO_B = 'GD57YDCSJARQ2UV7HQANVPWXBWOB3REM6SOLBXXTGIZAXVFZR72OY5PX';

function validateAmount(amount) {
  const SINGLE_TRANSFER_LIMIT = 10000;
  
  if (!amount && amount !== 0) {
    return 'Amount is required';
  }
  
  const numAmount = parseFloat(amount);
  
  if (isNaN(numAmount)) {
    return 'Amount must be a valid number';
  }
  
  if (numAmount <= 0) {
    return 'Amount must be a positive number';
  }
  
  if (numAmount > SINGLE_TRANSFER_LIMIT) {
    return `Amount exceeds single-transfer limit of ${SINGLE_TRANSFER_LIMIT.toLocaleString()} USDC`;
  }
  
  return null;
}

function validateRecipient(recipient, rowNumber) {
  const errors = [];
  
  const addressError = validateStellarAddress(recipient.recipient_address);
  if (addressError) {
    errors.push(addressError);
  }
  
  const amountError = validateAmount(recipient.amount);
  if (amountError) {
    errors.push(amountError);
  }
  
  if (errors.length > 0) {
    return {
      rowNumber,
      address: recipient.recipient_address,
      amount: recipient.amount,
      memo: recipient.memo || '',
      error: errors.join('; ')
    };
  }
  
  return null;
}

describe('BatchPayment Validation', () => {
  describe('validateStellarAddress', () => {
    it('should return null for valid Stellar address', () => {
      const validAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
      expect(validateStellarAddress(validAddress)).toBeNull();
    });

    it('should require address to be provided', () => {
      expect(validateStellarAddress('')).toBe('Address is required');
      expect(validateStellarAddress(null)).toBe('Address is required');
      expect(validateStellarAddress(undefined)).toBe('Address is required');
    });

    it('should reject non-checksummed addresses with a checksum error', () => {
      const invalidAddress = 'XABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOP';
      expect(validateStellarAddress(invalidAddress)).toBe(
        'Invalid Stellar address (checksum failed — check for typos)'
      );
    });

    it('should reject a single-character typo in an otherwise valid address', () => {
      // Passes the old prefix/length check but fails CRC16.
      expect(validateStellarAddress(TYPO_B)).toBe(
        'Invalid Stellar address (checksum failed — check for typos)'
      );
    });

    it('should reject short and long addresses via checksum', () => {
      expect(validateStellarAddress('GABCD')).toBe(
        'Invalid Stellar address (checksum failed — check for typos)'
      );
      expect(validateStellarAddress('G' + 'A'.repeat(60))).toBe(
        'Invalid Stellar address (checksum failed — check for typos)'
      );
    });

    it('should reject addresses with invalid characters', () => {
      const invalidAddress = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNO@';
      expect(validateStellarAddress(invalidAddress)).toBe(
        'Invalid Stellar address (checksum failed — check for typos)'
      );

      const lowercaseAddress = 'gabcdefghijklmnopqrstuvwxyz234567890abcdefghijklmnop';
      expect(validateStellarAddress(lowercaseAddress)).toBe(
        'Invalid Stellar address (checksum failed — check for typos)'
      );
    });

    it('should accept well-formed federation addresses', () => {
      expect(validateStellarAddress('alice*stellar.org')).toBeNull();
    });

    it('should reject malformed federation addresses', () => {
      expect(validateStellarAddress('*stellar.org')).toBe(
        'Invalid federation address (expected name*domain)'
      );
      expect(validateStellarAddress('alice*')).toBe(
        'Invalid federation address (expected name*domain)'
      );
      expect(validateStellarAddress('a*b*c')).toBe(
        'Invalid federation address (expected name*domain)'
      );
    });

    it('should reject muxed addresses as unsupported', () => {
      expect(
        validateStellarAddress('M' + 'A'.repeat(68))
      ).toBe('Muxed (M…) addresses are not supported yet');
    });

    it('should handle addresses with whitespace', () => {
      const addressWithSpaces = '  GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF  ';
      expect(validateStellarAddress(addressWithSpaces)).toBeNull();
    });
  });

  describe('validateAmount', () => {
    it('should return null for valid positive amounts', () => {
      expect(validateAmount('100')).toBeNull();
      expect(validateAmount('0.0000001')).toBeNull();
      expect(validateAmount('9999.99')).toBeNull();
      expect(validateAmount(100)).toBeNull();
    });

    it('should require amount to be provided', () => {
      expect(validateAmount('')).toBe('Amount is required');
      expect(validateAmount(null)).toBe('Amount is required');
      expect(validateAmount(undefined)).toBe('Amount is required');
    });

    it('should require amount to be a valid number', () => {
      expect(validateAmount('abc')).toBe('Amount must be a valid number');
      expect(validateAmount('not-a-number')).toBe('Amount must be a valid number');
      expect(validateAmount('NaN')).toBe('Amount must be a valid number');
    });

    it('should require amount to be positive', () => {
      expect(validateAmount('0')).toBe('Amount must be a positive number');
      expect(validateAmount('-100')).toBe('Amount must be a positive number');
      expect(validateAmount('-0.01')).toBe('Amount must be a positive number');
    });

    it('should enforce single-transfer limit', () => {
      expect(validateAmount('10001')).toBe('Amount exceeds single-transfer limit of 10,000 USDC');
      expect(validateAmount('50000')).toBe('Amount exceeds single-transfer limit of 10,000 USDC');
      expect(validateAmount('10000')).toBeNull(); // Exactly at limit should be valid
    });

    it('should handle string and numeric inputs', () => {
      expect(validateAmount('100.50')).toBeNull();
      expect(validateAmount(100.50)).toBeNull();
    });
  });

  describe('validateRecipient', () => {
    it('should return null for valid recipient', () => {
      const validRecipient = {
        recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        amount: '100.50',
        memo: 'Test'
      };
      expect(validateRecipient(validRecipient, 1)).toBeNull();
    });

    it('should return error for invalid address', () => {
      const recipient = {
        recipient_address: 'INVALID',
        amount: '100',
        memo: ''
      };
      const error = validateRecipient(recipient, 1);
      expect(error).not.toBeNull();
      expect(error.rowNumber).toBe(1);
      expect(error.address).toBe('INVALID');
      expect(error.error).toContain('Invalid Stellar address');
    });

    it('should return error for invalid amount', () => {
      const recipient = {
        recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        amount: '-50',
        memo: ''
      };
      const error = validateRecipient(recipient, 2);
      expect(error).not.toBeNull();
      expect(error.rowNumber).toBe(2);
      expect(error.error).toContain('Amount must be a positive number');
    });

    it('should return combined errors for multiple validation failures', () => {
      const recipient = {
        recipient_address: 'XSHORT',
        amount: 'invalid',
        memo: ''
      };
      const error = validateRecipient(recipient, 3);
      expect(error).not.toBeNull();
      expect(error.error).toContain('Invalid Stellar address');
      expect(error.error).toContain('Amount must be a valid number');
      expect(error.error).toContain(';'); // Multiple errors separated by semicolon
    });

    it('should include row number in error', () => {
      const recipient = {
        recipient_address: '',
        amount: '',
        memo: ''
      };
      const error = validateRecipient(recipient, 5);
      expect(error).not.toBeNull();
      expect(error.rowNumber).toBe(5);
    });

    it('should handle missing memo field', () => {
      const recipient = {
        recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        amount: '100'
      };
      const error = validateRecipient(recipient, 1);
      expect(error).toBeNull();
    });

    it('should validate amount at transfer limit boundary', () => {
      const recipientAtLimit = {
        recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        amount: '10000',
        memo: ''
      };
      expect(validateRecipient(recipientAtLimit, 1)).toBeNull();

      const recipientOverLimit = {
        recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        amount: '10000.01',
        memo: ''
      };
      const error = validateRecipient(recipientOverLimit, 1);
      expect(error).not.toBeNull();
      expect(error.error).toContain('exceeds single-transfer limit');
    });

    it('should preserve original values in error object', () => {
      const recipient = {
        recipient_address: 'BAD_ADDRESS',
        amount: 'xyz',
        memo: 'Test memo'
      };
      const error = validateRecipient(recipient, 10);
      expect(error.address).toBe('BAD_ADDRESS');
      expect(error.amount).toBe('xyz');
      expect(error.memo).toBe('Test memo');
    });
  });

  describe('CSV Parsing Edge Cases', () => {
    it('should handle empty values correctly', () => {
      const recipients = [
        { recipient_address: '', amount: '100' },
        { recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', amount: '' }
      ];

      recipients.forEach((recipient, index) => {
        const error = validateRecipient(recipient, index + 1);
        expect(error).not.toBeNull();
      });
    });

    it('should handle whitespace-only values', () => {
      const recipient = {
        recipient_address: '   ',
        amount: '  ',
        memo: ''
      };
      const error = validateRecipient(recipient, 1);
      expect(error).not.toBeNull();
    });

    it('should validate scientific notation amounts', () => {
      const recipient = {
        recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        amount: '1e3', // 1000 in scientific notation
        memo: ''
      };
      expect(validateRecipient(recipient, 1)).toBeNull();
    });

    it('should validate very small amounts', () => {
      const recipient = {
        recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        amount: '0.0000001',
        memo: ''
      };
      expect(validateRecipient(recipient, 1)).toBeNull();
    });

    it('should reject zero amount', () => {
      const recipient = {
        recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        amount: '0.0000000',
        memo: ''
      };
      const error = validateRecipient(recipient, 1);
      expect(error).not.toBeNull();
      expect(error.error).toContain('Amount must be a positive number');
    });
  });

  describe('Real-world Scenarios', () => {
    it('should validate typical payroll batch', () => {
      const payroll = [
        {
          recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          amount: '2500.00',
          memo: 'Salary March'
        },
        {
          recipient_address: 'GD57YDCSJARQ2UV7HQANVPWXBWOB3REM6SOLBXXTGIZAXVFZR72OY5PH',
          amount: '3000.50',
          memo: 'Salary March'
        },
        {
          recipient_address: 'GCI4JAYEWQ4NBWZMX3NDBYYGWHZQF5IKVHLZ5OWX4JNWAXR3C36A7KZ3',
          amount: '2750.75',
          memo: 'Salary March'
        }
      ];

      payroll.forEach((recipient, index) => {
        const error = validateRecipient(recipient, index + 1);
        expect(error).toBeNull();
      });
    });

    it('should identify mixed valid and invalid rows', () => {
      const batch = [
        {
          recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          amount: '100',
          memo: ''
        }, // Valid
        {
          recipient_address: 'INVALID',
          amount: '200',
          memo: ''
        }, // Invalid address
        {
          recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          amount: '-50',
          memo: ''
        }, // Invalid amount
        {
          recipient_address: 'GD57YDCSJARQ2UV7HQANVPWXBWOB3REM6SOLBXXTGIZAXVFZR72OY5PH',
          amount: '15000',
          memo: ''
        }, // Over limit
      ];

      const results = batch.map((recipient, index) => 
        validateRecipient(recipient, index + 1)
      );

      expect(results[0]).toBeNull();
      expect(results[1]).not.toBeNull();
      expect(results[2]).not.toBeNull();
      expect(results[3]).not.toBeNull();
    });

    it('should handle maximum valid amount', () => {
      const recipient = {
        recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        amount: '9999.9999999',
        memo: ''
      };
      expect(validateRecipient(recipient, 1)).toBeNull();
    });
  });
});
