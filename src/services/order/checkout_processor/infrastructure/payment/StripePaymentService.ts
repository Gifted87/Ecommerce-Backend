import { Logger } from 'pino';
import Stripe = require('stripe');
import { IPaymentService } from '../../service/CheckoutProcessorService';

export class StripePaymentService implements IPaymentService {
  private readonly stripe: any;

  constructor(private readonly logger: Logger) {
    const secretKey = process.env.STRIPE_SECRET_KEY || '';
    if (!secretKey) {
      throw new Error('STRIPE_SECRET_KEY is required for StripePaymentService');
    }
    this.stripe = new Stripe(secretKey, {
      apiVersion: Stripe.API_VERSION,
    });
  }

  public async processPayment(token: string, amount: string, orderId: string, correlationId: string): Promise<{ transactionId: string }> {
    this.logger.info({ orderId, correlationId, amount }, 'Processing payment via Stripe Gateway');
    
    const amountInCents = Math.round(parseFloat(amount) * 100);

    const charge = await this.stripe.charges.create({
      amount: amountInCents,
      currency: 'usd',
      source: token,
      description: `Charge for order ${orderId}`,
      metadata: { orderId, correlationId }
    });
    
    this.logger.info({ orderId, transactionId: charge.id }, 'Stripe charge successful');
    
    return { transactionId: charge.id };
  }

  public async refundPayment(transactionId: string, orderId: string, correlationId: string): Promise<void> {
    this.logger.info({ transactionId, orderId, correlationId }, 'Processing refund via Stripe Gateway');
    
    await this.stripe.refunds.create({
      charge: transactionId,
      metadata: { orderId, correlationId }
    });
    
    this.logger.info({ transactionId, orderId }, 'Stripe refund successful');
  }
}
