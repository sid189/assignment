import type { Database } from "../store/Database.js";
import type { Product } from "../domain/types.js";
import { AppError } from "../errors/AppError.js";
import { clone } from "../store/clone.js";

export class ProductService {
  constructor(private readonly db: Database) {}

  list(): Product[] {
    return this.db.exec((t) => Array.from(t.products.values()).map(clone));
  }

  get(productId: string): Product {
    const product = this.db.exec((t) => t.products.get(productId));
    if (!product) {
      throw AppError.notFound("PRODUCT_NOT_FOUND", `Product ${productId} not found`);
    }
    return clone(product);
  }
}
