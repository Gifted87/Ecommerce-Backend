export const redactOrderPII = (order: any): any => {
  return { ...order, customer_email: '[REDACTED]' };
};
