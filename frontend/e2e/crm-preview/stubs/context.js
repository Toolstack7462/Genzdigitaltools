export const useBusinessCrm = () => ({
  currency: 'PKR', has: () => true,
  bootstrap: { user: { id: 'preview-admin' }, settings: {} },
  queued: 0, setQueued: () => {},
});
export const BusinessCrmProvider = ({ children }) => children;
