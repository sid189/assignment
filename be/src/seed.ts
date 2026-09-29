import type { Database } from "./store/Database.js";
import type { Product } from "./domain/types.js";

export const seedProducts: Product[] = [
  { id: "p-mug", name: "Ceramic Mug", unitPriceCents: 1299, availableInventory: 100 },
  { id: "p-notebook", name: "Dotted Notebook", unitPriceCents: 899, availableInventory: 200 },
  { id: "p-pen", name: "Fountain Pen", unitPriceCents: 2499, availableInventory: 50 },
  { id: "p-tote", name: "Canvas Tote Bag", unitPriceCents: 1899, availableInventory: 75 },
  // Deliberately scarce — this is the product concurrency tests race over.
  { id: "p-poster", name: "Limited Edition Poster", unitPriceCents: 3499, availableInventory: 3 },
];

export function seedDatabase(db: Database): void {
  db.exec((t) => {
    for (const product of seedProducts) {
      t.products.set(product.id, { ...product });
    }
  });
}
