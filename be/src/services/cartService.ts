import { randomUUID } from "node:crypto";
import type { Database, Tables } from "../store/Database.js";
import type { Cart } from "../domain/types.js";
import { AppError } from "../errors/AppError.js";
import { clone } from "../store/clone.js";

export interface CartViewItem {
  productId: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface CartView extends Omit<Cart, "items"> {
  items: CartViewItem[];
  subtotalCents: number;
}

function requireOpenCart(t: Tables, cartId: string): Cart {
  const cart = t.carts.get(cartId);
  if (!cart) {
    throw AppError.notFound("CART_NOT_FOUND", `Cart ${cartId} not found`);
  }
  if (cart.status !== "open") {
    throw AppError.conflict("CART_ALREADY_CHECKED_OUT", `Cart ${cartId} has already been checked out`);
  }
  return cart;
}

function assertPositiveInteger(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw AppError.badRequest("VALIDATION_ERROR", "quantity must be a positive integer");
  }
}

export class CartService {
  constructor(private readonly db: Database) {}

  createCart(customerId: string): Cart {
    if (!customerId || !customerId.trim()) {
      throw AppError.badRequest("VALIDATION_ERROR", "customerId is required");
    }
    const cart: Cart = {
      id: randomUUID(),
      customerId,
      status: "open",
      items: [],
      createdAt: new Date().toISOString(),
    };
    this.db.exec((t) => t.carts.set(cart.id, cart));
    return clone(cart);
  }

  /** Live-priced view: prices/totals always reflect current product state, never a snapshot. */
  getCartView(cartId: string): CartView {
    return this.db.exec((t) => {
      const cart = t.carts.get(cartId);
      if (!cart) {
        throw AppError.notFound("CART_NOT_FOUND", `Cart ${cartId} not found`);
      }
      const items: CartViewItem[] = cart.items.map((item) => {
        const product = t.products.get(item.productId);
        const unitPriceCents = product?.unitPriceCents ?? 0;
        return {
          productId: item.productId,
          quantity: item.quantity,
          unitPriceCents,
          lineTotalCents: unitPriceCents * item.quantity,
        };
      });
      const subtotalCents = items.reduce((sum, i) => sum + i.lineTotalCents, 0);
      return clone({ ...cart, items, subtotalCents });
    });
  }

  addItem(cartId: string, productId: string, quantity: number): Cart {
    assertPositiveInteger(quantity);
    return this.db.exec((t) => {
      const cart = requireOpenCart(t, cartId);
      const product = t.products.get(productId);
      if (!product) {
        throw AppError.notFound("PRODUCT_NOT_FOUND", `Product ${productId} not found`);
      }
      const existing = cart.items.find((i) => i.productId === productId);
      const newQuantity = (existing?.quantity ?? 0) + quantity;
      if (newQuantity > product.availableInventory) {
        throw AppError.conflict(
          "INSUFFICIENT_INVENTORY",
          `Only ${product.availableInventory} units of '${product.name}' are available`,
          { productId, requested: newQuantity, available: product.availableInventory },
        );
      }
      if (existing) {
        existing.quantity = newQuantity;
      } else {
        cart.items.push({ productId, quantity });
      }
      return clone(cart);
    });
  }

  updateItemQuantity(cartId: string, productId: string, quantity: number): Cart {
    assertPositiveInteger(quantity);
    return this.db.exec((t) => {
      const cart = requireOpenCart(t, cartId);
      const item = cart.items.find((i) => i.productId === productId);
      if (!item) {
        throw AppError.notFound("ITEM_NOT_IN_CART", `Product ${productId} is not in cart ${cartId}`);
      }
      const product = t.products.get(productId);
      if (product && quantity > product.availableInventory) {
        throw AppError.conflict(
          "INSUFFICIENT_INVENTORY",
          `Only ${product.availableInventory} units of '${product.name}' are available`,
          { productId, requested: quantity, available: product.availableInventory },
        );
      }
      item.quantity = quantity;
      return clone(cart);
    });
  }

  removeItem(cartId: string, productId: string): Cart {
    return this.db.exec((t) => {
      const cart = requireOpenCart(t, cartId);
      const index = cart.items.findIndex((i) => i.productId === productId);
      if (index === -1) {
        throw AppError.notFound("ITEM_NOT_IN_CART", `Product ${productId} is not in cart ${cartId}`);
      }
      cart.items.splice(index, 1);
      return clone(cart);
    });
  }
}
