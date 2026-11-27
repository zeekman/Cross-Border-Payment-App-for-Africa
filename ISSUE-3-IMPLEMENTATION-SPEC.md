# Issue 3: KYC Tier Display - Implementation Specification

## Overview
Show KYC tier (Basic/Enhanced/Business), limits unlocked, verification/expiry dates, and renewal warnings.

## Component Files to Modify
1. `frontend/src/pages/KYCVerification.jsx`
2. `frontend/src/components/profile/KycStatusCard.jsx`

## Backend API Requirements

Ensure `/api/kyc/status` returns:
```json
{
  "status": "verified" | "pending" | "rejected" | "unverified",
  "tier": "basic" | "enhanced" | "business",
  "verified_at": "2024-01-15T10:30:00Z",
  "expires_at": "2025-01-15T10:30:00Z",
  "rejection_reason": "Document unclear"
}
```

## UI Requirements

### 1. Show Current Tier with Badge
```jsx
<div className="flex items-center gap-2">
  <span>Tier: </span>
  <Badge color={tier === 'business' ? 'purple' : tier === 'enhanced' ? 'blue' : 'gray'}>
    {tier.charAt(0).toUpperCase() + tier.slice(1)}
  </Badge>
</div>
```

### 2. Show Limits This Tier Unlocks
Fetch from `/api/limits` or embed in /api/kyc/status response.
```jsx
<p>Your limits: Send up to $1,000/day, $5,000/month</p>
```

### 3. Show Verification and Expiry Dates
```jsx
<p>Verified: {new Date(verified_at).toLocaleDateString()}</p>
<p>Expires: {new Date(expires_at).toLocaleDateString()}</p>
```

### 4. Expiry Warning Banner (30 days before expiry)
```jsx
const daysUntilExpiry = Math.floor(
  (new Date(expires_at) - Date.now()) / (1000 * 60 * 60 * 24)
);

{daysUntilExpiry > 0 && daysUntilExpiry <= 30 && (
  <Alert variant="warning">
    Your KYC verification expires in {daysUntilExpiry} days.
    <Button onClick={reVerify}>Re-verify now</Button>
  </Alert>
)}
```

### 5. "Upgrade to Enhanced" Flow
Show requirements for next tier (Enhanced needs: proof of address, selfie).
```jsx
<Button onClick={() => navigate('/kyc?tier=enhanced')}>
  Upgrade to Enhanced
</Button>
```

### 6. Rejection Reason and Resubmit
```jsx
{status === 'rejected' && (
  <Alert variant="error">
    <p>Rejection reason: {rejection_reason}</p>
    <Button onClick={resubmit}>Resubmit Documents</Button>
  </Alert>
)}
```

## Component Tests

```javascript
it('renders tier, verification date and expiry date', () => {
  const mockData = {
    tier: 'enhanced',
    verified_at: '2024-01-15T10:00:00Z',
    expires_at: '2025-01-15T10:00:00Z'
  };
  render(<KycStatusCard data={mockData} />);
  expect(screen.getByText(/enhanced/i)).toBeInTheDocument();
  expect(screen.getByText(/verified.*jan/i)).toBeInTheDocument();
  expect(screen.getByText(/expires.*jan/i)).toBeInTheDocument();
});

it('shows expiry banner within 30 days', () => {
  const thirtyDaysFromNow = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000);
  const mockData = {
    tier: 'basic',
    expires_at: thirtyDaysFromNow.toISOString()
  };
  render(<KycStatusCard data={mockData} />);
  expect(screen.getByText(/expires in 29 days/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /re-verify/i })).toBeInTheDocument();
});

it('shows upgrade flow with requirements', () => {
  const mockData = { tier: 'basic', status: 'verified' };
  render(<KYCVerification data={mockData} />);
  fireEvent.click(screen.getByText(/upgrade to enhanced/i));
  expect(screen.getByText(/proof of address/i)).toBeInTheDocument();
  expect(screen.getByText(/selfie/i)).toBeInTheDocument();
});
```

## Acceptance Criteria
- ✅ Tier, verification date and expiry date render from API
- ✅ Expiry banner appears within 30 days of expiry (test with fixed clock)
- ✅ Upgrade flow lists requirements for next tier
- ✅ Component tests pass

## Estimated Effort
4-6 hours for an experienced React developer
