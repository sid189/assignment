import type { Database } from "../store/Database.js";
import type { Order } from "../domain/types.js";
import { AppError } from "../errors/AppError.js";
import { clone } from "../store/clone.js";

export class OrderService {
  constructor(private readonly db: Database) {}

  getOrder(orderId: string): Order {
    const order = this.db.exec((t) => t.orders.get(orderId));
    if (!order) {
      throw AppError.notFound("ORDER_NOT_FOUND", `Order ${orderId} not found`);
    }
    return clone(order);
  }
}
